// Relay tree manager
// Assigns players as relay nodes or leaf nodes based on capability scoring.
// Relays subscribe to the SFU game-state channel and forward to children via P2P.

const RELAY_CAPACITY = 20;
const MIN_AGE_FOR_RELAY_MS = 5000;
const REBALANCE_INTERVAL_MS = 10000;

class RelayTree {
	constructor() {
		// playerId -> NodeInfo
		this.nodes = new Map();
		this.relayIds = new Set();
		setInterval(() => this.rebalance(), REBALANCE_INTERVAL_MS);
	}

	assignRole(playerId) {
		this.nodes.set(playerId, {
			role: "pending",
			relayParentId: null,
			childIds: new Set(),
			joinTime: Date.now(),
			pendingOffers: new Map(),
			pendingAnswer: null,
			// Capability scoring (updated by client on register)
			capabilities: {
				isMobile: false,
				rttMs: 999,        // RTT to SFU (lower = better relay)
				uplinkMbps: 0,     // Estimated upload bandwidth
				connectionType: "", // wifi, cellular, ethernet, unknown
			},
			relayScore: 0,
		});

		const totalPlayers = this.nodes.size;
		const idealRelayCount = Math.max(1, Math.ceil(Math.sqrt(totalPlayers)));

		if (this.relayIds.size < idealRelayCount) {
			this._promoteToRelay(playerId);
			return { role: "relay", relayParentId: null };
		}

		const relayId = this._findBestRelay();
		if (relayId !== null) {
			this._assignToRelay(playerId, relayId);
			return { role: "leaf", relayParentId: relayId };
		}

		this._promoteToRelay(playerId);
		return { role: "relay", relayParentId: null };
	}

	// Update a node's capabilities (called when client registers with metrics)
	updateCapabilities(playerId, caps) {
		const node = this.nodes.get(playerId);
		if (!node) return;
		Object.assign(node.capabilities, caps);
		node.relayScore = this._computeRelayScore(node);
	}

	// Higher score = better relay candidate
	_computeRelayScore(node) {
		let score = 0;

		// Session age: longer = more stable (0-30 points, caps at 5 min)
		const ageMs = Date.now() - node.joinTime;
		score += Math.min(30, (ageMs / 1000 / 10)); // 1pt per 10s, max 30

		// RTT: lower is better (0-30 points)
		const rtt = node.capabilities.rttMs || 999;
		score += Math.max(0, 30 - (rtt / 10)); // 30pts at 0ms, 0pts at 300ms+

		// Upload bandwidth: higher is better (0-20 points)
		const uplink = node.capabilities.uplinkMbps || 0;
		score += Math.min(20, uplink * 4); // 20pts at 5Mbps+

		// Connection type bonus
		const conn = node.capabilities.connectionType || "";
		if (conn === "ethernet") score += 15;
		else if (conn === "wifi") score += 10;
		else if (conn === "4g") score += 3;
		// cellular/unknown/2g/3g: no bonus

		// Mobile penalty: mobile clients have variable connectivity
		if (node.capabilities.isMobile) score -= 20;

		return score;
	}

	removePlayer(playerId) {
		const node = this.nodes.get(playerId);
		if (!node) return;

		if (node.role === "relay") {
			for (const childId of node.childIds) {
				const child = this.nodes.get(childId);
				if (child) {
					child.relayParentId = null;
					child.role = "orphan";
				}
			}
			this.relayIds.delete(playerId);
		} else if (node.relayParentId) {
			const parent = this.nodes.get(node.relayParentId);
			if (parent) parent.childIds.delete(playerId);
		}

		this.nodes.delete(playerId);
	}

	getNode(playerId) {
		return this.nodes.get(playerId);
	}

	storeOffer(childId, relayId, offerSdp) {
		const relay = this.nodes.get(relayId);
		if (relay) relay.pendingOffers.set(childId, offerSdp);
	}

	getPendingOffers(relayId) {
		const relay = this.nodes.get(relayId);
		if (!relay) return [];
		const offers = [];
		for (const [childId, sdp] of relay.pendingOffers) {
			offers.push({ childId, sdp });
		}
		relay.pendingOffers.clear();
		return offers;
	}

	storeAnswer(childId, answerSdp) {
		const child = this.nodes.get(childId);
		if (child) child.pendingAnswer = answerSdp;
	}

	getAnswer(childId) {
		const child = this.nodes.get(childId);
		if (!child || !child.pendingAnswer) return null;
		const answer = child.pendingAnswer;
		child.pendingAnswer = null;
		return answer;
	}

	_promoteToRelay(playerId) {
		const node = this.nodes.get(playerId);
		if (!node) return;
		node.role = "relay";
		node.relayParentId = null;
		this.relayIds.add(playerId);
	}

	_assignToRelay(playerId, relayId) {
		const node = this.nodes.get(playerId);
		const relay = this.nodes.get(relayId);
		if (!node || !relay) return;
		node.role = "leaf";
		node.relayParentId = relayId;
		relay.childIds.add(playerId);
	}

	_findBestRelay() {
		let best = null;
		let bestCount = Infinity;
		for (const relayId of this.relayIds) {
			const relay = this.nodes.get(relayId);
			if (!relay) continue;
			if (relay.childIds.size < RELAY_CAPACITY && relay.childIds.size < bestCount) {
				best = relayId;
				bestCount = relay.childIds.size;
			}
		}
		return best;
	}

	rebalance() {
		const total = this.nodes.size;
		if (total === 0) return;

		const idealRelayCount = Math.max(1, Math.ceil(Math.sqrt(total)));

		// Check if any current relay should be demoted (low score, mobile came online)
		// and if any leaf has a much better score
		if (this.relayIds.size >= idealRelayCount) {
			this._maybeSwapRelays();
		}

		// Promote more relays if needed (pick highest scoring candidates)
		if (this.relayIds.size < idealRelayCount) {
			const now = Date.now();
			const candidates = [];
			for (const [id, node] of this.nodes) {
				if (
					node.role !== "relay" &&
					(now - node.joinTime) > MIN_AGE_FOR_RELAY_MS
				) {
					candidates.push({ id, score: node.relayScore });
				}
			}
			// Best candidates first
			candidates.sort((a, b) => b.score - a.score);

			for (const c of candidates) {
				if (this.relayIds.size >= idealRelayCount) break;
				const node = this.nodes.get(c.id);
				if (node.relayParentId) {
					const oldRelay = this.nodes.get(node.relayParentId);
					if (oldRelay) oldRelay.childIds.delete(c.id);
				}
				this._promoteToRelay(c.id);
			}
		}

		// Reassign orphaned/unassigned leaf nodes
		for (const [id, node] of this.nodes) {
			if (node.role === "orphan" || (node.role === "leaf" && !node.relayParentId)) {
				const relayId = this._findBestRelay();
				if (relayId && relayId !== id) {
					this._assignToRelay(id, relayId);
				}
			}
		}
	}

	// Swap a low-scoring relay with a high-scoring leaf if the difference is large
	_maybeSwapRelays() {
		let worstRelay = null;
		let worstScore = Infinity;
		for (const relayId of this.relayIds) {
			const node = this.nodes.get(relayId);
			if (node && node.relayScore < worstScore) {
				worstRelay = relayId;
				worstScore = node.relayScore;
			}
		}

		let bestLeaf = null;
		let bestScore = -Infinity;
		const now = Date.now();
		for (const [id, node] of this.nodes) {
			if (
				node.role === "leaf" &&
				(now - node.joinTime) > MIN_AGE_FOR_RELAY_MS &&
				node.relayScore > bestScore
			) {
				bestLeaf = id;
				bestScore = node.relayScore;
			}
		}

		// Only swap if the leaf is significantly better (>20 points)
		if (worstRelay && bestLeaf && bestScore - worstScore > 20) {
			console.log(
				`Relay swap: demoting ${worstRelay} (score ${worstScore.toFixed(0)}) ` +
				`for ${bestLeaf} (score ${bestScore.toFixed(0)})`
			);

			// Demote the relay — orphan its children
			const oldRelay = this.nodes.get(worstRelay);
			for (const childId of oldRelay.childIds) {
				const child = this.nodes.get(childId);
				if (child) {
					child.relayParentId = null;
					child.role = "orphan";
				}
			}
			oldRelay.childIds.clear();
			oldRelay.role = "orphan";
			this.relayIds.delete(worstRelay);

			// Promote the leaf
			const newRelay = this.nodes.get(bestLeaf);
			if (newRelay.relayParentId) {
				const parent = this.nodes.get(newRelay.relayParentId);
				if (parent) parent.childIds.delete(bestLeaf);
			}
			this._promoteToRelay(bestLeaf);
		}
	}

	getStats() {
		return {
			total: this.nodes.size,
			relays: this.relayIds.size,
			leaves: this.nodes.size - this.relayIds.size,
		};
	}
}

module.exports = { RelayTree };
