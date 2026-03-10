const path = require("path");
// In Docker: relay-lib is at /app/relay-lib/. Locally: at ../../relay-lib/
const { RelayServer } = require(
	require("fs").existsSync("/app/relay-lib") ? "/app/relay-lib/server" : "../../relay-lib/server"
);
const { GameWorld } = require("./physics");
const { MAP } = require("./map");

const TICK_RATE = 45;
const PLAYER_SIZE = 11; // id(2) + x(4) + y(4) + flags(1)

const world = new GameWorld(MAP);

const relay = new RelayServer({
	callsAppId: process.env.CALLS_APP_ID,
	callsAppToken: process.env.CALLS_APP_TOKEN,
	port: 8080,
	netRate: 15,
	numChannels: 3,
	fullSnapshotSec: 3,
	playerTimeoutMs: 60000,
	publicDir: path.resolve(__dirname, "../../public"),
	appData: { map: MAP },
});

// --- Physics tick (45hz, decoupled from network) ---
setInterval(() => {
	if (!relay.bridgeReady) return;
	world.tick(1 / TICK_RATE);
}, 1000 / TICK_RATE);

// --- Wire up game events ---
relay.onPlayerJoin((playerId) => {
	world.addPlayer(playerId);
});

relay.onPlayerInput((playerId, data) => {
	// Input is handled by the bridge internally (updates playerInputs map)
	// The physics reads it via bridge.getInput(playerId)
});

relay.onPlayerLeave((playerId) => {
	world.removePlayer(playerId);
});

relay.onPlayerTimeout((playerId) => {
	world.removePlayer(playerId);
});

// --- Configure state broadcasting ---
relay.configureState({
	getEntries: () => world.getPlayers(),

	serialize: (buf, offset, p) => {
		buf.writeUInt16LE(p.id, offset);
		buf.writeFloatLE(p.x, offset + 2);
		buf.writeFloatLE(p.y, offset + 6);
		buf.writeUInt8(p.grounded ? 1 : 0, offset + 10);
	},

	entrySize: PLAYER_SIZE,

	getPosition: (p) => ({ x: p.x, y: p.y }),

	getFlags: (p) => (p.grounded ? 1 : 0),

	threshold: 0.3,
});

// --- Start ---
relay.start().then(() => {
	console.log("Platformer server ready");
}).catch((err) => {
	console.error("Failed to start:", err);
});
