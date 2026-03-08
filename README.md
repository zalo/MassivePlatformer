# Massive Platformer

A massively multiplayer 2D side-scrolling platformer where hundreds of players appear as colored circles traversing a shared challenge map in real time. Built entirely on Cloudflare's infrastructure.

**Live demo:** [massive-platformer.makeshifted.workers.dev](https://massive-platformer.makeshifted.workers.dev)

## Architecture

```
                          Cloudflare Network
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   Worker (edge)           Container (Firecracker VM)    │
│   ┌──────────────┐       ┌──────────────────────────┐   │
│   │ Routes /api/* ├──────►│ Node.js game server      │   │
│   │ Serves static │       │ ┌──────────┐ ┌────────┐ │   │
│   └──────────────┘       │ │ Physics  │ │ Bridge │ │   │
│                          │ │  50hz    │ │ (WebRTC)│ │   │
│                          │ └──────────┘ └───┬────┘ │   │
│                          └──────────────────┼──────┘   │
│                                             │          │
│                          Realtime SFU       │          │
│                          ┌──────────────────┴──────┐   │
│                          │  Anycast WebRTC CDN     │   │
│                          │  330+ edge locations    │   │
│                          │  Cascading tree fanout  │   │
│                          └────┬───┬───┬───┬───┬──┘   │
│                               │   │   │   │   │      │
└───────────────────────────────┼───┼───┼───┼───┼──────┘
                                │   │   │   │   │
                          Players (browsers, mobile)
```

### How it works

1. **Player connects**: Browser creates a WebRTC PeerConnection to Cloudflare's Realtime SFU (Selective Forwarding Unit). No connection to the game server — just the SFU.

2. **Input flows up**: Player keyboard/touch input (1 byte) travels through an unreliable WebRTC data channel to the SFU, which forwards it to the bridge's subscription.

3. **Physics runs centrally**: The game server in the Cloudflare Container runs server-authoritative physics at 50hz — gravity, movement, platform collision for every player.

4. **State fans out**: The bridge publishes a compact binary state update on a single data channel. The SFU's cascading tree architecture replicates it to every connected player. The bridge sends one copy; the SFU handles thousands.

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
| Container | CPU time at 50hz | ~Fixed regardless of player count |
| SFU ingress | Bridge → SFU (1 stream) | Free (Cloudflare doesn't charge ingress) |
| SFU egress | SFU → all players | Linear with player count, but per-byte |
| Calls API | Session management | Only at join/leave, not during gameplay |

**The SFU egress is the only meaningful variable cost**, at $0.05/GB after 1TB free/month. And it's proportional to *data sent*, not connections held. Delta compression means stationary players cost zero egress.

#### Example: 500 concurrent players

| Item | Calculation | Monthly cost |
|------|------------|--------------|
| Container (lite) | 256MB, 1/16 vCPU, 24/7 | ~$7 |
| SFU egress | ~50 MB/s × 86400s × 30d | ~$6,500 |
| With delta compression | ~80% stationary at any time | ~$1,300 |
| With spatial culling | Send only ~50 nearby players | ~$130 |

The container is a rounding error. SFU egress dominates but responds directly to optimization — every byte you shave from the state packet multiplies across every player every tick.

#### Comparison to traditional hosting

A traditional game server at 500 players would need careful WebSocket management, likely multiple server instances with load balancing, sticky sessions, and state synchronization between instances. Cost: $50-200/month for compute, but engineering complexity is high.

This architecture: one container, one connection, linear egress cost, zero connection management. The SFU is a managed service — you don't operate it, scale it, or think about it.

## Binary protocol

### Input (player → server): 1 byte
```
Bit 0: left
Bit 1: right
Bit 2: jump
```
Only sent when input state changes. 1 byte per input event.

### State (server → all players): delta-compressed

```
[type:u8] [count:u16] [..players]

type 0 = full snapshot (all players, sent every ~1 second)
type 1 = delta (only changed players since last tick)

Per player entry (11 bytes):
  [id:u16] [x:f32] [y:f32] [flags:u8]

flags:
  bit 0 = grounded
  bit 1 = removed (player disconnected)
```

Full snapshots ensure clients recover from packet loss. Delta ticks only include players whose position changed by more than 0.3px since last sent. Stationary players cost zero bandwidth between snapshots.

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
# Build and push container image
cd container
docker build --no-cache -t game-server .
REGISTRY="registry.cloudflare.com/<account-id>/massive-platformer-gamecontainer"
TAG="v$(date +%s)"
docker tag game-server "$REGISTRY:$TAG"
docker push "$REGISTRY:$TAG"

# Update wrangler.toml with the image tag, then deploy
wrangler deploy
```

Note: After deploying a new container image, bump the DO name in `src/worker.ts` to ensure a fresh container instance picks up the new image.

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
│       ├── physics.js         # Platformer physics (circle vs AABB)
│       └── map.js             # Level definition
├── public/
│   ├── index.html             # Game shell + touch controls
│   └── game.js                # Client (Canvas + WebRTC)
├── wrangler.toml              # Cloudflare deployment config
└── README.md
```

## Key technical discoveries

**Cloudflare Calls API quirks:**
- `/sessions/new` without a body creates a session; with `sessionDescription` it creates + exchanges SDP in one call
- `/datachannels/establish` does not work — use `/sessions/new` with SDP or `/tracks/new` with `autoDiscover: true`
- Subscribe + `createDataChannel({negotiated: true})` must happen atomically in the same microtask, or the subscription stays inactive

**Cloudflare Containers:**
- Run on Firecracker microVMs — full Linux kernel, native addons work
- UDP outbound works (confirmed: WebRTC connects from container to SFU)
- Environment variables must be set via `this.envVars =` in the Container class constructor
- DO names are sticky to container instances — change the name to force a fresh instance after image updates

## License

MIT
