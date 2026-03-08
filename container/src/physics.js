const GRAVITY = 1800; // pixels/s^2
const MOVE_SPEED = 300; // pixels/s
const JUMP_VELOCITY = -600; // pixels/s (upward)
const PLAYER_RADIUS = 12;
const MAX_FALL_SPEED = 900;

// Input bit flags (must match client)
const INPUT_LEFT = 1;
const INPUT_RIGHT = 2;
const INPUT_JUMP = 4;

class GameWorld {
	constructor(map) {
		this.platforms = map.platforms;
		this.spawnX = map.spawn.x;
		this.spawnY = map.spawn.y;
		// playerId -> { id, x, y, vx, vy, grounded }
		this.players = new Map();
		// Reference to bridge (set externally)
		this.bridge = null;
	}

	setBridge(bridge) {
		this.bridge = bridge;
	}

	addPlayer(id) {
		this.players.set(id, {
			id,
			x: this.spawnX,
			y: this.spawnY,
			vx: 0,
			vy: 0,
			grounded: false,
		});
	}

	removePlayer(id) {
		this.players.delete(id);
	}

	getPlayers() {
		return Array.from(this.players.values());
	}

	tick(dt) {
		for (const [id, p] of this.players) {
			const input = this.bridge ? this.bridge.getInput(id) : 0;

			// Horizontal movement
			p.vx = 0;
			if (input & INPUT_LEFT) p.vx = -MOVE_SPEED;
			if (input & INPUT_RIGHT) p.vx = MOVE_SPEED;

			// Jump
			if ((input & INPUT_JUMP) && p.grounded) {
				p.vy = JUMP_VELOCITY;
				p.grounded = false;
			}

			// Gravity
			if (!p.grounded) {
				p.vy += GRAVITY * dt;
				if (p.vy > MAX_FALL_SPEED) p.vy = MAX_FALL_SPEED;
			}

			// Move
			p.x += p.vx * dt;
			p.y += p.vy * dt;

			// Collision with platforms
			p.grounded = false;
			for (const plat of this.platforms) {
				this._resolveCollision(p, plat);
			}

			// Death plane — respawn if fallen off the map
			if (p.y > 2000) {
				p.x = this.spawnX;
				p.y = this.spawnY;
				p.vx = 0;
				p.vy = 0;
			}
		}
	}

	_resolveCollision(player, plat) {
		// Circle vs AABB collision
		const r = PLAYER_RADIUS;
		const px = player.x;
		const py = player.y;

		// Find closest point on AABB to circle center
		const closestX = Math.max(plat.x, Math.min(px, plat.x + plat.w));
		const closestY = Math.max(plat.y, Math.min(py, plat.y + plat.h));

		const dx = px - closestX;
		const dy = py - closestY;
		const distSq = dx * dx + dy * dy;

		if (distSq >= r * r) return; // No collision

		const dist = Math.sqrt(distSq);
		if (dist === 0) {
			// Center is inside the platform — push up
			player.y = plat.y - r;
			player.vy = 0;
			player.grounded = true;
			return;
		}

		// Push player out along the collision normal
		const overlap = r - dist;
		const nx = dx / dist;
		const ny = dy / dist;

		player.x += nx * overlap;
		player.y += ny * overlap;

		// Determine which face was hit
		if (ny < -0.5) {
			// Hit top of platform (landing)
			player.vy = 0;
			player.grounded = true;
		} else if (ny > 0.5) {
			// Hit bottom of platform (bonk head)
			player.vy = Math.max(0, player.vy);
		}

		// Horizontal collision — stop horizontal velocity
		if (Math.abs(nx) > 0.7) {
			player.vx = 0;
		}
	}
}

module.exports = { GameWorld, PLAYER_RADIUS };
