// Relay tree manager
// Assigns players as relay nodes or leaf nodes based on capability scoring.
// Relays subscribe to the SFU game-state channel and forward to children via P2P.

const NUM_CHANNELS = 3; // A, B, C
const RELAY_CAPACITY = 20; // Max children per relay per channel
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
			// For leaves: 3 relay parents (one per channel). null = unassigned.
			relayParentIds: [null, null, null],
			// For relays: children per channel
			childIds: [new Set(), new Set(), new Set()],
			joinTime: Date.now(),
			pendingOffers: new Map(), // childId -> offer SDP
			pendingAnswer: null,
			capabilities: {
				isMobile: false,
				rttMs: 999,
				uplinkMbps: 0,
				connectionType: "",
			},
			relayScore: 0,
		});

		const totalPlayers = this.nodes.size;
		const idealRelayCount = Math.max(1, Math.ceil(Math.sqrt(totalPlayers)));

		if (this.relayIds.size < idealRelayCount) {
			this._promoteToRelay(playerId);
			return { role: "relay", relayParentIds: [null, null, null] };
		}

		// Assign to 3 different relays (one per channel), preferring diversity
		const relayParentIds = [null, null, null];
		const usedRelays = new Set();
		for (let ch = 0; ch < NUM_CHANNELS; ch++) {
			const relayId = this._findBestRelayForChannel(ch, usedRelays);
			if (relayId !== null) {
				relayParentIds[ch] = relayId;
				usedRelays.add(relayId);
				this._assignToRelayChannel(playerId, relayId, ch);
			}
		}

		const node = this.nodes.get(playerId);
		node.role = "leaf";
		node.relayParentIds = relayParentIds;

		// If no relays available at all, become a relay
		if (relayParentIds.every((id) => id === null)) {
			this._promoteToRelay(playerId);
			return { role: "relay", relayParentIds: [null, null, null] };
		}

		return { role: "leaf", relayParentIds };
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
			// Orphan children on all channels this relay served
			for (let ch = 0; ch < NUM_CHANNELS; ch++) {
				for (const childId of node.childIds[ch]) {
					const child = this.nodes.get(childId);
					if (child) {
						child.relayParentIds[ch] = null;
						// Mark as orphan only if ALL channels lost
						if (child.relayParentIds.every((id) => id === null)) {
							child.role = "orphan";
						}
					}
				}
			}
			this.relayIds.delete(playerId);
		} else {
			// Remove leaf from its relay parents
			for (let ch = 0; ch < NUM_CHANNELS; ch++) {
				const parentId = node.relayParentIds[ch];
				if (parentId) {
					const parent = this.nodes.get(parentId);
					if (parent) parent.childIds[ch].delete(playerId);
				}
			}
		}

		this.nodes.delete(playerId);
	}

	getNode(playerId) {
		return this.nodes.get(playerId);
	}

	// Store a P2P offer from a leaf, keyed by relay+channel
	storeOffer(childId, relayId, channel, offerSdp) {
		const relay = this.nodes.get(relayId);
		if (relay) relay.pendingOffers.set(`${childId}:${channel}`, { childId, channel, sdp: offerSdp });
	}

	getPendingOffers(relayId) {
		const relay = this.nodes.get(relayId);
		if (!relay) return [];
		const offers = Array.from(relay.pendingOffers.values());
		relay.pendingOffers.clear();
		return offers;
	}

	// Answers keyed by childId:channel
	storeAnswer(childId, channel, answerSdp) {
		const child = this.nodes.get(childId);
		if (child) {
			if (!child.pendingAnswers) child.pendingAnswers = new Map();
			child.pendingAnswers.set(channel, answerSdp);
		}
	}

	getAnswers(childId) {
		const child = this.nodes.get(childId);
		if (!child || !child.pendingAnswers || child.pendingAnswers.size === 0) return [];
		const answers = [];
		for (const [channel, sdp] of child.pendingAnswers) {
			answers.push({ channel, sdp });
		}
		child.pendingAnswers.clear();
		return answers;
	}

	_promoteToRelay(playerId) {
		const node = this.nodes.get(playerId);
		if (!node) return;
		node.role = "relay";
		node.relayParentIds = [null, null, null];
		// Remove from any relay parents
		for (let ch = 0; ch < NUM_CHANNELS; ch++) {
			const parentId = node.relayParentIds[ch];
			if (parentId) {
				const parent = this.nodes.get(parentId);
				if (parent) parent.childIds[ch].delete(playerId);
			}
		}
		this.relayIds.add(playerId);
	}

	_assignToRelayChannel(playerId, relayId, channel) {
		const relay = this.nodes.get(relayId);
		if (relay) relay.childIds[channel].add(playerId);
	}

	// Find relay with fewest children on a specific channel, excluding already-used relays
	_findBestRelayForChannel(channel, excludeSet) {
		let best = null;
		let bestCount = Infinity;
		for (const relayId of this.relayIds) {
			if (excludeSet && excludeSet.has(relayId)) continue;
			const relay = this.nodes.get(relayId);
			if (!relay) continue;
			const count = relay.childIds[channel].size;
			if (count < RELAY_CAPACITY && count < bestCount) {
				best = relayId;
				bestCount = count;
			}
		}
		return best;
	}

	rebalance() {
		const total = this.nodes.size;
		if (total === 0) return;

		const idealRelayCount = Math.max(1, Math.ceil(Math.sqrt(total)));

		if (this.relayIds.size >= idealRelayCount) {
			this._maybeSwapRelays();
		}

		// Promote more relays if needed
		if (this.relayIds.size < idealRelayCount) {
			const now = Date.now();
			const candidates = [];
			for (const [id, node] of this.nodes) {
				if (node.role !== "relay" && (now - node.joinTime) > MIN_AGE_FOR_RELAY_MS) {
					candidates.push({ id, score: node.relayScore });
				}
			}
			candidates.sort((a, b) => b.score - a.score);
			for (const c of candidates) {
				if (this.relayIds.size >= idealRelayCount) break;
				this._promoteToRelay(c.id);
			}
		}

		// Reassign leaves with missing relay channels
		for (const [id, node] of this.nodes) {
			if (node.role !== "leaf" && node.role !== "orphan") continue;
			let changed = false;
			const usedRelays = new Set(node.relayParentIds.filter(Boolean));
			for (let ch = 0; ch < NUM_CHANNELS; ch++) {
				if (node.relayParentIds[ch] === null) {
					const relayId = this._findBestRelayForChannel(ch, usedRelays);
					if (relayId && relayId !== id) {
						node.relayParentIds[ch] = relayId;
						this._assignToRelayChannel(id, relayId, ch);
						usedRelays.add(relayId);
						changed = true;
					}
				}
			}
			if (changed && node.role === "orphan") node.role = "leaf";
		}
	}

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
			if (node.role === "leaf" && (now - node.joinTime) > MIN_AGE_FOR_RELAY_MS && node.relayScore > bestScore) {
				bestLeaf = id;
				bestScore = node.relayScore;
			}
		}

		if (worstRelay && bestLeaf && bestScore - worstScore > 20) {
			console.log(`Relay swap: ${worstRelay} (${worstScore.toFixed(0)}) → ${bestLeaf} (${bestScore.toFixed(0)})`);

			const oldRelay = this.nodes.get(worstRelay);
			for (let ch = 0; ch < NUM_CHANNELS; ch++) {
				for (const childId of oldRelay.childIds[ch]) {
					const child = this.nodes.get(childId);
					if (child) child.relayParentIds[ch] = null;
				}
				oldRelay.childIds[ch].clear();
			}
			oldRelay.role = "orphan";
			this.relayIds.delete(worstRelay);

			this._promoteToRelay(bestLeaf);
		}
	}

	getStats() {
		let totalChildren = 0;
		for (const relayId of this.relayIds) {
			const node = this.nodes.get(relayId);
			if (node) {
				for (let ch = 0; ch < NUM_CHANNELS; ch++) {
					totalChildren += node.childIds[ch].size;
				}
			}
		}
		return {
			total: this.nodes.size,
			relays: this.relayIds.size,
			leaves: this.nodes.size - this.relayIds.size,
			totalRelayLinks: totalChildren, // Each leaf has up to 3 links
		};
	}
}

module.exports = { RelayTree };
