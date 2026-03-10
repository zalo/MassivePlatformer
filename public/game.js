// --- Platformer Game Client ---
// Uses CloudflareRelay.Client for all networking.

const INPUT_LEFT = 1;
const INPUT_RIGHT = 2;
const INPUT_JUMP = 4;
const PLAYER_RADIUS = 12;
const HEADER_SIZE = 5; // type(1) + seq(1) + channel(1) + count(2)
const ENTRY_SIZE = 11;

let map = null;
const playerMap = new Map();
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
	const activate = (e) => { e.preventDefault(); touch[field] = true; btn.classList.add("active"); };
	const deactivate = (e) => { e.preventDefault(); touch[field] = false; btn.classList.remove("active"); };
	btn.addEventListener("touchstart", activate, { passive: false });
	btn.addEventListener("touchend", deactivate, { passive: false });
	btn.addEventListener("touchcancel", deactivate, { passive: false });
	btn.addEventListener("touchmove", (e) => {
		e.preventDefault();
		const t = e.changedTouches[0], rect = btn.getBoundingClientRect();
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

// --- Networking via relay library ---
const client = new CloudflareRelay.Client({ inputRate: 50 });

client.setInputProvider(() => new Uint8Array([readInput()]));

client.onRoleAssigned((role, playerId) => {
	statusEl.textContent = `Player ${playerId} [${role.toUpperCase()}]`;
});

client.onConnected((playerId, role) => {
	statusEl.textContent = `Player ${playerId} [${role.toUpperCase()}] — Playing!`;
});

client.onStateUpdate((data) => {
	const buf = new DataView(data);
	const type = buf.getUint8(0);
	const count = buf.getUint16(3, true);

	if (type === 0) {
		const seen = new Set();
		for (let i = 0; i < count; i++) {
			const o = HEADER_SIZE + i * ENTRY_SIZE;
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
		for (const [id] of playerMap) { if (!seen.has(id)) playerMap.delete(id); }
	} else {
		for (let i = 0; i < count; i++) {
			const o = HEADER_SIZE + i * ENTRY_SIZE;
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
});

async function start() {
	statusEl.textContent = "Connecting...";
	await client.connect();
	map = client.config.map;
}

start().catch((err) => { console.error(err); statusEl.textContent = `Error: ${err.message}`; });

// --- Rendering ---
function getCamera() {
	if (!client.playerId) return { x: 0, y: 0 };
	const me = playerMap.get(client.playerId);
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
		const isMe = p.id === client.playerId;
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

	const stats = client.getRelayStats();
	let roleLabel;
	if (stats.role === "relay") {
		roleLabel = `RELAY (${stats.children} children)`;
	} else {
		roleLabel = `LEAF (${stats.activeChannels}/${stats.totalChannels} P2P${stats.sfuFallback ? " +SFU" : ""})`;
	}
	ctx.fillText(roleLabel, canvas.width - 10, 36);

	requestAnimationFrame(render);
}

requestAnimationFrame(render);
