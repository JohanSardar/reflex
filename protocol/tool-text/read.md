Read a Space's Elements as text. The default outline gives each Element's ID, type, who made it (by), bounds and a short text. Narrow it with near (an Element or Mark ID) or bounds.

detail: "full" with ids returns every field of those Elements, including their data map and Behaviors. The fields you set in apply come back under the same names; owner, bounds and type_version are read only (to move or resize, patch at, w and h). Use it for files the person added. detail: "strokes" with Ink or Mark IDs returns raw stroke points, for when the shape of the writing matters (handwriting, kanji, sketches).

All coordinates are yours: one integer space per Space whose origin never moves.
