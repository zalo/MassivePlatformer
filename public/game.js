// --- Constants ---
const INPUT_LEFT = 1;
const INPUT_RIGHT = 2;
const INPUT_JUMP = 4;
const PLAYER_RADIUS = 12;
const INPUT_SEND_RATE = 50;
const INPUT_HEARTBEAT_MS = 200;
const STUN_SERVER = "stun:stun.cloudflare.com:3478";
const RELAY_POLL_MS = 500; // How often relays poll for new children

// --- State ---
let myPlayerId = null;
let myRole = null;
let map = null;
let inputChannel = null;
let stateChannel = null;
let lastSentInput = -1;
let lastSendTime = 0;

// P2P relay state
let relayParentPC = null;
let relayParentDC = null;
let relayChildPCs = new Map();
let relayPollTimer = null;
let sfuFallback = false;

// Signature verification
let signPublicKey = null; // CryptoKey for Ed25519 verify
const SIG_SIZE = 64;

// Sequence tracking: discard stale deltas
let lastSeq = -1; // -1 = no packets received yet
let lastFullSeq = -1; // seq of the most recent full snapshot

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");

function resize() { canvas.width = innerWidth; canvas.height = innerHeight; }
addEventListener("resize", resize);
resize();

// --- Input ---
const keys = {};
addEventListener("keydown", (e) => { keys[e.code] = true; if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"].includes(e.code)) e.preventDefault(); });
addEventListener("keyup", (e) => { keys[e.code] = false; });

const touch = { left: false, right: false, jump: false };
function setupTouchButton(id, field) {
	const btn = document.getElementById(id);
	if (!btn) return;
	function activate(e) { e.preventDefault(); touch[field] = true; btn.classList.add("active"); }
	function deactivate(e) { e.preventDefault(); touch[field] = false; btn.classList.remove("active"); }
	btn.addEventListener("touchstart", activate, { passive: false });
	btn.addEventListener("touchend", deactivate, { passive: false });
	btn.addEventListener("touchcancel", deactivate, { passive: false });
	btn.addEventListener("touchmove", (e) => {
		e.preventDefault();
		const t = e.changedTouches[0];
		const rect = btn.getBoundingClientRect();
		const inside = t.clientX >= rect.left && t.clientX <= rect.right && t.clientY >= rect.top && t.clientY <= rect.bottom;
		touch[field] = inside; btn.classList.toggle("active", inside);
	}, { passive: false });
}
setupTouchButton("btn-left", "left");
setupTouchButton("btn-right", "right");
setupTouchButton("btn-up", "jump");
setupTouchButton("btn-jump", "jump");
addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("touchstart", (e) => { if (e.target === canvas) e.preventDefault(); }, { passive: false });

function readInput() {
	let s = 0;
	if (keys.ArrowLeft || keys.KeyA || touch.left) s |= INPUT_LEFT;
	if (keys.ArrowRight || keys.KeyD || touch.right) s |= INPUT_RIGHT;
	if (keys.ArrowUp || keys.KeyW || keys.Space || touch.jump) s |= INPUT_JUMP;
	return s;
}

// --- Signature verification ---
async function importSigningKey(base64Der) {
	const der = Uint8Array.from(atob(base64Der), (c) => c.charCodeAt(0));
	return crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
}

async function verifyPacket(data) {
	if (!signPublicKey) return true; // No key = skip verification (shouldn't happen)
	if (data.byteLength <= SIG_SIZE) return false;
	const payload = data.slice(0, data.byteLength - SIG_SIZE);
	const sig = data.slice(data.byteLength - SIG_SIZE);
	return crypto.subtle.verify("Ed25519", signPublicKey, sig, payload);
}

// --- Client capability detection ---
function detectCapabilities() {
	const caps = {
		isMobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
		rttMs: 999,
		uplinkMbps: 0,
		connectionType: "unknown",
	};

	// Network Information API (Chrome/Android)
	const conn = navigator.connection || navigator.mozConnection;
	if (conn) {
		caps.connectionType = conn.type || conn.effectiveType || "unknown";
		if (conn.downlink) caps.uplinkMbps = conn.downlink; // Rough estimate
		if (conn.rtt) caps.rttMs = conn.rtt;
	}

	return caps;
}

// --- Calls API proxy ---
async function callsAPI(path, body) {
	const opts = { method: "POST", headers: { "Content-Type": "application/json" } };
	if (body) opts.body = JSON.stringify(body);
	else delete opts.headers["Content-Type"];
	return (await fetch(`/api/calls${path}`, opts)).json();
}

// --- Join flow ---
async function join() {
	statusEl.textContent = "Getting config...";

	const config = await (await fetch("/api/config")).json();
	if (config.error) throw new Error(config.error);

	myPlayerId = config.playerId;
	map = config.map;
	myRole = config.relay.role;
	const { bridgeSessionId, inputChannelName } = config;

	// Import signing public key for packet verification
	if (config.signPublicKey) {
		try {
			signPublicKey = await importSigningKey(config.signPublicKey);
			console.log("Signing key imported for packet verification");
		} catch (e) {
			console.warn("Failed to import signing key:", e);
		}
	}

	statusEl.textContent = `Connecting (${myRole})...`;

	// --- SFU connection (same for relay and leaf) ---
	const pc = new RTCPeerConnection({
		iceServers: [{ urls: STUN_SERVER }],
		bundlePolicy: "max-bundle",
	});
	pc.onconnectionstatechange = () => console.log("SFU PC:", pc.connectionState);

	const bootstrapDC = pc.createDataChannel("bootstrap");
	bootstrapDC.onopen = () => bootstrapDC.close();

	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);

	const sess = await callsAPI("/sessions/new", {
		sessionDescription: { type: "offer", sdp: offer.sdp },
	});
	if (sess.errorCode) throw new Error(sess.errorDescription);

	await pc.setRemoteDescription(sess.sessionDescription);

	await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("Connection timeout")), 10000);
		if (pc.connectionState === "connected") { clearTimeout(t); return resolve(); }
		pc.onconnectionstatechange = () => {
			if (pc.connectionState === "connected") { clearTimeout(t); resolve(); }
			else if (pc.connectionState === "failed") { clearTimeout(t); reject(new Error("Failed")); }
		};
	});

	console.log("SFU connected, setting up channels...");

	// Input channel (all players publish input via SFU)
	const inputResp = await callsAPI(
		`/sessions/${sess.sessionId}/datachannels/new`,
		{ dataChannels: [{ location: "local", dataChannelName: inputChannelName }] }
	);
	inputChannel = pc.createDataChannel(inputChannelName, {
		negotiated: true, id: inputResp.dataChannels[0].id,
		ordered: false, maxRetransmits: 0,
	});
	inputChannel.binaryType = "arraybuffer";
	inputChannel.onopen = () => console.log("Input channel open");

	// Game state channel via SFU
	// Relay: always subscribes (source of truth, forwards to children)
	// Leaf: subscribes as fallback (used until P2P relay connects)
	if (myRole === "relay" || myRole === "leaf") {
		const stateResp = await callsAPI(
			`/sessions/${sess.sessionId}/datachannels/new`,
			{ dataChannels: [{ location: "remote", sessionId: bridgeSessionId, dataChannelName: "game-state" }] }
		);
		stateChannel = pc.createDataChannel("game-state-sub", {
			negotiated: true, id: stateResp.dataChannels[0].id,
			ordered: false, maxRetransmits: 0,
		});
		stateChannel.binaryType = "arraybuffer";
		stateChannel.onopen = () => console.log("SFU state channel open");
		stateChannel.onmessage = (evt) => handleSFUState(evt.data);

		if (myRole === "leaf") {
			sfuFallback = true; // Use SFU until P2P relay connects
		}
	}

	// --- P2P offer for leaf nodes ---
	let p2pOffer = null;
	if (myRole === "leaf" && config.relay.relayParentId) {
		// Create P2P PeerConnection to relay parent
		relayParentPC = new RTCPeerConnection({
			iceServers: [{ urls: STUN_SERVER }],
		});
		relayParentPC.onconnectionstatechange = () => {
			console.log("Relay P2P:", relayParentPC.connectionState);
			if (relayParentPC.connectionState === "failed" || relayParentPC.connectionState === "disconnected") {
				console.log("Relay P2P lost, falling back to SFU");
				sfuFallback = true;
			}
		};

		// Create the data channel that relay will send state on
		relayParentDC = relayParentPC.createDataChannel("relay-state", {
			ordered: false, maxRetransmits: 0,
		});
		relayParentDC.binaryType = "arraybuffer";
		relayParentDC.onopen = () => {
			console.log("P2P relay channel open — switching off SFU fallback");
			sfuFallback = false;
		};
		relayParentDC.onmessage = (evt) => processStatePacket(evt.data, true);

		// Also listen for incoming data channels (relay creates the channel)
		relayParentPC.ondatachannel = (evt) => {
			console.log("P2P incoming channel:", evt.channel.label);
			const dc = evt.channel;
			dc.binaryType = "arraybuffer";
			dc.onopen = () => {
				console.log("P2P relay channel open (incoming) — switching off SFU fallback");
				sfuFallback = false;
				relayParentDC = dc;
			};
			dc.onmessage = (evt) => processStatePacket(evt.data, true);
		};

		const p2pOfferDesc = await relayParentPC.createOffer();
		await relayParentPC.setLocalDescription(p2pOfferDesc);

		// Wait for ICE gathering
		await new Promise((resolve) => {
			if (relayParentPC.iceGatheringState === "complete") return resolve();
			relayParentPC.onicegatheringstatechange = () => {
				if (relayParentPC.iceGatheringState === "complete") resolve();
			};
		});

		p2pOffer = relayParentPC.localDescription.sdp;
	}

	// --- Register with game server (include capabilities for relay scoring) ---
	await fetch("/api/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			playerId: myPlayerId,
			sessionId: sess.sessionId,
			inputChannelName,
			p2pOffer,
			capabilities: detectCapabilities(),
		}),
	});

	// --- Leaf: poll for P2P answer from relay ---
	if (myRole === "leaf" && p2pOffer) {
		pollForRelayAnswer();
	}

	// --- Relay: poll for new children ---
	if (myRole === "relay") {
		relayPollTimer = setInterval(pollForChildren, RELAY_POLL_MS);
	}

	const roleLabel = myRole === "relay" ? "RELAY" : "LEAF";
	statusEl.textContent = `Player ${myPlayerId} [${roleLabel}]`;
	setInterval(sendInput, 1000 / INPUT_SEND_RATE);

	addEventListener("beforeunload", () => {
		navigator.sendBeacon("/api/leave", JSON.stringify({ playerId: myPlayerId }));
	});
}

// --- SFU state handler: relay forwards, leaf uses as fallback ---
function handleSFUState(data) {
	if (myRole === "relay") {
		// Forward raw bytes to all P2P children (including signature)
		for (const [childId, { dc }] of relayChildPCs) {
			if (dc && dc.readyState === "open") {
				try { dc.send(data); } catch (e) {}
			}
		}
		// Apply locally (relay trusts SFU data, skip verification for self)
		processStatePacket(data, false);
	} else if (sfuFallback) {
		processStatePacket(data, false); // Direct from SFU = trusted
	}
}

// --- Relay: poll for pending child offers ---
async function pollForChildren() {
	try {
		const resp = await (await fetch(`/api/relay-pending?relayId=${myPlayerId}`)).json();
		for (const { childId, sdp } of resp.offers) {
			console.log(`Relay: new child ${childId}, creating P2P answer`);
			await acceptChild(childId, sdp);
		}
	} catch (e) {
		console.error("Relay poll error:", e);
	}
}

// --- Relay: accept a child's P2P offer ---
async function acceptChild(childId, offerSdp) {
	const childPC = new RTCPeerConnection({
		iceServers: [{ urls: STUN_SERVER }],
	});

	childPC.onconnectionstatechange = () => {
		console.log(`Relay->Child ${childId} PC:`, childPC.connectionState);
		if (childPC.connectionState === "failed" || childPC.connectionState === "disconnected") {
			relayChildPCs.delete(childId);
			childPC.close();
		}
	};

	// Create data channel for sending state to child
	const dc = childPC.createDataChannel("relay-state", {
		ordered: false, maxRetransmits: 0,
	});
	dc.binaryType = "arraybuffer";
	dc.onopen = () => console.log(`Relay: P2P channel to child ${childId} open`);

	await childPC.setRemoteDescription({ type: "offer", sdp: offerSdp });
	const answer = await childPC.createAnswer();
	await childPC.setLocalDescription(answer);

	// Wait for ICE gathering
	await new Promise((resolve) => {
		if (childPC.iceGatheringState === "complete") return resolve();
		childPC.onicegatheringstatechange = () => {
			if (childPC.iceGatheringState === "complete") resolve();
		};
	});

	// Send answer to server
	await fetch("/api/relay-answer", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			childId,
			answer: childPC.localDescription.sdp,
		}),
	});

	relayChildPCs.set(childId, { pc: childPC, dc });
}

// --- Leaf: poll for P2P answer from relay ---
async function pollForRelayAnswer() {
	for (let i = 0; i < 20; i++) { // Try for 10 seconds
		try {
			const resp = await (await fetch(`/api/relay-answer/${myPlayerId}`)).json();
			if (resp.answer) {
				console.log("Got P2P answer from relay");
				await relayParentPC.setRemoteDescription({ type: "answer", sdp: resp.answer });
				return;
			}
		} catch (e) {}
		await new Promise((r) => setTimeout(r, RELAY_POLL_MS));
	}
	console.log("No P2P answer received — staying on SFU fallback");
}

// --- Input send ---
function sendInput() {
	if (!inputChannel || inputChannel.readyState !== "open") return;
	const s = readInput();
	const now = performance.now();
	if (s !== lastSentInput || (now - lastSendTime) >= INPUT_HEARTBEAT_MS) {
		inputChannel.send(new Uint8Array([s]));
		lastSentInput = s;
		lastSendTime = now;
	}
}

// --- Packet processing: verify signature, check sequence, parse state ---
async function processStatePacket(data, needsVerification) {
	const buf = data instanceof ArrayBuffer ? data : data.buffer || data;
	if (buf.byteLength <= SIG_SIZE + 4) return; // Too small

	// Verify signature if data came via P2P relay (untrusted)
	if (needsVerification && signPublicKey) {
		const valid = await verifyPacket(buf);
		if (!valid) {
			console.warn("Dropped packet: invalid signature");
			return;
		}
	}

	// Parse header: [type:u8, seq:u8, count:u16]
	const view = new DataView(buf);
	const type = view.getUint8(0);
	const seq = view.getUint8(1);

	if (type === 0) {
		// Full snapshot: reset sequence tracking
		lastFullSeq = seq;
		lastSeq = seq;
	} else {
		// Delta: discard if stale (seq <= lastSeq, accounting for wrap)
		// Sequence is 0-255, reset on each full snapshot.
		// A delta is stale if its seq is <= lastSeq (within half the range).
		const diff = (seq - lastSeq + 256) % 256;
		if (diff === 0 || diff > 128) {
			// seq is same or older than lastSeq — drop
			return;
		}
		lastSeq = seq;
	}

	// Strip signature for parsing (payload is everything before sig)
	const payloadLen = buf.byteLength - SIG_SIZE;
	handleStateUpdate(buf.slice(0, payloadLen));
}

// --- Player state ---
const playerMap = new Map();

function handleStateUpdate(data) {
	const buf = new DataView(data instanceof ArrayBuffer ? data : data.buffer || data);
	// Header: [type:u8, seq:u8, count:u16] = 4 bytes
	const type = buf.getUint8(0);
	// seq already handled by processStatePacket
	const count = buf.getUint16(2, true);
	const PS = 11;
	const HEADER = 4;

	if (type === 0) {
		const seen = new Set();
		for (let i = 0; i < count; i++) {
			const o = HEADER + i * PS;
			const id = buf.getUint16(o, true);
			const flags = buf.getUint8(o + 10);
			if (flags & 2) { playerMap.delete(id); continue; }
			playerMap.set(id, {
				id,
				x: buf.getFloat32(o + 2, true),
				y: buf.getFloat32(o + 6, true),
				grounded: (flags & 1) === 1,
			});
			seen.add(id);
		}
		for (const [id] of playerMap) {
			if (!seen.has(id)) playerMap.delete(id);
		}
	} else {
		for (let i = 0; i < count; i++) {
			const o = HEADER + i * PS;
			const id = buf.getUint16(o, true);
			const flags = buf.getUint8(o + 10);
			if (flags & 2) { playerMap.delete(id); continue; }
			playerMap.set(id, {
				id,
				x: buf.getFloat32(o + 2, true),
				y: buf.getFloat32(o + 6, true),
				grounded: (flags & 1) === 1,
			});
		}
	}
}

// --- Rendering ---
function getCamera() {
	const me = playerMap.get(myPlayerId);
	if (!me) return { x: 0, y: 0 };
	return { x: me.x - canvas.width / 2, y: me.y - canvas.height / 2 };
}

function playerColor(id) { return `hsl(${(id * 137.508) % 360}, 70%, 60%)`; }

function render() {
	ctx.fillStyle = "#1a1a2e";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	if (!map) { requestAnimationFrame(render); return; }

	const cam = getCamera();

	ctx.fillStyle = "#16213e"; ctx.strokeStyle = "#0f3460"; ctx.lineWidth = 2;
	for (const p of map.platforms) {
		const sx = p.x - cam.x, sy = p.y - cam.y;
		if (sx + p.w < -50 || sx > canvas.width + 50 || sy + p.h < -50 || sy > canvas.height + 50) continue;
		ctx.fillRect(sx, sy, p.w, p.h); ctx.strokeRect(sx, sy, p.w, p.h);
	}

	for (const [, p] of playerMap) {
		const sx = p.x - cam.x, sy = p.y - cam.y;
		if (sx < -50 || sx > canvas.width + 50 || sy < -50 || sy > canvas.height + 50) continue;
		const isMe = p.id === myPlayerId;
		ctx.beginPath(); ctx.arc(sx, sy, PLAYER_RADIUS, 0, Math.PI * 2);
		ctx.fillStyle = playerColor(p.id); ctx.globalAlpha = isMe ? 1 : 0.7; ctx.fill();
		if (isMe) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
		ctx.globalAlpha = 1;
		ctx.fillStyle = "#fff"; ctx.font = "10px monospace"; ctx.textAlign = "center";
		ctx.fillText(`${p.id}`, sx, sy - PLAYER_RADIUS - 4);
	}

	ctx.fillStyle = "#e94560"; ctx.font = "12px monospace"; ctx.textAlign = "center";
	ctx.fillText("SPAWN", map.spawn.x - cam.x, map.spawn.y - 20 - cam.y);

	// HUD
	ctx.fillStyle = "#888"; ctx.font = "12px monospace"; ctx.textAlign = "right";
	ctx.fillText(`Players: ${playerMap.size}`, canvas.width - 10, 20);
	const roleLabel = myRole === "relay"
		? `RELAY (${relayChildPCs.size} children)`
		: sfuFallback ? "LEAF (SFU fallback)" : "LEAF (P2P)";
	ctx.fillText(roleLabel, canvas.width - 10, 36);

	requestAnimationFrame(render);
}

join().catch((err) => { console.error(err); statusEl.textContent = `Error: ${err.message}`; });
requestAnimationFrame(render);
