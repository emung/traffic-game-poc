# Project memories

## Scope and roadmap

Prototype milestones, in order. Milestone 1 is done; the rest are not started.

1. **Drawing -> road graph** (done) — freehand strokes become a clean node/edge graph.
2. **Traffic simulation** — spawners, A*/Dijkstra routing over the graph, car-following
   movement, intersection yield rules.
3. **Feedback loop** — a visible metric (travel time, throughput, jam heatmap). This is what
   makes it a game rather than a doodle pad; without it there is nothing to optimise against.
4. **Minimal UI** — draw/simulate mode, play/pause/speed.

Deliberately out of scope for v0: multiple road types, lanes, one-ways, traffic lights,
zoning/economy. Single road type and yield-based junctions only.

## Decisions

- **Freehand drawing, not click-to-place segments.** Chosen for game feel; it is the more
  distinctive interaction and the reason the simplify/smooth pipeline exists.
- **Vanilla TypeScript + Canvas 2D, no engine.** Measured 60fps at ~1450 edges and 3.3ms per
  stroke commit, so there is no reason to reach for PixiJS/WebGL yet. Revisit only when
  vehicle counts (milestone 2) actually justify it.
- **World units are metres.** Camera zoom is screen pixels per metre.

## Invariants the graph relies on

- An edge's `points[0]` and `points.at(-1)` are exactly its endpoint nodes' positions. Edge
  geometry is welded to nodes, never merely near them. A test asserts a worst-case gap of 0.
- `node.edges` is an **array, not a Set** — a self-loop road (a drawn circle) meets its node at
  both ends and must appear twice, or junction degree is wrong. This was a real bug found by
  testing a closed loop; a Set silently reported degree 1.
- `MERGE_DIST` guards every split: crossings within that distance of a piece's own endpoints are
  skipped. This is what makes `addStroke`'s work queue terminate, since each split then strictly
  shortens the remaining pieces.

## How a stroke becomes roads

`RoadGraph.addStroke` (src/graph.ts) cleans the stroke (RDP simplify -> Chaikin smooth -> RDP
again), welds both endpoints onto any nearby node or edge, then works a queue of polyline
pieces: each piece is split at its first self-crossing, then at its first crossing with the
existing graph, until pieces are crossing-free and can be added as edges. Because earlier pieces
of the same stroke are already in the graph when later ones are tested, self-intersection needs
no special case beyond the first split.

## Verifying changes here

The graph is exposed as `window.graph` (and `window.cam`) for console-driven testing. Topology
assertions are far more informative than screenshots: build strokes programmatically, then check
node/edge counts and a degree histogram. Cases worth re-running after any graph change: single
road, X crossing, T junction, endpoint weld, lasso (one self-crossing), closed loop, erase-all,
and a save/load round trip.
