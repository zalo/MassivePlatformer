// --- Constants ---
const INPUT_LEFT = 1;
const INPUT_RIGHT = 2;
const INPUT_JUMP = 4;
const PLAYER_RADIUS = 12;
const INPUT_SEND_RATE = 50;
const STUN_SERVER = "stun:stun.cloudflare.com:3478";

// --- State ---
let myPlayerId = null;
let players = [];
let map = null;
let inputChannel = null;
let stateChannel = null;
let lastSentInput = -1;

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");

function resize() { canvas.width = innerWidth; canvas.height = innerHeight; }
addEventListener("resize", resize);
resize();

// --- Keyboard input ---
const keys = {};
addEventListener("keydown", (e) => { keys[e.code] = true; if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"].includes(e.code)) e.preventDefault(); });
addEventListener("keyup", (e) => { keys[e.code] = false; });

// --- Touch input ---
const touch = { left: false, right: false, jump: false };

function setupTouchButton(id, field) {
	const btn = document.getElementById(id);
	if (!btn) return;

	function activate(e) {
		e.preventDefault();
		touch[field] = true;
		btn.classList.add("active");
	}
	function deactivate(e) {
		e.preventDefault();
		touch[field] = false;
		btn.classList.remove("active");
	}

	btn.addEventListener("touchstart", activate, { passive: false });
	btn.addEventListener("touchend", deactivate, { passive: false });
	btn.addEventListener("touchcancel", deactivate, { passive: false });

	// Handle finger sliding off the button
	btn.addEventListener("touchmove", (e) => {
		e.preventDefault();
		const t = e.changedTouches[0];
		const rect = btn.getBoundingClientRect();
		const inside = t.clientX >= rect.left && t.clientX <= rect.right &&
		               t.clientY >= rect.top && t.clientY <= rect.bottom;
		touch[field] = inside;
		btn.classList.toggle("active", inside);
	}, { passive: false });
}

setupTouchButton("btn-left", "left");
setupTouchButton("btn-right", "right");
setupTouchButton("btn-up", "jump");
setupTouchButton("btn-jump", "jump");

// Prevent context menu and double-tap zoom globally
addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("touchstart", (e) => {
	if (e.target === canvas) e.preventDefault();
}, { passive: false });

function readInput() {
	let s = 0;
	if (keys.ArrowLeft || keys.KeyA || touch.left) s |= INPUT_LEFT;
	if (keys.ArrowRight || keys.KeyD || touch.right) s |= INPUT_RIGHT;
	if (keys.ArrowUp || keys.KeyW || keys.Space || touch.jump) s |= INPUT_JUMP;
	return s;
}

// --- Calls API helper ---
async function callsAPI(apiBase, token, path, body) {
	const opts = {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	};
	if (body) opts.body = JSON.stringify(body);
	else delete opts.headers["Content-Type"];
	const r = await fetch(`${apiBase}${path}`, opts);
	return r.json();
}

// --- Join flow ---
async function join() {
	statusEl.textContent = "Getting config...";

	// 1. Get game config from server
	const config = await (await fetch("/api/config")).json();
	if (config.error) throw new Error(config.error);

	myPlayerId = config.playerId;
	map = config.map;
	const { callsApi, callsToken, bridgeSessionId, inputChannelName } = config;

	statusEl.textContent = "Connecting to SFU...";

	// 2. Create PeerConnection and connect atomically (createPeer pattern)
	const pc = new RTCPeerConnection({
		iceServers: [{ urls: STUN_SERVER }],
		bundlePolicy: "max-bundle",
	});

	pc.onconnectionstatechange = () => console.log("PC:", pc.connectionState);

	// Bootstrap channel to generate SDP offer
	const bootstrapDC = pc.createDataChannel("bootstrap");
	bootstrapDC.onopen = () => bootstrapDC.close();

	// Create offer (do NOT wait for ICE gathering — send immediately)
	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);

	// 3. Create session on SFU with our offer
	const sess = await callsAPI(callsApi, callsToken, "/sessions/new", {
		sessionDescription: { type: "offer", sdp: offer.sdp },
	});
	if (sess.errorCode) throw new Error(sess.errorDescription);

	// 4. Apply SFU answer
	await pc.setRemoteDescription(sess.sessionDescription);

	// 5. Wait for connection
	await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("Connection timeout")), 10000);
		if (pc.connectionState === "connected") { clearTimeout(t); return resolve(); }
		pc.onconnectionstatechange = () => {
			if (pc.connectionState === "connected") { clearTimeout(t); resolve(); }
			else if (pc.connectionState === "failed") { clearTimeout(t); reject(new Error("Failed")); }
		};
	});

	console.log("Connected! Setting up channels atomically...");
	statusEl.textContent = "Setting up channels...";

	// 6. Create input channel (local — we publish)
	const inputResp = await callsAPI(callsApi, callsToken,
		`/sessions/${sess.sessionId}/datachannels/new`,
		{ dataChannels: [{ location: "local", dataChannelName: inputChannelName }] }
	);

	// 7. Subscribe to bridge game-state AND create negotiated channel atomically
	const stateResp = await callsAPI(callsApi, callsToken,
		`/sessions/${sess.sessionId}/datachannels/new`,
		{ dataChannels: [{ location: "remote", sessionId: bridgeSessionId, dataChannelName: "game-state" }] }
	);
	// Create negotiated channel IMMEDIATELY — same microtask
	stateChannel = pc.createDataChannel("game-state-sub", {
		negotiated: true,
		id: stateResp.dataChannels[0].id,
		ordered: false,
		maxRetransmits: 0,
	});
	stateChannel.binaryType = "arraybuffer";
	stateChannel.onopen = () => console.log("State channel open");
	stateChannel.onmessage = (evt) => handleStateUpdate(evt.data);

	// Create input channel (negotiated)
	inputChannel = pc.createDataChannel(inputChannelName, {
		negotiated: true,
		id: inputResp.dataChannels[0].id,
		ordered: false,
		maxRetransmits: 0,
	});
	inputChannel.binaryType = "arraybuffer";
	inputChannel.onopen = () => console.log("Input channel open");

	// 8. Register with game server (bridge subscribes to our input)
	await fetch("/api/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ playerId: myPlayerId, sessionId: sess.sessionId, inputChannelName }),
	});

	statusEl.textContent = `Player ${myPlayerId} — Playing!`;
	setInterval(sendInput, 1000 / INPUT_SEND_RATE);

	addEventListener("beforeunload", () => {
		navigator.sendBeacon("/api/leave", JSON.stringify({ playerId: myPlayerId }));
	});
}

function sendInput() {
	const s = readInput();
	if (inputChannel && inputChannel.readyState === "open" && s !== lastSentInput) {
		inputChannel.send(new Uint8Array([s]));
		lastSentInput = s;
	}
}

// Player state stored as a Map for efficient delta updates
const playerMap = new Map(); // id -> { id, x, y, grounded }

function handleStateUpdate(data) {
	const buf = new DataView(data);
	const type = buf.getUint8(0);     // 0 = full, 1 = delta
	const count = buf.getUint16(1, true);
	const PS = 11; // 2+4+4+1

	if (type === 0) {
		// Full snapshot — replace all state
		playerMap.clear();
	}

	for (let i = 0; i < count; i++) {
		const o = 3 + i * PS;
		const id = buf.getUint16(o, true);
		const flags = buf.getUint8(o + 10);

		if (flags & 2) {
			// Removed
			playerMap.delete(id);
		} else {
			playerMap.set(id, {
				id,
				x: buf.getFloat32(o + 2, true),
				y: buf.getFloat32(o + 6, true),
				grounded: (flags & 1) === 1,
			});
		}
	}

	players = Array.from(playerMap.values());
}

// --- Rendering ---
function getCamera() {
	const me = players.find((p) => p.id === myPlayerId);
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

	for (const p of players) {
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

	ctx.fillStyle = "#888"; ctx.font = "12px monospace"; ctx.textAlign = "right";
	ctx.fillText(`Players: ${players.length}`, canvas.width - 10, 20);

	requestAnimationFrame(render);
}

join().catch((err) => { console.error(err); statusEl.textContent = `Error: ${err.message}`; });
requestAnimationFrame(render);
