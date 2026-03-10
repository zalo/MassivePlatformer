const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let Bridge, bridgeAvailable = false;
try {
	({ Bridge } = require("./bridge"));
	bridgeAvailable = true;
} catch (err) {
	console.error("node-datachannel not available:", err.message);
}

const { RelayTree } = require("./relay-tree");

const SIG_SIZE = 64;

class RelayServer {
	/**
	 * @param {object} opts
	 * @param {string} opts.callsAppId
	 * @param {string} opts.callsAppToken
	 * @param {number} [opts.port=8080]
	 * @param {number} [opts.netRate=15]         - Network broadcast rate (Hz)
	 * @param {number} [opts.numChannels=3]      - SFU channels for redundant relay
	 * @param {number} [opts.fullSnapshotSec=3]  - Seconds between full snapshots
	 * @param {number} [opts.playerTimeoutMs=60000]
	 * @param {string} [opts.publicDir]          - Static file directory (for local dev)
	 * @param {object} [opts.appData]            - Custom data sent to clients in /api/config
	 */
	constructor(opts) {
		this.callsAppId = opts.callsAppId;
		this.callsAppToken = opts.callsAppToken;
		this.callsApi = `https://rtc.live.cloudflare.com/v1/apps/${opts.callsAppId}`;
		this.port = opts.port || 8080;
		this.netRate = opts.netRate || 15;
		this.numChannels = opts.numChannels || 3;
		this.fullSnapshotInterval = (opts.fullSnapshotSec || 3) * (opts.netRate || 15);
		this.playerTimeoutMs = opts.playerTimeoutMs || 60000;
		this.publicDir = opts.publicDir || null;
		this.appData = opts.appData || {};

		// Ed25519 signing
		const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
		this._signPrivate = privateKey;
		this._signPublicRaw = publicKey.export({ type: "spki", format: "der" });

		// State
		this.bridge = bridgeAvailable ? new Bridge(this.callsApi, this.callsAppToken) : null;
		this.relayTree = new RelayTree();
		this.bridgeReady = false;
		this.nextPlayerId = 1;
		this.players = new Map(); // playerId -> { sessionId, inputChannelName }

		// Delta compression state
		this._lastSentState = new Map();
		this._ticksSinceFullSnapshot = 0;
		this._seqNumber = 0;
		this._netTick = 0;

		// Callbacks (set by application)
		this._onPlayerJoin = null;
		this._onPlayerInput = null;
		this._onPlayerLeave = null;
		this._onPlayerTimeout = null;
		this._buildStateEntries = null;  // () => [{ id, ...fields }]
		this._serializeEntry = null;     // (buf, offset, entry) => void
		this._entrySize = 0;
		this._positionFields = null;     // (entry) => { x, y } for delta threshold
		this._flagsField = null;         // (entry) => number
	}

	onPlayerJoin(fn) { this._onPlayerJoin = fn; }
	onPlayerInput(fn) { this._onPlayerInput = fn; }
	onPlayerLeave(fn) { this._onPlayerLeave = fn; }
	onPlayerTimeout(fn) { this._onPlayerTimeout = fn; }

	/**
	 * Configure state broadcasting.
	 * @param {object} opts
	 * @param {function} opts.getEntries     - () => [{id, ...}] array of all entities
	 * @param {function} opts.serialize      - (buf, offset, entry) => void — write entry to buffer
	 * @param {number}   opts.entrySize      - Bytes per entry
	 * @param {function} opts.getPosition    - (entry) => {x, y} for delta threshold
	 * @param {function} opts.getFlags       - (entry) => number (u8 flags)
	 * @param {number}   [opts.threshold=0.3] - Min position change for delta
	 */
	configureState(opts) {
		this._buildStateEntries = opts.getEntries;
		this._serializeEntry = opts.serialize;
		this._entrySize = opts.entrySize;
		this._getPosition = opts.getPosition;
		this._getFlags = opts.getFlags;
		this._positionThreshold = opts.threshold || 0.3;
	}

	async start() {
		this._startHTTPServer();
		this._startPlayerTimeout();
		this._startNetworkBroadcast();

		if (this.bridge) {
			await this._startBridge();
		}
	}

	// --- Internal: Bridge ---
	async _startBridge(retries = 5) {
		for (let i = 0; i < retries; i++) {
			try {
				console.log(`Bridge init attempt ${i + 1}/${retries}...`);
				await this.bridge.init();
				this.bridgeReady = true;
				console.log(`Bridge session: ${this.bridge.sessionId}`);

				// Set up input forwarding from bridge to application
				if (this._onPlayerInput) {
					const origProcess = this.bridge._processInput.bind(this.bridge);
					const onInput = this._onPlayerInput;
					this.bridge._processInput = (playerId, msg) => {
						origProcess(playerId, msg);
						const data = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
						onInput(playerId, data);
					};
				}
				return;
			} catch (err) {
				console.error(`Bridge init ${i + 1}/${retries} failed:`, err.message);
				if (i < retries - 1) await new Promise((r) => setTimeout(r, 3000));
			}
		}
		console.error("Bridge failed to initialize");
	}

	// --- Internal: Player timeout ---
	_startPlayerTimeout() {
		setInterval(() => {
			if (!this.bridge) return;
			const now = Date.now();
			for (const [playerId] of this.players) {
				const lastInput = this.bridge.getLastInputTime(playerId);
				if (lastInput > 0 && (now - lastInput) > this.playerTimeoutMs) {
					console.log(`Player ${playerId} timed out`);
					this._removePlayer(playerId);
					if (this._onPlayerTimeout) this._onPlayerTimeout(playerId);
				}
			}
		}, 10000);
	}

	_removePlayer(playerId) {
		this.players.delete(playerId);
		if (this.bridge) this.bridge.unsubscribePlayer(playerId);
		this.relayTree.removePlayer(playerId);
		if (this._onPlayerLeave) this._onPlayerLeave(playerId);
	}

	// --- Internal: Network broadcast ---
	_startNetworkBroadcast() {
		const HEADER_SIZE = 5; // type(1) + seq(1) + channel(1) + count(2)

		setInterval(() => {
			if (!this.bridgeReady || !this._buildStateEntries) return;

			const channelIdx = this._netTick % this.numChannels;
			this._netTick++;

			const entries = this._buildStateEntries();
			const isFull =
				this._ticksSinceFullSnapshot >= this.fullSnapshotInterval ||
				this._lastSentState.size === 0;

			if (isFull) {
				this._ticksSinceFullSnapshot = 0;
				this._seqNumber = 0;
			} else {
				this._ticksSinceFullSnapshot++;
				this._seqNumber = (this._seqNumber + 1) & 0xff;
			}

			// Delta compression
			let toSend;
			if (isFull) {
				toSend = entries;
			} else {
				toSend = [];
				for (const e of entries) {
					const prev = this._lastSentState.get(e.id);
					const pos = this._getPosition(e);
					const flags = this._getFlags(e);
					if (
						!prev ||
						Math.abs(pos.x - prev.x) > this._positionThreshold ||
						Math.abs(pos.y - prev.y) > this._positionThreshold ||
						flags !== prev.flags
					) {
						toSend.push(e);
					}
				}
			}

			// Removed entries
			const currentIds = new Set(entries.map((e) => e.id));
			const removed = [];
			for (const [id] of this._lastSentState) {
				if (!currentIds.has(id)) {
					removed.push(id);
					this._lastSentState.delete(id);
				}
			}

			const total = toSend.length + removed.length;
			if (total === 0 && !isFull) return;

			// Update tracking
			for (const e of toSend) {
				const pos = this._getPosition(e);
				this._lastSentState.set(e.id, { x: pos.x, y: pos.y, flags: this._getFlags(e) });
			}

			const buildPacket = (type, seq, ch) => {
				const payloadSize = HEADER_SIZE + total * this._entrySize;
				const buf = Buffer.alloc(payloadSize + SIG_SIZE);
				buf.writeUInt8(type, 0);
				buf.writeUInt8(seq, 1);
				buf.writeUInt8(ch, 2);
				buf.writeUInt16LE(total, 3);

				let offset = HEADER_SIZE;
				for (const e of toSend) {
					this._serializeEntry(buf, offset, e);
					offset += this._entrySize;
				}
				for (const id of removed) {
					// Write removed entry: id + zeroed body + removed flag
					buf.writeUInt16LE(id, offset);
					// Zero fill + set removed flag at the flags position
					buf.writeUInt8(2, offset + this._entrySize - 1);
					offset += this._entrySize;
				}

				const payload = buf.subarray(0, payloadSize);
				const sig = crypto.sign(null, payload, this._signPrivate);
				sig.copy(buf, payloadSize);
				return buf.subarray(0, payloadSize + SIG_SIZE);
			};

			if (isFull) {
				for (let i = 0; i < this.numChannels; i++) {
					this.bridge.broadcastState(buildPacket(0, this._seqNumber, i), i);
				}
			} else {
				this.bridge.broadcastState(buildPacket(1, this._seqNumber, channelIdx), channelIdx);
			}
		}, 1000 / this.netRate);
	}

	// --- Internal: HTTP ---
	_startHTTPServer() {
		const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };

		const server = http.createServer(async (req, res) => {
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type");
			if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

			try {
				const url = req.url.split("?")[0];
				if (req.method === "GET" && url === "/api/config") {
					this._handleConfig(req, res);
				} else if (req.method === "POST" && url.startsWith("/api/calls/")) {
					await this._handleCallsProxy(req, res);
				} else if (req.method === "POST" && url === "/api/register") {
					await this._handleRegister(req, res);
				} else if (req.method === "POST" && url === "/api/leave") {
					await this._handleLeave(req, res);
				} else if (req.method === "GET" && url === "/api/relay-pending") {
					this._handleRelayPending(req, res);
				} else if (req.method === "POST" && url === "/api/relay-answer") {
					await this._handleRelayAnswer(req, res);
				} else if (req.method === "GET" && url.startsWith("/api/relay-answer/")) {
					this._handleGetRelayAnswer(req, res);
				} else if (req.method === "GET" && url === "/api/relay-role") {
					this._handleRelayRole(req, res);
				} else if (req.method === "GET" && this.publicDir) {
					const filePath = url === "/" ? "/index.html" : url;
					const fullPath = path.join(this.publicDir, filePath);
					const ext = path.extname(fullPath);
					try {
						const content = fs.readFileSync(fullPath);
						res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
						res.end(content);
					} catch { res.writeHead(404); res.end("Not found"); }
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

		server.listen(this.port, () => console.log(`RelayServer on port ${this.port}`));
	}

	_handleConfig(req, res) {
		if (!this.bridgeReady) {
			res.writeHead(503);
			res.end(JSON.stringify({ error: "Bridge not ready" }));
			return;
		}
		const playerId = this.nextPlayerId++;
		const inputChannelName = `input-${playerId}`;
		const assignment = this.relayTree.assignRole(playerId);

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			playerId,
			inputChannelName,
			bridgeSessionId: this.bridge.sessionId,
			signPublicKey: this._signPublicRaw.toString("base64"),
			relay: assignment,
			numChannels: this.numChannels,
			...this.appData,
		}));
	}

	async _handleCallsProxy(req, res) {
		const callsPath = req.url.replace("/api/calls", "");
		const body = await readBody(req);
		const opts = { method: "POST", headers: { Authorization: `Bearer ${this.callsAppToken}` } };
		if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = body; }
		const resp = await fetch(`${this.callsApi}${callsPath}`, opts);
		res.writeHead(resp.status, { "Content-Type": "application/json" });
		res.end(await resp.text());
	}

	async _handleRegister(req, res) {
		const body = await readBody(req);
		const { playerId, sessionId, inputChannelName, p2pOffer, capabilities } = JSON.parse(body);

		this.players.set(playerId, { sessionId, inputChannelName });
		if (capabilities) this.relayTree.updateCapabilities(playerId, capabilities);

		if (this.bridge) {
			this.bridge.subscribeToPlayerInput(sessionId, inputChannelName, playerId)
				.catch((e) => console.error("Bridge subscribe error:", e));
		}

		const node = this.relayTree.getNode(playerId);
		if (node && node.role === "leaf" && Array.isArray(p2pOffer)) {
			for (const { channel, relayId, sdp } of p2pOffer) {
				this.relayTree.storeOffer(playerId, relayId, channel, sdp);
			}
		}

		if (this._onPlayerJoin) this._onPlayerJoin(playerId);
		console.log(`Player ${playerId} registered (${node?.role || "?"})`);

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	}

	async _handleLeave(req, res) {
		const { playerId } = JSON.parse(await readBody(req));
		if (this.players.has(playerId)) {
			this._removePlayer(playerId);
			console.log(`Player ${playerId} left`);
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	}

	_handleRelayPending(req, res) {
		const url = new URL(req.url, "http://localhost");
		const offers = this.relayTree.getPendingOffers(parseInt(url.searchParams.get("relayId")));
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ offers }));
	}

	async _handleRelayAnswer(req, res) {
		const { childId, channel, answer } = JSON.parse(await readBody(req));
		this.relayTree.storeAnswer(childId, channel, answer);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	}

	_handleGetRelayAnswer(req, res) {
		const childId = parseInt(req.url.split("/").pop());
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ answers: this.relayTree.getAnswers(childId) }));
	}

	_handleRelayRole(req, res) {
		const url = new URL(req.url, "http://localhost");
		const node = this.relayTree.getNode(parseInt(url.searchParams.get("playerId")));
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ role: node?.role || "unknown", relayParentIds: node?.relayParentIds || null }));
	}
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

module.exports = { RelayServer };
