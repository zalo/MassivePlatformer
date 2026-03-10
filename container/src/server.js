const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
const { RelayTree } = require("./relay-tree");

// --- Packet signing ---
// Ed25519 key pair for signing state packets. Prevents relay nodes from spoofing.
// The public key is sent to clients in /api/config so they can verify.
const { publicKey: SIGN_PUBLIC, privateKey: SIGN_PRIVATE } =
	crypto.generateKeyPairSync("ed25519");
const SIGN_PUBLIC_RAW = SIGN_PUBLIC.export({ type: "spki", format: "der" });
// Ed25519 signatures are 64 bytes
const SIG_SIZE = 64;

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
const TICK_RATE = 45;
const PLAYER_TIMEOUT_MS = 60 * 1000;

if (!CALLS_APP_ID || !CALLS_APP_TOKEN) {
	console.error("Missing CALLS_APP_ID or CALLS_APP_TOKEN — running in degraded mode");
}

// --- Game state ---
const world = new GameWorld(MAP);
const bridge = bridgeAvailable ? new Bridge(CALLS_API, CALLS_APP_TOKEN) : null;
const relayTree = new RelayTree();
let bridgeReady = false;
let nextPlayerId = 1;

// playerId -> { sessionId, inputChannelName }
const players = new Map();

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
		if (lastInput > 0 && (now - lastInput) > PLAYER_TIMEOUT_MS) {
			console.log(`Player ${playerId} timed out`);
			world.removePlayer(playerId);
			bridge.unsubscribePlayer(playerId);
			relayTree.removePlayer(playerId);
			players.delete(playerId);
		}
	}
}, 10000);

// --- Network broadcast (15hz) ---
// Packet format:
//   [type:u8, seq:u8, count:u16, ...players(id:u16, x:f32, y:f32, flags:u8), signature:64B]
// type 0 = full snapshot (resets seq to 0), type 1 = delta
// seq = 0-255, wraps. Reset to 0 on each full snapshot.
// Signature: Ed25519 over the payload (everything before the signature).
const NET_RATE = 15;
const PLAYER_SIZE = 11;
const HEADER_SIZE = 4; // type(1) + seq(1) + count(2)
const FULL_SNAPSHOT_INTERVAL = 3 * NET_RATE;
const POSITION_THRESHOLD = 0.3;

const lastSentState = new Map();
let ticksSinceFullSnapshot = 0;
let seqNumber = 0;
let debugCounter = 0;

setInterval(() => {
	if (!bridgeReady) return;

	const playerList = world.getPlayers();
	const isFull =
		ticksSinceFullSnapshot >= FULL_SNAPSHOT_INTERVAL ||
		lastSentState.size === 0;

	if (isFull) {
		ticksSinceFullSnapshot = 0;
		seqNumber = 0;
	} else {
		ticksSinceFullSnapshot++;
		seqNumber = (seqNumber + 1) & 0xff;
	}

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

	const payloadSize = HEADER_SIZE + totalEntries * PLAYER_SIZE;
	const buf = Buffer.alloc(payloadSize + SIG_SIZE);

	// Header
	buf.writeUInt8(isFull ? 0 : 1, 0);
	buf.writeUInt8(seqNumber, 1);
	buf.writeUInt16LE(totalEntries, 2);

	// Player entries
	let offset = HEADER_SIZE;
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
		buf.writeUInt8(2, offset + 6);
		offset += PLAYER_SIZE;
	}

	// Sign the payload (everything before signature)
	const payload = buf.subarray(0, payloadSize);
	const sig = crypto.sign(null, payload, SIGN_PRIVATE);
	sig.copy(buf, payloadSize);

	const sent = bridge.broadcastState(buf.subarray(0, payloadSize + SIG_SIZE));
	if (playerList.length > 0 && debugCounter++ % NET_RATE === 0) {
		const stats = relayTree.getStats();
		console.log(
			`Net: ${playerList.length} players, ${payloadSize + SIG_SIZE}B seq=${seqNumber} ${isFull ? "FULL" : "delta(" + toSend.length + ")"}, relays: ${stats.relays}, leaves: ${stats.leaves}`
		);
	}
}, 1000 / NET_RATE);

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	try {
		const url = req.url.split("?")[0];
		if (req.method === "GET" && url === "/api/config") {
			await handleConfig(req, res);
		} else if (req.method === "POST" && url.startsWith("/api/calls/")) {
			await handleCallsProxy(req, res);
		} else if (req.method === "POST" && url === "/api/register") {
			await handleRegister(req, res);
		} else if (req.method === "POST" && url === "/api/leave") {
			await handleLeave(req, res);
		} else if (req.method === "GET" && url === "/api/relay-pending") {
			handleRelayPending(req, res);
		} else if (req.method === "POST" && url === "/api/relay-answer") {
			await handleRelayAnswer(req, res);
		} else if (req.method === "GET" && url.startsWith("/api/relay-answer/")) {
			handleGetRelayAnswer(req, res);
		} else if (req.method === "GET" && url === "/api/relay-role") {
			handleRelayRole(req, res);
		} else if (req.method === "GET" && url === "/api/map") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(MAP));
		} else if (req.method === "GET") {
			const publicDir = path.resolve(__dirname, "../../public");
			let filePath = url === "/" ? "/index.html" : url;
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

// --- Config: returns player ID, bridge session, relay role ---
async function handleConfig(req, res) {
	if (!bridgeReady) {
		res.writeHead(503);
		res.end(JSON.stringify({ error: "Bridge not ready" }));
		return;
	}

	const playerId = nextPlayerId++;
	const inputChannelName = `input-${playerId}`;

	// Assign relay role
	const assignment = relayTree.assignRole(playerId);

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({
		playerId,
		inputChannelName,
		bridgeSessionId: bridge.sessionId,
		signPublicKey: SIGN_PUBLIC_RAW.toString("base64"),
		relay: assignment,
		map: MAP,
	}));
}

// --- Calls API proxy ---
async function handleCallsProxy(req, res) {
	const callsPath = req.url.replace("/api/calls", "");
	const body = await readBody(req);
	const opts = {
		method: "POST",
		headers: { Authorization: `Bearer ${CALLS_APP_TOKEN}` },
	};
	if (body) {
		opts.headers["Content-Type"] = "application/json";
		opts.body = body;
	}
	const resp = await fetch(`${CALLS_API}${callsPath}`, opts);
	const data = await resp.text();
	res.writeHead(resp.status, { "Content-Type": "application/json" });
	res.end(data);
}

// --- Register: player connected, set up input channel + P2P signaling ---
async function handleRegister(req, res) {
	const body = await readBody(req);
	const { playerId, sessionId, inputChannelName, p2pOffer, capabilities } = JSON.parse(body);

	world.addPlayer(playerId);
	players.set(playerId, { sessionId, inputChannelName });

	// Update relay tree with client capabilities for better relay selection
	if (capabilities) {
		relayTree.updateCapabilities(playerId, capabilities);
	}

	// Subscribe bridge to player's input channel
	if (bridge) {
		bridge.subscribeToPlayerInput(sessionId, inputChannelName, playerId)
			.catch((e) => console.error("Bridge subscribe error:", e));
	}

	// If this is a leaf with a P2P offer, store it for the relay to pick up
	const node = relayTree.getNode(playerId);
	if (node && node.role === "leaf" && node.relayParentId && p2pOffer) {
		relayTree.storeOffer(playerId, node.relayParentId, p2pOffer);
	}

	console.log(`Player ${playerId} registered (${node?.role || "unknown"}, session: ${sessionId})`);

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: true }));
}

// --- Leave ---
async function handleLeave(req, res) {
	const body = await readBody(req);
	const { playerId } = JSON.parse(body);
	const player = players.get(playerId);
	if (player) {
		world.removePlayer(playerId);
		players.delete(playerId);
		if (bridge) bridge.unsubscribePlayer(playerId);
		relayTree.removePlayer(playerId);
		console.log(`Player ${playerId} left`);
	}
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: true }));
}

// --- Relay polls for new children's P2P offers ---
function handleRelayPending(req, res) {
	const url = new URL(req.url, `http://localhost`);
	const relayId = parseInt(url.searchParams.get("relayId"));
	const offers = relayTree.getPendingOffers(relayId);
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ offers }));
}

// --- Relay sends P2P answer for a child ---
async function handleRelayAnswer(req, res) {
	const body = await readBody(req);
	const { childId, answer } = JSON.parse(body);
	relayTree.storeAnswer(childId, answer);
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: true }));
}

// --- Child polls for P2P answer from relay ---
function handleGetRelayAnswer(req, res) {
	const childId = parseInt(req.url.split("/").pop());
	const answer = relayTree.getAnswer(childId);
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ answer }));
}

// --- Child checks if role changed (orphan -> reassigned) ---
function handleRelayRole(req, res) {
	const url = new URL(req.url, `http://localhost`);
	const playerId = parseInt(url.searchParams.get("playerId"));
	const node = relayTree.getNode(playerId);
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({
		role: node?.role || "unknown",
		relayParentId: node?.relayParentId || null,
	}));
}

// --- Helpers ---
function readBody(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

// --- Start ---
server.listen(PORT, () => {
	console.log(`Game server listening on port ${PORT}`);
});

async function startBridge(retries = 5) {
	for (let i = 0; i < retries; i++) {
		try {
			console.log(`Bridge init attempt ${i + 1}/${retries}...`);
			await initBridge();
			return;
		} catch (err) {
			console.error(`Bridge init attempt ${i + 1}/${retries} failed:`, err.message);
			console.error(err.stack);
			if (i < retries - 1) await new Promise((r) => setTimeout(r, 3000));
		}
	}
	console.error("Bridge failed to initialize after all retries");
}

setTimeout(() => startBridge(), 1000);
