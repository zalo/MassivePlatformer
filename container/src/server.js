const http = require("http");
const fs = require("fs");
const path = require("path");

// Test if node-datachannel loads
let Bridge, bridgeAvailable = false;
try {
	({ Bridge } = require("./bridge"));
	bridgeAvailable = true;
	console.log("node-datachannel loaded successfully");
} catch (err) {
	console.error("node-datachannel failed to load:", err.message);
}

const { GameWorld } = require("./physics");
const { MAP } = require("./map");

const MIME_TYPES = {
	".html": "text/html",
	".js": "application/javascript",
	".css": "text/css",
	".json": "application/json",
};

const CALLS_APP_ID = process.env.CALLS_APP_ID;
const CALLS_APP_TOKEN = process.env.CALLS_APP_TOKEN;
const CALLS_API = `https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}`;
const PORT = 8080;
const TICK_RATE = 45; // Hz (3x the 15hz network rate)
const PLAYER_TIMEOUT_MS = 60 * 1000; // Remove players after 60 seconds of no input

if (!CALLS_APP_ID || !CALLS_APP_TOKEN) {
	console.error("Missing CALLS_APP_ID or CALLS_APP_TOKEN — running in degraded mode");
}

// --- Game state ---
const world = new GameWorld(MAP);
const bridge = bridgeAvailable ? new Bridge(CALLS_API, CALLS_APP_TOKEN) : null;
let bridgeReady = false;
let nextPlayerId = 1;

// Map of playerId -> { sessionId, inputChannelName, lastInputTime }
const players = new Map();

// --- Initialize bridge session ---
async function initBridge() {
	await bridge.init();
	world.setBridge(bridge);
	bridgeReady = true;
	console.log(`Bridge session created: ${bridge.sessionId}`);
}

// --- Physics tick (45hz) ---
setInterval(() => {
	if (!bridgeReady) return;
	world.tick(1 / TICK_RATE);
}, 1000 / TICK_RATE);

// --- Player timeout sweep (every 10 seconds) ---
setInterval(() => {
	if (!bridge) return;
	const now = Date.now();
	for (const [playerId, player] of players) {
		const lastInput = bridge.getLastInputTime(playerId);
		// Only timeout players who have registered (lastInput > 0) and gone silent
		if (lastInput > 0 && (now - lastInput) > PLAYER_TIMEOUT_MS) {
			console.log(`Player ${playerId} timed out (no input for ${Math.round((now - lastInput) / 1000)}s)`);
			world.removePlayer(playerId);
			bridge.unsubscribePlayer(playerId);
			players.delete(playerId);
		}
	}
}, 10000);

// --- Network broadcast (15hz, decoupled from physics) ---
// Packet format:
//   [type:u8, count:u16, ...players[id:u16, x:f32, y:f32, flags:u8]]
// type 0 = full snapshot (all players), type 1 = delta (only changed/removed)
// flags: bit 0 = grounded, bit 1 = removed (player left)
const NET_RATE = 15; // Hz
const PLAYER_SIZE = 11; // 2+4+4+1
const FULL_SNAPSHOT_INTERVAL = 3 * NET_RATE; // Full snapshot every 3 seconds
const POSITION_THRESHOLD = 0.3; // Min change in px to include in delta

const lastSentState = new Map(); // playerId -> { x, y, flags }
let ticksSinceFullSnapshot = 0;
let debugCounter = 0;

setInterval(() => {
	if (!bridgeReady) return;

	const playerList = world.getPlayers();
	const isFull =
		ticksSinceFullSnapshot >= FULL_SNAPSHOT_INTERVAL ||
		lastSentState.size === 0;
	ticksSinceFullSnapshot = isFull ? 0 : ticksSinceFullSnapshot + 1;

	// Determine which players changed
	let toSend;
	if (isFull) {
		toSend = playerList;
	} else {
		toSend = [];
		for (const p of playerList) {
			const prev = lastSentState.get(p.id);
			const flags = p.grounded ? 1 : 0;
			if (
				!prev ||
				Math.abs(p.x - prev.x) > POSITION_THRESHOLD ||
				Math.abs(p.y - prev.y) > POSITION_THRESHOLD ||
				flags !== prev.flags
			) {
				toSend.push(p);
			}
		}
	}

	// Detect removed players
	const currentIds = new Set(playerList.map((p) => p.id));
	const removed = [];
	for (const [id] of lastSentState) {
		if (!currentIds.has(id)) {
			removed.push(id);
			lastSentState.delete(id);
		}
	}

	const totalEntries = toSend.length + removed.length;
	if (totalEntries === 0 && !isFull) return;

	// Build packet: [type:u8, count:u16, ...entries]
	const buf = Buffer.alloc(3 + totalEntries * PLAYER_SIZE);
	buf.writeUInt8(isFull ? 0 : 1, 0);
	buf.writeUInt16LE(totalEntries, 1);

	let offset = 3;
	for (const p of toSend) {
		const flags = p.grounded ? 1 : 0;
		buf.writeUInt16LE(p.id, offset);
		buf.writeFloatLE(p.x, offset + 2);
		buf.writeFloatLE(p.y, offset + 6);
		buf.writeUInt8(flags, offset + 10);
		offset += PLAYER_SIZE;
		lastSentState.set(p.id, { x: p.x, y: p.y, flags });
	}
	for (const id of removed) {
		buf.writeUInt16LE(id, offset);
		buf.writeFloatLE(0, offset + 2);
		buf.writeFloatLE(0, offset + 4);
		buf.writeUInt8(2, offset + 6); // flags bit 1 = removed
		offset += PLAYER_SIZE;
	}

	const sent = bridge.broadcastState(buf.subarray(0, offset));
	if (playerList.length > 0 && debugCounter++ % NET_RATE === 0) {
		console.log(
			`Net: ${playerList.length} players, ${offset}B ${isFull ? "FULL" : "delta(" + toSend.length + " changed)"}, sent: ${sent}`
		);
	}
}, 1000 / NET_RATE);

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
	// CORS
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	try {
		if (req.method === "GET" && req.url === "/api/config") {
			await handleConfig(req, res);
		} else if (req.method === "POST" && req.url.startsWith("/api/calls/")) {
			await handleCallsProxy(req, res);
		} else if (req.method === "POST" && req.url === "/api/register") {
			await handleRegister(req, res);
		} else if (req.method === "POST" && req.url === "/api/leave") {
			await handleLeave(req, res);
		} else if (req.method === "GET" && req.url === "/api/map") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(MAP));
		} else if (req.method === "GET") {
			// Serve static files from ../public (for local dev)
			const publicDir = path.resolve(__dirname, "../../public");
			let filePath = req.url === "/" ? "/index.html" : req.url;
			const fullPath = path.join(publicDir, filePath);
			const ext = path.extname(fullPath);
			const mime = MIME_TYPES[ext] || "application/octet-stream";
			try {
				const content = fs.readFileSync(fullPath);
				res.writeHead(200, { "Content-Type": mime });
				res.end(content);
			} catch {
				res.writeHead(404);
				res.end("Not found");
			}
		} else {
			res.writeHead(404);
			res.end("Not found");
		}
	} catch (err) {
		console.error("Request error:", err);
		res.writeHead(500);
		res.end(JSON.stringify({ error: err.message }));
	}
});

// Returns connection config. Token is NOT exposed — client uses /api/calls/ proxy.
async function handleConfig(req, res) {
	if (!bridgeReady) {
		res.writeHead(503);
		res.end(JSON.stringify({ error: "Bridge not ready" }));
		return;
	}

	const playerId = nextPlayerId++;
	const inputChannelName = `input-${playerId}`;

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(
		JSON.stringify({
			playerId,
			inputChannelName,
			bridgeSessionId: bridge.sessionId,
			map: MAP,
		})
	);
}

// Proxy Calls API requests — keeps the token server-side.
// Client sends: POST /api/calls/sessions/new  (body forwarded as-is)
// Server adds auth header and forwards to Cloudflare Calls API.
async function handleCallsProxy(req, res) {
	const callsPath = req.url.replace("/api/calls", "");
	const body = await readBody(req);

	const opts = {
		method: "POST",
		headers: {
			Authorization: `Bearer ${CALLS_APP_TOKEN}`,
		},
	};
	if (body) {
		opts.headers["Content-Type"] = "application/json";
		opts.body = body; // Forward raw body
	}

	const resp = await fetch(`${CALLS_API}${callsPath}`, opts);
	const data = await resp.text();

	res.writeHead(resp.status, { "Content-Type": "application/json" });
	res.end(data);
}

// Client calls this AFTER connecting and setting up channels
// to register with the game server and have bridge subscribe to input
async function handleRegister(req, res) {
	const body = await readBody(req);
	const { playerId, sessionId, inputChannelName } = JSON.parse(body);

	world.addPlayer(playerId);
	players.set(playerId, { sessionId, inputChannelName });

	// Subscribe bridge to player's input channel
	bridge.subscribeToPlayerInput(
		sessionId,
		inputChannelName,
		playerId
	).catch((e) => console.error("Bridge subscribe error:", e));

	console.log(`Player ${playerId} registered (session: ${sessionId})`);

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: true }));
}

async function handleLeave(req, res) {
	const body = await readBody(req);
	const { playerId } = JSON.parse(body);

	const player = players.get(playerId);
	if (player) {
		world.removePlayer(playerId);
		players.delete(playerId);
		bridge.unsubscribePlayer(playerId);
		console.log(`Player ${playerId} left`);
	}

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: true }));
}

// --- Helpers ---
async function callsAPI(path, body, method = "POST") {
	const opts = {
		method,
		headers: {
			Authorization: `Bearer ${CALLS_APP_TOKEN}`,
		},
	};
	if (body !== undefined && body !== null) {
		opts.headers["Content-Type"] = "application/json";
		opts.body = JSON.stringify(body);
	}
	const resp = await fetch(`${CALLS_API}${path}`, opts);
	const data = await resp.json();
	if (data.errorCode) {
		throw new Error(`Calls API error: ${data.errorDescription}`);
	}
	return data;
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

// --- Start ---
// Start HTTP server immediately (container health check needs port 8080 listening)
server.listen(PORT, () => {
	console.log(`Game server listening on port ${PORT}`);
});

// Initialize bridge in background (retry on failure)
async function startBridge(retries = 5) {
	for (let i = 0; i < retries; i++) {
		try {
			console.log(`Bridge init attempt ${i + 1}/${retries}...`);
			await initBridge();
			return;
		} catch (err) {
			console.error(`Bridge init attempt ${i + 1}/${retries} failed:`, err.message);
			console.error(err.stack);
			if (i < retries - 1) {
				await new Promise((r) => setTimeout(r, 3000));
			}
		}
	}
	console.error("Bridge failed to initialize after all retries");
}

// Delay bridge start to let container fully initialize
setTimeout(() => startBridge(), 1000);
