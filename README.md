# Massive Platformer

A massively multiplayer 2D side-scrolling platformer where hundreds of players appear as colored circles traversing a shared challenge map in real time. Built entirely on Cloudflare's infrastructure.

**Live demo:** [massive-platformer.makeshifted.workers.dev](https://massive-platformer.makeshifted.workers.dev)

## Architecture

```
                          Cloudflare Network
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Worker (edge)            Container (Firecracker VM)         │
│  ┌──────────────┐        ┌──────────────────────────────┐    │
│  │ Routes /api/* ├───────►│ Node.js game server          │    │
│  │ Serves static │        │ ┌────────┐ ┌──────┐ ┌─────┐ │    │
│  └──────────────┘        │ │Physics │ │Bridge│ │Relay│ │    │
│                           │ │ 45hz   │ │(SFU) │ │Tree │ │    │
│                           │ └────────┘ └──┬───┘ └─────┘ │    │
│                           └───────────────┼─────────────┘    │
│                                           │                  │
│                        Realtime SFU       │                  │
│                        ┌──────────────────┴──────┐           │
│                        │  Anycast WebRTC CDN     │           │
│                        └──┬──────────────┬───┬──┘           │
│                           │              │   │               │
└───────────────────────────┼──────────────┼───┼───────────────┘
                            │              │   │
                      Relay nodes    (input channels)
                       ┌────┴────┐         │
                   P2P │  Direct │ P2P     │
                   ┌───┘  WebRTC └───┐     │
                   │                 │     │
              Leaf players     Leaf players
```

### How it works

1. **Player connects**: Browser creates a WebRTC PeerConnection to Cloudflare's Realtime SFU. All players publish input (1 byte) via SFU data channels to the bridge.

2. **Physics runs centrally**: The game server runs server-authoritative physics at 45hz — gravity, movement, platform collision for every player.

3. **State fans out via 3-channel P2P relay tree**: The bridge publishes delta-compressed state at 15hz, split across 3 SFU data channels (A/B/C, 5hz each, staggered). Each leaf node connects to **3 different relay nodes** (one per channel) via direct P2P WebRTC. If any single relay dies, the leaf still receives 10hz from the other two — no gap, no SFU fallback needed.

4. **Automatic fallback and self-healing**: Leaf nodes with missing P2P channels fall back to the SFU for those channels. The relay tree rebalances every 10 seconds, replacing lost relays and reassigning orphaned leaves. Full snapshots go to all 3 channels simultaneously for loss recovery.

### Why this architecture

The core insight is **separating the data plane from the compute plane**.

Traditional multiplayer game servers handle both game logic AND network I/O. Every connected player is a socket the server must manage — read from, write to, keep alive. This creates a hard coupling between player count and server complexity. WebSocket servers top out at ~10K-50K connections per instance, and each connection consumes memory and CPU for I/O operations.

This architecture decouples them:

- **Compute** (the Container): Only runs game logic. Sees exactly one network connection — a single WebRTC PeerConnection to the SFU. Whether there are 10 or 10,000 players, the bridge sends the same 50 state packets per second on one connection.

- **Fanout** (the SFU): Handles all the per-player connections. Cloudflare's Realtime SFU is a globally distributed anycast WebRTC CDN. Each player connects to the nearest edge node. The SFU builds a cascading tree per data channel — the root node (nearest to the bridge) fans out to intermediate nodes, which fan out to edge nodes. Packet loss recovery (NACK) happens locally at each hop.

The game server doesn't know or care about individual player connections. It's just a physics engine with a single fat pipe.

### Cost structure

This is where it gets interesting. The architecture inverts the typical cost model.

**Traditional server**: You pay for compute proportional to connections. More players = more servers = more cost, even if most players are idle.

**This architecture**: Compute cost is nearly fixed (one container running physics). The variable cost is **data egress through the SFU** — and only for data that actually changes.

| Component | Cost driver | Scaling behavior |
|-----------|------------|------------------|
| Container | CPU time at 45hz | ~Fixed regardless of player count |
| SFU ingress | Bridge → SFU (1 stream) | Free (Cloudflare doesn't charge ingress) |
| SFU egress | SFU → relay nodes only | √N scaling (not linear) thanks to P2P relay tree |
| P2P relay | Relay → leaf players | Free (direct WebRTC, no SFU) |
| Calls API | Session management | Only at join/leave, not during gameplay |

**SFU egress scales with √N, not N.** The P2P relay tree means only √N relay nodes subscribe to the SFU. Each relay forwards state to ~√N leaf players over direct P2P WebRTC connections that don't touch the SFU.

#### Example: 500 concurrent players

| Item | Calculation | Monthly cost |
|------|------------|--------------|
| Container (lite) | 256MB, 1/16 vCPU, 24/7 | ~$7 |
| SFU egress (no relay) | 500 subs × ~1.7KB × 15hz | ~$6,500 |
| **SFU egress (with relay)** | **~22 relay subs × ~1.7KB × 15hz** | **~$290** |
| P2P relay bandwidth | ~37 KB/s upload per relay node | Free (peer-to-peer) |

The P2P relay tree reduces SFU egress by **~95%**. Each relay node contributes ~37 KB/s of upload bandwidth — invisible on any broadband connection. Leaf nodes that lose their relay fall back to the SFU temporarily (full snapshots every 3 seconds provide recovery).

#### Comparison to traditional hosting

A traditional game server at 500 players would need careful WebSocket management, likely multiple server instances with load balancing, sticky sessions, and state synchronization between instances. Cost: $50-200/month for compute, but engineering complexity is high.

This architecture: one container, one connection, √N SFU egress, zero connection management. The SFU is a managed service — you don't operate it, scale it, or think about it.

## Binary protocol

### Input (player → server): 1 byte
```
Bit 0: left
Bit 1: right
Bit 2: jump
```
Only sent when input state changes. 1 byte per input event.

### State (server → all players): signed, sequenced, delta-compressed

```
[type:u8] [seq:u8] [count:u16] [..players] [signature:64B]

type 0 = full snapshot (resets seq to 0)
type 1 = delta (only changed players since last broadcast)
seq  = 0-255, increments each delta, resets to 0 on full snapshot

Per player entry (11 bytes):
  [id:u16] [x:f32] [y:f32] [flags:u8]

flags:
  bit 0 = grounded
  bit 1 = removed (player disconnected)

signature: Ed25519 over the payload (everything before the 64-byte signature)
```

**Sequencing**: Deltas are numbered relative to the last full snapshot. Clients discard deltas with stale sequence numbers (out-of-order arrivals on unreliable channels). Full snapshots reset the counter, ensuring recovery.

**Signing**: Every packet is Ed25519-signed by the server. Relay nodes forward packets verbatim — they cannot forge or modify state without invalidating the signature. Clients receiving data via P2P verify the signature before applying. The signing public key is distributed via `/api/config`.

**Relay selection**: The server scores each player's suitability as a relay based on session age (stability), RTT to SFU (latency), upload bandwidth, connection type (ethernet > wifi > cellular), and mobile vs desktop. The tree rebalances every 10 seconds, swapping low-scoring relays for high-scoring leaves.

Physics runs at 45hz server-side (3x the network rate). Network broadcasts at 15hz — exactly one broadcast every 3 physics ticks. Full snapshots every 3 seconds. Delta ticks only include players whose position changed by >0.3px. Stationary players cost zero bandwidth between snapshots.

## Setup

### Prerequisites
- Node.js 22+
- Docker
- Wrangler CLI (`npm install -g wrangler`)
- A Cloudflare account with Workers Paid plan
- A Cloudflare Calls app (create at [dash.cloudflare.com](https://dash.cloudflare.com/?to=/:account/calls))

### Configuration

Set your Calls app credentials in `wrangler.toml`:
```toml
[vars]
CALLS_APP_ID = "your-app-id"
CALLS_APP_TOKEN = "your-app-token"
```

### Local development

```bash
# Install dependencies
npm install
cd container && npm install && cd ..

# Run the game server locally
cd container
CALLS_APP_ID="..." CALLS_APP_TOKEN="..." node src/server.js
# Open http://localhost:8080
```

### Deploy to Cloudflare

```bash
# Full deploy (builds container, pushes to registry, deploys Worker)
./deploy.sh

# Deploy only Worker + static assets (skip container rebuild)
./deploy.sh --skip-container
```

The deploy script handles the full pipeline:
1. Injects a cache-bust ARG into the Dockerfile (wrangler's Docker cache is aggressive)
2. Uses wrangler's Dockerfile path so it handles registry auth automatically (Docker registry tokens expire quickly)
3. Bumps the DO instance name (container DOs are sticky to old images — changing the name forces a fresh instance)
4. Runs `wrangler deploy` (builds, pushes, deploys in one step)
5. Cleans up the cache-bust ARG

## Project structure

```
├── src/
│   └── worker.ts              # Cloudflare Worker — routes to container
├── container/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── server.js          # HTTP server, physics tick, signaling
│       ├── bridge.js          # WebRTC bridge (node-datachannel ↔ SFU)
│       ├── relay-tree.js      # P2P relay tree manager (role assignment, signaling)
│       ├── physics.js         # Platformer physics (circle vs AABB)
│       └── map.js             # Level definition
├── public/
│   ├── index.html             # Game shell + touch controls
│   └── game.js                # Client (Canvas + WebRTC)
├── wrangler.toml              # Cloudflare deployment config
├── deploy.sh                  # Build, push, deploy pipeline
└── README.md
```

## Security: Calls API token

Cloudflare's Realtime SFU API uses a single app-level bearer token for all operations — session creation, track management, data channels. There are no scoped or per-session tokens. Cloudflare's [recommended architecture](https://developers.cloudflare.com/realtime/sfu/https-api/) is three-tier: clients call your backend, your backend calls the Calls API with the token.

This project proxies all Calls API requests through the game server (`/api/calls/*`), keeping the token server-side. The client never sees the token. The proxy adds one HTTP hop per API call, which is acceptable since API calls only happen during join (not during gameplay — data flows over WebRTC after setup).

The proxy approach also lets the server validate and rate-limit requests — for example, ensuring a client can only create one session, or only subscribe to the game-state channel.

## Key technical discoveries

**Cloudflare Calls API quirks:**
- `/sessions/new` without a body creates a session; with `sessionDescription` it creates + exchanges SDP in one call
- `/datachannels/establish` does not work — use `/sessions/new` with SDP or `/tracks/new` with `autoDiscover: true`
- Subscribe + `createDataChannel({negotiated: true})` must happen atomically in the same microtask, or the subscription stays inactive (confirmed with node-datachannel; browser behavior may differ)

**Cloudflare Containers:**
- Run on Firecracker microVMs — full Linux kernel, native addons work
- UDP outbound works (confirmed: WebRTC connects from container to SFU)
- Environment variables must be set via `this.envVars =` in the Container class constructor
- DO names are sticky to container instances — change the name to force a fresh instance after image updates

## License

MIT
