// Level map: a series of platforms forming a challenging side-scrolling course.
// Coordinates: x increases right, y increases down.
// Each platform: { x, y, w, h }

const MAP = {
	spawn: { x: 100, y: 300 },
	// Camera/world bounds
	bounds: { x: 0, y: 0, w: 6000, h: 1200 },
	platforms: [
		// === Starting area ===
		// Ground
		{ x: 0, y: 400, w: 500, h: 40 },
		// Small steps up
		{ x: 550, y: 360, w: 80, h: 20 },
		{ x: 680, y: 320, w: 80, h: 20 },
		{ x: 810, y: 280, w: 80, h: 20 },

		// === First gap section ===
		{ x: 950, y: 300, w: 120, h: 20 },
		{ x: 1130, y: 260, w: 100, h: 20 },
		{ x: 1300, y: 300, w: 80, h: 20 },

		// === Staircase down ===
		{ x: 1450, y: 340, w: 100, h: 20 },
		{ x: 1580, y: 400, w: 100, h: 20 },
		{ x: 1710, y: 460, w: 100, h: 20 },

		// === Long bridge ===
		{ x: 1850, y: 460, w: 400, h: 20 },

		// === Vertical climb ===
		{ x: 2300, y: 420, w: 80, h: 20 },
		{ x: 2200, y: 350, w: 80, h: 20 },
		{ x: 2320, y: 280, w: 80, h: 20 },
		{ x: 2200, y: 210, w: 80, h: 20 },
		{ x: 2320, y: 140, w: 80, h: 20 },

		// === High path ===
		{ x: 2450, y: 140, w: 200, h: 20 },
		{ x: 2700, y: 160, w: 80, h: 20 },
		{ x: 2840, y: 130, w: 80, h: 20 },
		{ x: 2980, y: 160, w: 80, h: 20 },

		// === Precision jumps ===
		{ x: 3120, y: 180, w: 40, h: 20 },
		{ x: 3230, y: 200, w: 40, h: 20 },
		{ x: 3340, y: 170, w: 40, h: 20 },
		{ x: 3450, y: 150, w: 40, h: 20 },

		// === Descent with walls ===
		{ x: 3550, y: 150, w: 20, h: 200 }, // Wall
		{ x: 3550, y: 350, w: 200, h: 20 },
		{ x: 3750, y: 350, w: 20, h: 200 }, // Wall
		{ x: 3600, y: 530, w: 200, h: 20 },

		// === Lower section ===
		{ x: 3850, y: 530, w: 300, h: 20 },
		{ x: 4200, y: 490, w: 80, h: 20 },
		{ x: 4350, y: 450, w: 80, h: 20 },
		{ x: 4500, y: 410, w: 80, h: 20 },

		// === Final stretch ===
		{ x: 4650, y: 400, w: 400, h: 20 },
		{ x: 5100, y: 370, w: 60, h: 20 },
		{ x: 5220, y: 340, w: 60, h: 20 },
		{ x: 5340, y: 310, w: 60, h: 20 },

		// === Finish platform ===
		{ x: 5500, y: 300, w: 300, h: 40 },

		// === Bottom catch platforms (mercy) ===
		{ x: 900, y: 700, w: 200, h: 20 },
		{ x: 1400, y: 750, w: 200, h: 20 },
		{ x: 2800, y: 600, w: 200, h: 20 },
		{ x: 4000, y: 800, w: 300, h: 20 },
	],
};

module.exports = { MAP };
