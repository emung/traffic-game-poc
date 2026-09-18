# Project memories

## Scope and roadmap

Prototype milestones, in order. Milestones 1 to 3 are done.

1. **Drawing -> road graph** (done) — freehand strokes become a clean node/edge graph.
2. **Traffic simulation** (done) — dead-end spawners, Dijkstra routing, IDM car-following,
   occupancy-claim junctions.
3. **Feedback loop** (done) — jam heatmap, flow and delay charts, demand that ramps in waves.
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
- **Junctions reserve a movement, not the whole box.** Started as an all-way stop (one vehicle at
  a time) and was upgraded to conflict points: two movements run together unless their paths
  actually come close. Measured at 1.55x the crossings per minute of the all-way-stop version.

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
- the closest approach between any two vehicles stays at `2 * LANE_OFFSET`. This replaced an
  earlier "one vehicle per junction box" check, which conflict points make meaningless — vehicles
  are now *supposed* to share a junction. Minimum pairwise distance is the test that still means
  something, and it is what caught the conflict/reality mismatch above.

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

### Conflict points

A *movement* is one way through a junction (arrive on this lane, leave on that one). Two movements
conflict when their paths come within `MOVEMENT_CLEARANCE`, or when they merge into the same exit
lane. Everything else runs simultaneously, so opposite straight-throughs no longer queue for each
other. About 44% of cross-approach movement pairs at a four-way are compatible.

Two things make this work, and both were found by measurement rather than reasoning:

- **Sample movement paths a junction radius back from the node, not at it.** Every lane ends
  exactly at the node, so measured there a junction has no extent and no two paths ever cross.
- **Vehicles must drive the same curve the conflict test used.** The first version compared
  straight chords between lane ends while vehicles drove to the node and jumped to the next lane.
  The test and reality disagreed, and vehicles on supposedly compatible movements passed within
  2m. Movement paths are now quadratic beziers whose control point is where the two lane tangents
  meet (the natural corner of the turn, which keeps the curve off the node), and `poseOf` places
  vehicles along that same curve while crossing. Closest approach then measured exactly
  `2 * LANE_OFFSET`, the geometric minimum, and the lane-end jump at turns disappeared as a side
  effect.

A junction still holds a movement for about 3 seconds per vehicle, so demand is scaled by
`TARGET_OCCUPANCY` well below what the tarmac would physically hold. Sizing demand to road length
instead saturates every junction and the network crawls.

Routing is static shortest-distance, so all traffic funnels onto the same path and hotspots are
sharper than in reality. That is arguably the right behaviour for a game about spotting
bottlenecks, but it is a modelling choice, not an accident.


## Feedback loop

Demand rises in waves (`WAVE_SECONDS`), driving a spawn *rate* rather than a population target,
so vehicles enter as fast as the entrances can take them and queues back up at the city edge on
their own. Three things tell the player how the network is doing: a congestion overlay on the
lanes, a rolling flow figure, and a delay ratio, the last two also drawn as sparklines.

### Congestion is delay times density, not speed alone

The overlay smooths each lane's mean speed ratio, then **weights it by how full the lane is**.
Without the density weighting a single vehicle pulling away from a dead end paints an entire
empty street red. Free-flowing lanes are deliberately left unpainted so that a healthy network
looks calm and only problems draw the eye.

### Delay ratio, and two ways of measuring it wrongly

The headline metric is how many times longer journeys take than a free run, which is
self-calibrating across networks in a way that raw trip seconds is not. Absolute speed turned out
to be a poor health signal at all: a busy network settles at a low but *steady* speed while still
serving everyone, so a speed threshold never fires.

Two earlier versions of this metric were wrong in instructive ways:

- **Measuring arrivals only is survivorship bias.** In a real jam nothing arrives, the rolling
  window empties, and an arrivals-only average reports that everything is fine — exactly backwards
  at the moment it matters most. Vehicles still travelling have to count.
- **Counting elapsed time alone lags badly.** Most vehicles in a congested network are young, so
  averaging "time spent so far" drowns the signal. The measure instead *projects* each journey
  from its progress: time already spent plus a free run for the distance left. A vehicle moving
  freely projects 1 however new it is, and one that is crawling projects high immediately.

Failure is a sustained delay ratio above `FAIL_DELAY_RATIO`, which pauses the simulation and shows
a banner; `R` clears it and restarts traffic.

### Testing note

`requestAnimationFrame` is throttled hard while the browser pane is hidden, so the loop barely
runs and `sim.time` crawls. Measurements taken then look like the simulation is frozen or like
`window.sim` is a stale object. Bring the pane to the front before timing anything. Separately,
Vite's HMR replaces `window.sim` on every edit, so a long-running console script should re-read
`window.sim` each iteration rather than capturing it once.
