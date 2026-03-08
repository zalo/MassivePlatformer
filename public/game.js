// --- Constants ---
const INPUT_LEFT = 1;
const INPUT_RIGHT = 2;
const INPUT_JUMP = 4;
const PLAYER_RADIUS = 12;
const INPUT_SEND_RATE = 50;
const INPUT_HEARTBEAT_MS = 200; // Resend input every 200ms even if unchanged
const STUN_SERVER = "stun:stun.cloudflare.com:3478";
const EXTRAP_MAX_MS = 200; // Max extrapolation time before clamping

// --- State ---
let myPlayerId = null;
let map = null;
let inputChannel = null;
let stateChannel = null;
let lastSentInput = -1;
let lastSendTime = 0;

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

// --- Calls API proxy (token stays server-side) ---
async function callsAPI(path, body) {
	const opts = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
	};
	if (body) opts.body = JSON.stringify(body);
	else delete opts.headers["Content-Type"];
	const r = await fetch(`/api/calls${path}`, opts);
	return r.json();
}

// --- Join flow ---
async function join() {
	statusEl.textContent = "Getting config...";

	const config = await (await fetch("/api/config")).json();
	if (config.error) throw new Error(config.error);

	myPlayerId = config.playerId;
	map = config.map;
	const { bridgeSessionId, inputChannelName } = config;

	statusEl.textContent = "Connecting to SFU...";

	const pc = new RTCPeerConnection({
		iceServers: [{ urls: STUN_SERVER }],
		bundlePolicy: "max-bundle",
	});

	pc.onconnectionstatechange = () => console.log("PC:", pc.connectionState);

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

	console.log("Connected! Setting up channels...");
	statusEl.textContent = "Setting up channels...";

	const inputResp = await callsAPI(
		`/sessions/${sess.sessionId}/datachannels/new`,
		{ dataChannels: [{ location: "local", dataChannelName: inputChannelName }] }
	);

	const stateResp = await callsAPI(
		`/sessions/${sess.sessionId}/datachannels/new`,
		{ dataChannels: [{ location: "remote", sessionId: bridgeSessionId, dataChannelName: "game-state" }] }
	);
	stateChannel = pc.createDataChannel("game-state-sub", {
		negotiated: true,
		id: stateResp.dataChannels[0].id,
		ordered: false,
		maxRetransmits: 0,
	});
	stateChannel.binaryType = "arraybuffer";
	stateChannel.onopen = () => console.log("State channel open");
	stateChannel.onmessage = (evt) => handleStateUpdate(evt.data);

	inputChannel = pc.createDataChannel(inputChannelName, {
		negotiated: true,
		id: inputResp.dataChannels[0].id,
		ordered: false,
		maxRetransmits: 0,
	});
	inputChannel.binaryType = "arraybuffer";
	inputChannel.onopen = () => console.log("Input channel open");

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
	if (!inputChannel || inputChannel.readyState !== "open") return;
	const s = readInput();
	const now = performance.now();
	// Send if changed OR heartbeat interval elapsed (protects against lost packets)
	if (s !== lastSentInput || (now - lastSendTime) >= INPUT_HEARTBEAT_MS) {
		inputChannel.send(new Uint8Array([s]));
		lastSentInput = s;
		lastSendTime = now;
	}
}

// --- Player state with extrapolation ---
// Each player stores two snapshots for velocity estimation
// { id, x, y, grounded, prevX, prevY, updateTime, prevUpdateTime }
const playerMap = new Map();

function handleStateUpdate(data) {
	const buf = new DataView(data);
	const type = buf.getUint8(0);
	const count = buf.getUint16(1, true);
	const PS = 11;
	const now = performance.now();

	if (type === 0) {
		// Full snapshot — mark all existing as stale, then update
		const seen = new Set();
		for (let i = 0; i < count; i++) {
			const o = 3 + i * PS;
			const id = buf.getUint16(o, true);
			const flags = buf.getUint8(o + 10);
			if (flags & 2) { playerMap.delete(id); continue; }

			const nx = buf.getFloat32(o + 2, true);
			const ny = buf.getFloat32(o + 6, true);
			const existing = playerMap.get(id);

			playerMap.set(id, {
				id,
				x: nx, y: ny,
				grounded: (flags & 1) === 1,
				prevX: existing ? existing.x : nx,
				prevY: existing ? existing.y : ny,
				updateTime: now,
				prevUpdateTime: existing ? existing.updateTime : now,
			});
			seen.add(id);
		}
		// Remove players not in full snapshot
		for (const [id] of playerMap) {
			if (!seen.has(id)) playerMap.delete(id);
		}
	} else {
		// Delta — update only included players
		for (let i = 0; i < count; i++) {
			const o = 3 + i * PS;
			const id = buf.getUint16(o, true);
			const flags = buf.getUint8(o + 10);

			if (flags & 2) { playerMap.delete(id); continue; }

			const nx = buf.getFloat32(o + 2, true);
			const ny = buf.getFloat32(o + 6, true);
			const existing = playerMap.get(id);

			playerMap.set(id, {
				id,
				x: nx, y: ny,
				grounded: (flags & 1) === 1,
				prevX: existing ? existing.x : nx,
				prevY: existing ? existing.y : ny,
				updateTime: now,
				prevUpdateTime: existing ? existing.updateTime : now,
			});
		}
	}
}

// Extrapolate a player's position based on velocity between last two snapshots
function getExtrapolatedPos(p, now) {
	const dt = p.updateTime - p.prevUpdateTime;
	if (dt <= 0) return { x: p.x, y: p.y };

	// Velocity from last two known positions
	const vx = (p.x - p.prevX) / dt;
	const vy = (p.y - p.prevY) / dt;

	// How long since the last update
	const elapsed = Math.min(now - p.updateTime, EXTRAP_MAX_MS);
	if (elapsed <= 0) return { x: p.x, y: p.y };

	return {
		x: p.x + vx * elapsed,
		y: p.y + vy * elapsed,
	};
}

// --- Rendering ---
function getCamera() {
	const me = playerMap.get(myPlayerId);
	if (!me) return { x: 0, y: 0 };
	const pos = getExtrapolatedPos(me, performance.now());
	return { x: pos.x - canvas.width / 2, y: pos.y - canvas.height / 2 };
}

function playerColor(id) { return `hsl(${(id * 137.508) % 360}, 70%, 60%)`; }

function render() {
	ctx.fillStyle = "#1a1a2e";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	if (!map) { requestAnimationFrame(render); return; }

	const now = performance.now();
	const cam = getCamera();

	ctx.fillStyle = "#16213e"; ctx.strokeStyle = "#0f3460"; ctx.lineWidth = 2;
	for (const p of map.platforms) {
		const sx = p.x - cam.x, sy = p.y - cam.y;
		if (sx + p.w < -50 || sx > canvas.width + 50 || sy + p.h < -50 || sy > canvas.height + 50) continue;
		ctx.fillRect(sx, sy, p.w, p.h); ctx.strokeRect(sx, sy, p.w, p.h);
	}

	for (const [, p] of playerMap) {
		const pos = getExtrapolatedPos(p, now);
		const sx = pos.x - cam.x, sy = pos.y - cam.y;
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
	ctx.fillText(`Players: ${playerMap.size}`, canvas.width - 10, 20);

	requestAnimationFrame(render);
}

join().catch((err) => { console.error(err); statusEl.textContent = `Error: ${err.message}`; });
requestAnimationFrame(render);
