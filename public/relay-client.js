// CloudflareRelay Client Library
// Handles SFU connection, P2P relay tree, signature verification, sequencing.
// Application provides: onStateUpdate callback and input data.

(function (global) {
	"use strict";

	const STUN_SERVER = "stun:stun.cloudflare.com:3478";
	const SIG_SIZE = 64;
	const RELAY_POLL_MS = 500;
	const INPUT_HEARTBEAT_MS = 200;

	class RelayClient {
		/**
		 * @param {object} opts
		 * @param {string} [opts.configUrl="/api/config"]
		 * @param {number} [opts.inputRate=50]  - Input send rate (Hz)
		 */
		constructor(opts = {}) {
			this.configUrl = opts.configUrl || "/api/config";
			this.inputRate = opts.inputRate || 50;

			// State
			this.playerId = null;
			this.role = null; // 'relay' | 'leaf'
			this.config = null;
			this.numChannels = 3;
			this.sfuFallback = false;

			// SFU
			this._sfuPC = null;
			this._inputChannel = null;
			this._sfuStateChannels = [];

			// P2P (leaf)
			this._relayParentPCs = [];
			this._relayParentDCs = [];
			this._relayParentActive = [];

			// P2P (relay)
			this._relayChildPCs = []; // array of Maps
			this._relayPollTimer = null;

			// Signing
			this._signPublicKey = null;

			// Sequence
			this._lastSeq = -1;

			// Input
			this._lastSentInput = -1;
			this._lastSendTime = 0;

			// Callbacks
			this._onStateUpdate = null; // (payloadArrayBuffer) => void
			this._onConnected = null;
			this._getInput = null; // () => Uint8Array
			this._onRoleAssigned = null; // (role, playerId) => void
		}

		onStateUpdate(fn) { this._onStateUpdate = fn; }
		onConnected(fn) { this._onConnected = fn; }
		onRoleAssigned(fn) { this._onRoleAssigned = fn; }

		/** Set input provider: () => Uint8Array (called at inputRate Hz) */
		setInputProvider(fn) { this._getInput = fn; }

		/** Get relay stats for HUD */
		getRelayStats() {
			if (this.role === "relay") {
				const total = this._relayChildPCs.reduce((s, m) => s + m.size, 0);
				return { role: "relay", children: total };
			}
			const active = this._relayParentActive.filter(Boolean).length;
			return { role: "leaf", activeChannels: active, totalChannels: this.numChannels, sfuFallback: this.sfuFallback };
		}

		async connect() {
			// 1. Get config
			const config = await (await fetch(this.configUrl)).json();
			if (config.error) throw new Error(config.error);

			this.config = config;
			this.playerId = config.playerId;
			this.role = config.relay.role;
			this.numChannels = config.numChannels || 3;

			this._relayParentPCs = new Array(this.numChannels).fill(null);
			this._relayParentDCs = new Array(this.numChannels).fill(null);
			this._relayParentActive = new Array(this.numChannels).fill(false);
			this._relayChildPCs = Array.from({ length: this.numChannels }, () => new Map());

			if (this._onRoleAssigned) this._onRoleAssigned(this.role, this.playerId);

			// Import signing key
			if (config.signPublicKey) {
				try {
					const der = Uint8Array.from(atob(config.signPublicKey), (c) => c.charCodeAt(0));
					this._signPublicKey = await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
				} catch (e) { console.warn("Failed to import signing key:", e); }
			}

			// 2. Connect to SFU
			this._sfuPC = new RTCPeerConnection({
				iceServers: [{ urls: STUN_SERVER }],
				bundlePolicy: "max-bundle",
			});

			const bootstrapDC = this._sfuPC.createDataChannel("bootstrap");
			bootstrapDC.onopen = () => bootstrapDC.close();

			const offer = await this._sfuPC.createOffer();
			await this._sfuPC.setLocalDescription(offer);

			const sess = await this._callsAPI("/sessions/new", {
				sessionDescription: { type: "offer", sdp: offer.sdp },
			});
			if (sess.errorCode) throw new Error(sess.errorDescription);

			await this._sfuPC.setRemoteDescription(sess.sessionDescription);

			await new Promise((resolve, reject) => {
				const t = setTimeout(() => reject(new Error("Connection timeout")), 10000);
				if (this._sfuPC.connectionState === "connected") { clearTimeout(t); return resolve(); }
				this._sfuPC.onconnectionstatechange = () => {
					if (this._sfuPC.connectionState === "connected") { clearTimeout(t); resolve(); }
					else if (this._sfuPC.connectionState === "failed") { clearTimeout(t); reject(new Error("Failed")); }
				};
			});

			// 3. Input channel
			const inputResp = await this._callsAPI(
				`/sessions/${sess.sessionId}/datachannels/new`,
				{ dataChannels: [{ location: "local", dataChannelName: config.inputChannelName }] }
			);
			this._inputChannel = this._sfuPC.createDataChannel(config.inputChannelName, {
				negotiated: true, id: inputResp.dataChannels[0].id,
				ordered: false, maxRetransmits: 0,
			});
			this._inputChannel.binaryType = "arraybuffer";

			// 4. Subscribe to all SFU state channels
			const channelNames = Array.from({ length: this.numChannels }, (_, i) =>
				`game-state-${"abc"[i]}`
			);
			for (let ch = 0; ch < this.numChannels; ch++) {
				const stateResp = await this._callsAPI(
					`/sessions/${sess.sessionId}/datachannels/new`,
					{ dataChannels: [{ location: "remote", sessionId: config.bridgeSessionId, dataChannelName: channelNames[ch] }] }
				);
				const dc = this._sfuPC.createDataChannel(`${channelNames[ch]}-sub`, {
					negotiated: true, id: stateResp.dataChannels[0].id,
					ordered: false, maxRetransmits: 0,
				});
				dc.binaryType = "arraybuffer";
				const chIdx = ch;
				dc.onmessage = (evt) => this._handleSFUState(evt.data, chIdx);
				this._sfuStateChannels.push(dc);
			}
			if (this.role === "leaf") this.sfuFallback = true;

			// 5. P2P setup (leaf: create offers to relays)
			let p2pOffers = null;
			if (this.role === "leaf" && config.relay.relayParentIds) {
				p2pOffers = await this._setupLeafP2P(config.relay.relayParentIds);
			}

			// 6. Register
			await fetch("/api/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					playerId: this.playerId,
					sessionId: sess.sessionId,
					inputChannelName: config.inputChannelName,
					p2pOffer: p2pOffers,
					capabilities: this._detectCapabilities(),
				}),
			});

			// 7. Post-register: leaf polls for answers, relay polls for children
			if (this.role === "leaf" && p2pOffers && p2pOffers.length > 0) {
				this._pollForRelayAnswers();
			}
			if (this.role === "relay") {
				this._relayPollTimer = setInterval(() => this._pollForChildren(), RELAY_POLL_MS);
			}

			// 8. Start input loop
			if (this._getInput) {
				setInterval(() => this._sendInput(), 1000 / this.inputRate);
			}

			if (this._onConnected) this._onConnected(this.playerId, this.role);

			// Cleanup on page unload
			addEventListener("beforeunload", () => {
				navigator.sendBeacon("/api/leave", JSON.stringify({ playerId: this.playerId }));
			});
		}

		// --- Internal: Calls API proxy ---
		async _callsAPI(path, body) {
			const opts = { method: "POST", headers: { "Content-Type": "application/json" } };
			if (body) opts.body = JSON.stringify(body);
			else delete opts.headers["Content-Type"];
			return (await fetch(`/api/calls${path}`, opts)).json();
		}

		// --- Internal: SFU state handling ---
		_handleSFUState(data, channelIdx) {
			if (this.role === "relay") {
				// Forward to P2P children for this channel
				for (const [, { dc }] of this._relayChildPCs[channelIdx]) {
					if (dc && dc.readyState === "open") {
						try { dc.send(data); } catch (e) {}
					}
				}
				this._processPacket(data, false);
			} else if (this.sfuFallback || !this._relayParentActive[channelIdx]) {
				this._processPacket(data, false);
			}
		}

		// --- Internal: Packet verification + sequencing ---
		async _processPacket(data, needsVerify) {
			const buf = data instanceof ArrayBuffer ? data : data.buffer || data;
			if (buf.byteLength <= SIG_SIZE + 5) return;

			if (needsVerify && this._signPublicKey) {
				const payload = buf.slice(0, buf.byteLength - SIG_SIZE);
				const sig = buf.slice(buf.byteLength - SIG_SIZE);
				const valid = await crypto.subtle.verify("Ed25519", this._signPublicKey, sig, payload);
				if (!valid) { console.warn("Dropped: invalid signature"); return; }
			}

			const view = new DataView(buf);
			const type = view.getUint8(0);
			const seq = view.getUint8(1);

			if (type === 0) {
				this._lastSeq = seq;
			} else {
				const diff = (seq - this._lastSeq + 256) % 256;
				if (diff === 0 || diff > 128) return;
				this._lastSeq = seq;
			}

			const payloadLen = buf.byteLength - SIG_SIZE;
			if (this._onStateUpdate) this._onStateUpdate(buf.slice(0, payloadLen));
		}

		// --- Internal: Input ---
		_sendInput() {
			if (!this._inputChannel || this._inputChannel.readyState !== "open" || !this._getInput) return;
			const data = this._getInput();
			if (!data) return;
			const now = performance.now();
			const val = data[0]; // Compare first byte for heartbeat logic
			if (val !== this._lastSentInput || (now - this._lastSendTime) >= INPUT_HEARTBEAT_MS) {
				this._inputChannel.send(data);
				this._lastSentInput = val;
				this._lastSendTime = now;
			}
		}

		// --- Internal: Leaf P2P setup ---
		async _setupLeafP2P(relayParentIds) {
			const offers = [];
			for (let ch = 0; ch < this.numChannels; ch++) {
				const relayId = relayParentIds[ch];
				if (!relayId) continue;

				const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVER }] });
				const chIdx = ch;

				pc.onconnectionstatechange = () => {
					if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
						this._relayParentActive[chIdx] = false;
					}
				};

				const dc = pc.createDataChannel(`relay-state-${ch}`, { ordered: false, maxRetransmits: 0 });
				dc.binaryType = "arraybuffer";
				dc.onopen = () => {
					this._relayParentActive[chIdx] = true;
					if (this._relayParentActive.every(Boolean)) this.sfuFallback = false;
				};
				dc.onmessage = (evt) => this._processPacket(evt.data, true);

				pc.ondatachannel = (evt) => {
					const incoming = evt.channel;
					incoming.binaryType = "arraybuffer";
					incoming.onopen = () => {
						this._relayParentActive[chIdx] = true;
						this._relayParentDCs[chIdx] = incoming;
						if (this._relayParentActive.every(Boolean)) this.sfuFallback = false;
					};
					incoming.onmessage = (evt) => this._processPacket(evt.data, true);
				};

				const offerDesc = await pc.createOffer();
				await pc.setLocalDescription(offerDesc);
				await new Promise((resolve) => {
					if (pc.iceGatheringState === "complete") return resolve();
					pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") resolve(); };
				});

				this._relayParentPCs[ch] = pc;
				this._relayParentDCs[ch] = dc;
				offers.push({ channel: ch, relayId, sdp: pc.localDescription.sdp });
			}
			return offers;
		}

		async _pollForRelayAnswers() {
			const pending = new Set();
			for (let ch = 0; ch < this.numChannels; ch++) {
				if (this._relayParentPCs[ch]) pending.add(ch);
			}
			for (let i = 0; i < 20 && pending.size > 0; i++) {
				try {
					const resp = await (await fetch(`/api/relay-answer/${this.playerId}`)).json();
					for (const { channel, sdp } of resp.answers || []) {
						if (this._relayParentPCs[channel]) {
							await this._relayParentPCs[channel].setRemoteDescription({ type: "answer", sdp });
							pending.delete(channel);
						}
					}
				} catch (e) {}
				if (pending.size > 0) await new Promise((r) => setTimeout(r, RELAY_POLL_MS));
			}
		}

		// --- Internal: Relay child management ---
		async _pollForChildren() {
			try {
				const resp = await (await fetch(`/api/relay-pending?relayId=${this.playerId}`)).json();
				for (const { childId, channel, sdp } of resp.offers) {
					await this._acceptChild(childId, channel, sdp);
				}
			} catch (e) {}
		}

		async _acceptChild(childId, channel, offerSdp) {
			const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVER }] });
			pc.onconnectionstatechange = () => {
				if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
					this._relayChildPCs[channel].delete(childId);
					pc.close();
				}
			};

			const dc = pc.createDataChannel(`relay-state-${channel}`, { ordered: false, maxRetransmits: 0 });
			dc.binaryType = "arraybuffer";

			await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			await new Promise((resolve) => {
				if (pc.iceGatheringState === "complete") return resolve();
				pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") resolve(); };
			});

			await fetch("/api/relay-answer", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ childId, channel, answer: pc.localDescription.sdp }),
			});

			this._relayChildPCs[channel].set(childId, { pc, dc });
		}

		_detectCapabilities() {
			const caps = {
				isMobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
				rttMs: 999, uplinkMbps: 0, connectionType: "unknown",
			};
			const conn = navigator.connection || navigator.mozConnection;
			if (conn) {
				caps.connectionType = conn.type || conn.effectiveType || "unknown";
				if (conn.downlink) caps.uplinkMbps = conn.downlink;
				if (conn.rtt) caps.rttMs = conn.rtt;
			}
			return caps;
		}
	}

	// Export
	if (typeof module !== "undefined" && module.exports) {
		module.exports = { RelayClient };
	} else {
		global.CloudflareRelay = { Client: RelayClient };
	}
})(typeof globalThis !== "undefined" ? globalThis : this);
