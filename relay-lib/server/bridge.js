const nodeDataChannel = require("node-datachannel");

const STUN_SERVER = "stun:stun.cloudflare.com:3478";

class Bridge {
	constructor(callsApi, appToken) {
		this.callsApi = callsApi;
		this.appToken = appToken;
		this.sessionId = null;
		this.pc = null;
		// 3 state channels: A, B, C (5hz each, staggered = 15hz total)
		this.stateChannels = [null, null, null];
		this.stateChannelNames = ["game-state-a", "game-state-b", "game-state-c"];
		// playerId -> { channelId, dataChannel }
		this.playerInputChannels = new Map();
		// playerId -> input state
		this.playerInputs = new Map();
		// playerId -> timestamp of last received input
		this.playerLastInput = new Map();
	}

	async init() {
		// Create the bridge's PeerConnection
		this.pc = new nodeDataChannel.PeerConnection("bridge", {
			iceServers: [STUN_SERVER],
		});

		this.pc.onStateChange((state) => {
			console.log(`Bridge PC state: ${state}`);
		});

		// Set up offer promise BEFORE creating data channel (triggers SDP generation)
		const offerPromise = new Promise((resolve) => {
			this.pc.onLocalDescription((sdp, type) => {
				console.log(`Local description ready (type: ${type}, len: ${sdp.length})`);
				resolve(sdp);
			});
		});

		// Create a bootstrap data channel to generate a valid SDP offer
		const bootstrapDC = this.pc.createDataChannel("bootstrap");

		// Wait for offer SDP
		const offerSdp = await offerPromise;

		// Create session on SFU with our offer — get answer back in one call
		const sessionResp = await this._callsAPI("/sessions/new", {
			sessionDescription: {
				type: "offer",
				sdp: offerSdp,
			},
		});

		this.sessionId = sessionResp.sessionId;
		const answerSdp = sessionResp.sessionDescription.sdp;
		const answerType = sessionResp.sessionDescription.type;

		console.log(`Bridge session: ${this.sessionId}`);
		console.log(`Got ${answerType} from SFU`);

		// Apply the SFU's answer
		this.pc.setRemoteDescription(answerSdp, answerType);

		// Wait for connection
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Bridge connection timeout")), 15000);
			this.pc.onStateChange((state) => {
				if (state === "connected") {
					clearTimeout(timeout);
					resolve();
				} else if (state === "failed" || state === "closed") {
					clearTimeout(timeout);
					reject(new Error(`Bridge connection ${state}`));
				}
			});
			// Check if already connected
			// node-datachannel state might already be connected after setRemoteDescription
		});

		console.log("Bridge WebRTC connected!");

		// Close bootstrap channel
		bootstrapDC.onOpen(() => {
			console.log("Bootstrap channel open, closing it");
			bootstrapDC.close();
		});

		// Create 3 state channels (A, B, C) for redundant relay paths
		for (let i = 0; i < 3; i++) {
			const name = this.stateChannelNames[i];
			const resp = await this._callsAPI(
				`/sessions/${this.sessionId}/datachannels/new`,
				{ dataChannels: [{ location: "local", dataChannelName: name }] }
			);
			const channelId = resp.dataChannels[0].id;
			console.log(`${name} channel ID: ${channelId}`);

			this.stateChannels[i] = this.pc.createDataChannel(name, {
				negotiated: true,
				id: channelId,
			});
			this.stateChannels[i].onOpen(() => console.log(`${name} open`));
			this.stateChannels[i].onError((err) => console.error(`${name} error:`, err));
		}

		// Handle unexpected incoming data channels
		this.pc.onDataChannel((dc) => {
			console.log(`Bridge received unexpected data channel: ${dc.getLabel()}`);
			this._handleIncomingChannel(dc);
		});
	}

	async subscribeToPlayerInput(playerSessionId, inputChannelName, playerId) {
		// Subscribe bridge's session to the player's input data channel
		const subResp = await this._callsAPI(
			`/sessions/${this.sessionId}/datachannels/new`,
			{
				dataChannels: [
					{
						location: "remote",
						sessionId: playerSessionId,
						dataChannelName: inputChannelName,
					},
				],
			}
		);

		const channelId = subResp.dataChannels[0].id;
		console.log(`Subscribed to player ${playerId} input, channel ID: ${channelId}`);

		// Create negotiated channel on bridge PC to receive player input
		const dc = this.pc.createDataChannel(`${inputChannelName}-sub`, {
			negotiated: true,
			id: channelId,
			ordered: false,
			maxRetransmits: 0,
		});

		dc.onOpen(() => {
			console.log(`Input channel for player ${playerId} open`);
		});

		dc.onMessage((msg) => {
			this._processInput(playerId, msg);
		});

		dc.onError((err) => {
			console.error(`Input channel error (player ${playerId}):`, err);
		});

		this.playerInputChannels.set(playerId, { channelId, dataChannel: dc });

		return subResp;
	}

	unsubscribePlayer(playerId) {
		const entry = this.playerInputChannels.get(playerId);
		if (entry) {
			try {
				entry.dataChannel.close();
			} catch (e) {}
			this.playerInputChannels.delete(playerId);
		}
		this.playerInputs.delete(playerId);
		this.playerLastInput.delete(playerId);
	}

	// Send state on a specific channel (0, 1, or 2)
	broadcastState(buffer, channelIndex) {
		const ch = this.stateChannels[channelIndex];
		if (ch) {
			try {
				ch.sendMessageBinary(buffer);
				return true;
			} catch (e) {
				return false;
			}
		}
		return false;
	}

	getInput(playerId) {
		return this.playerInputs.get(playerId) || 0;
	}

	getLastInputTime(playerId) {
		return this.playerLastInput.get(playerId) || 0;
	}

	_processInput(playerId, msg) {
		// Input is a single byte: bit flags for keys
		// bit 0: left, bit 1: right, bit 2: jump
		if (Buffer.isBuffer(msg)) {
			this.playerInputs.set(playerId, msg[0]);
		} else if (typeof msg === "string") {
			this.playerInputs.set(playerId, msg.charCodeAt(0));
		}
		this.playerLastInput.set(playerId, Date.now());
	}

	_handleIncomingChannel(dc) {
		const label = dc.getLabel();
		dc.onMessage((msg) => {
			const match = label.match(/input-(\d+)/);
			if (match) {
				this._processInput(parseInt(match[1]), msg);
			}
		});
	}

	async _callsAPI(path, body, method = "POST") {
		const opts = {
			method,
			headers: {
				Authorization: `Bearer ${this.appToken}`,
			},
		};
		if (body !== undefined && body !== null) {
			opts.headers["Content-Type"] = "application/json";
			opts.body = JSON.stringify(body);
		}
		const resp = await fetch(`${this.callsApi}${path}`, opts);
		const data = await resp.json();
		if (data.errorCode) {
			throw new Error(`Calls API error on ${path}: ${data.errorDescription}`);
		}
		return data;
	}
}

module.exports = { Bridge };
