# Project memories

## Scope and roadmap

Prototype milestones, in order. Milestones 1 and 2 are done.

1. **Drawing -> road graph** (done) — freehand strokes become a clean node/edge graph.
2. **Traffic simulation** (done) — dead-end spawners, Dijkstra routing, IDM car-following,
   occupancy-claim junctions.
3. **Feedback loop** — a visible metric (travel time, throughput, jam heatmap). This is what
   makes it a game rather than a doodle pad; without it there is nothing to optimise against.
4. **Minimal UI** — draw/simulate mode, play/pause/speed.

Deliberately out of scope for v0: multiple road types, one-ways, traffic lights,
zoning/economy. Roads are one lane per direction.

## Decisions

- **Freehand drawing, not click-to-place segments.** Chosen for game feel; it is the more
  distinctive interaction and the reason the simplify/smooth pipeline exists.
- **Vanilla TypeScript + Canvas 2D, no engine.** Measured 60fps at ~1450 edges and 3.3ms per
  stroke commit, so there is no reason to reach for PixiJS/WebGL yet. Revisit only when
  vehicle counts (milestone 2) actually justify it.
- **World units are metres.** Camera zoom is screen pixels per metre.
- **Traffic enters and leaves at dead ends.** Every degree-1 node is both a source and a sink, so
  traffic appears as soon as a road is drawn, with no extra tool or UI.
- **Junctions are all-way stops via an occupancy claim**, chosen over priority/yield rules for v0
  because it is deadlock-free to reason about and still produces real congestion.

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

The simulation is exposed as `window.sim`. Two invariants are worth auditing on every frame after
any change to junction or car-following logic, because both failed at some point during the first
implementation and neither is visible at a glance:

- no two vehicles on one lane overlap (`leader.s - CAR_LENGTH - follower.s >= 0`);
- no two vehicles from different edges sit inside the same junction box.

When measuring flow, watch whether **arrivals keep rising**. Falling average speed alone does not
distinguish congestion from deadlock, but a network whose arrival count has stopped moving is
deadlocked.


## Traffic simulation

Each road becomes two directed lanes offset `LANE_OFFSET` to the right of the centreline, so
vehicles drive on the right. Routing is plain Dijkstra on road length, cached per node pair.
Longitudinal movement is IDM car-following. `TrafficSim.sync` rebuilds only when
`RoadGraph.version` changes, and keeps vehicles whose remaining route survived, so drawing a
road does not wipe the traffic already on screen.

### Junction rules, and the two bugs that matter

A vehicle must hold a node's occupancy claim to cross it. Three constraints interact, and
getting any one wrong produces a network that gridlocks or cheats:

- **Claim distance must exceed the junction radius.** Setting `JUNCTION_CLAIM_DIST` below
  `JUNCTION_RADIUS` means a vehicle reaches the stop line before it ever considers claiming, so
  it drives through unclaimed. This produced overlapping cars inside junctions.
- **Claim late, but brake from any distance.** Braking for a junction is planned from any
  distance while the claim is only taken within `claimDist`, which scales with stopping distance
  `v^2 / (2 * CLAIM_BRAKE)`. Fast vehicles therefore claim early and keep their speed; queued
  ones claim late so the junction cycles quickly.
- **Exit clearance needs a whole car beyond the release point.** A vehicle can only advance to
  `blocker.s - CAR_LENGTH - MIN_GAP`, so entering requires the exit lane to be clear for
  `RELEASE_AT + CAR_LENGTH + MIN_GAP`. Requiring merely `RELEASE_AT` lets vehicles park inside
  the box and never hand the junction back, which is what gridlocked the first version.

`advanceLegs` also refuses to move a vehicle onto the next lane unless it holds the junction.
That hard invariant is what makes junction exclusion true regardless of what the car-following
model does, and should not be removed.

### Capacity, and why demand is scaled down

A junction is held for about 3 seconds per vehicle, capping it near **20 vehicles per minute** —
the genuine capacity of an all-way stop, not a bug. Demand is therefore scaled by
`TARGET_OCCUPANCY` to a small fraction of what the tarmac would physically hold; sizing demand to
road length instead saturates every junction and the whole network crawls. If junction throughput
ever needs to rise, the real fix is letting **non-conflicting movements cross together** (opposite
straight-throughs, right turns) rather than one vehicle at a time.

Routing is static shortest-distance, so all traffic funnels onto the same path and hotspots are
sharper than in reality. That is arguably the right behaviour for a game about spotting
bottlenecks, but it is a modelling choice, not an accident.
