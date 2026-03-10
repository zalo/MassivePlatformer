// Relay tree manager
// Assigns players as relay nodes or leaf nodes.
// Relays subscribe to the SFU game-state channel and forward to children via P2P.
// Leaves receive state only from their relay parent.

const RELAY_CAPACITY = 20; // Max children per relay
const MIN_AGE_FOR_RELAY_MS = 5000; // Must be connected 5s before eligible as relay
const REBALANCE_INTERVAL_MS = 10000;

class RelayTree {
	constructor() {
		// playerId -> { role: 'relay'|'leaf', relayParentId, childIds, joinTime,
		//               pendingOffer, pendingAnswer, p2pConnected }
		this.nodes = new Map();
		this.relayIds = new Set();

		// Periodic rebalance
		setInterval(() => this.rebalance(), REBALANCE_INTERVAL_MS);
	}

	// Assign a role when a player joins
	assignRole(playerId) {
		const now = Date.now();
		this.nodes.set(playerId, {
			role: "pending",
			relayParentId: null,
			childIds: new Set(),
			joinTime: now,
			pendingOffers: new Map(), // childId -> offer SDP
			pendingAnswers: new Map(), // childId -> answer SDP
		});

		// Decide: relay or leaf?
		const totalPlayers = this.nodes.size;
		const idealRelayCount = Math.max(1, Math.ceil(Math.sqrt(totalPlayers)));

		if (this.relayIds.size < idealRelayCount) {
			// Need more relays — this player becomes one
			this._promoteToRelay(playerId);
			return { role: "relay", relayParentId: null };
		}

		// Assign as leaf to the relay with fewest children
		const relayId = this._findBestRelay();
		if (relayId !== null) {
			this._assignToRelay(playerId, relayId);
			return { role: "leaf", relayParentId: relayId };
		}

		// No relay available — become a relay yourself
		this._promoteToRelay(playerId);
		return { role: "relay", relayParentId: null };
	}

	removePlayer(playerId) {
		const node = this.nodes.get(playerId);
		if (!node) return;

		if (node.role === "relay") {
			// Orphan children — they'll reconnect via SFU fallback
			// and get reassigned on next rebalance
			for (const childId of node.childIds) {
				const child = this.nodes.get(childId);
				if (child) {
					child.relayParentId = null;
					child.role = "orphan"; // Triggers SFU fallback on client
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

	// Store a P2P offer from a leaf for its relay to pick up
	storeOffer(childId, relayId, offerSdp) {
		const relay = this.nodes.get(relayId);
		if (relay) {
			relay.pendingOffers.set(childId, offerSdp);
		}
	}

	// Relay picks up pending offers
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

	// Store a P2P answer from relay for a child to pick up
	storeAnswer(childId, answerSdp) {
		const child = this.nodes.get(childId);
		if (child) {
			child.pendingAnswer = answerSdp;
		}
	}

	// Child picks up answer
	getAnswer(childId) {
		const child = this.nodes.get(childId);
		if (!child || !child.pendingAnswer) return null;
		const answer = child.pendingAnswer;
		child.pendingAnswer = null;
		return answer;
	}

	// Mark a child as P2P connected
	markConnected(childId) {
		const child = this.nodes.get(childId);
		if (child) child.p2pConnected = true;
	}

	_promoteToRelay(playerId) {
		const node = this.nodes.get(playerId);
		if (!node) return;
		node.role = "relay";
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

		// Promote more relays if needed
		if (this.relayIds.size < idealRelayCount) {
			const now = Date.now();
			// Find orphans or leaves that could be relays (oldest first)
			const candidates = [];
			for (const [id, node] of this.nodes) {
				if (node.role === "leaf" && (now - node.joinTime) > MIN_AGE_FOR_RELAY_MS) {
					candidates.push({ id, age: now - node.joinTime });
				}
			}
			candidates.sort((a, b) => b.age - a.age);

			for (const c of candidates) {
				if (this.relayIds.size >= idealRelayCount) break;
				const node = this.nodes.get(c.id);
				// Detach from current relay
				if (node.relayParentId) {
					const oldRelay = this.nodes.get(node.relayParentId);
					if (oldRelay) oldRelay.childIds.delete(c.id);
				}
				node.relayParentId = null;
				this._promoteToRelay(c.id);
			}
		}

		// Reassign orphaned nodes
		for (const [id, node] of this.nodes) {
			if (node.role === "orphan" || (node.role === "leaf" && !node.relayParentId)) {
				const relayId = this._findBestRelay();
				if (relayId && relayId !== id) {
					this._assignToRelay(id, relayId);
				}
			}
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
