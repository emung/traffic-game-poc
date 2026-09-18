# Project memories

## Working in this repo

Work goes straight onto `main`. The owner confirmed on 2026-09-18 that this personal repo does
not use feature branches, so there is no need to ask before editing files on `main`.

Run `npm test` after adding a feature or landing a fix, before considering the work done — the
owner confirmed on 2026-09-18 that every change should be checked against the full suite, not
just the area touched. When a change adds real behavior, add a test for it in the relevant
`src/*.test.ts` file (see "Automated tests" below for what each file covers); when a change makes
an existing test redundant or obsolete (the behavior it checked no longer exists, or it's fully
subsumed by a newer test), remove it rather than leaving it to rot.

When a milestone is completed, move it out of "Candidate milestones" and into the numbered done
list at the top of "Scope and roadmap" (keep its number, mark it `(done)`, add a one-line summary
and a pointer to the section that documents it), and update the "N–M are done" line and any
theme ranges in the candidate intro. The owner asked for this on 2026-09-18 after milestone 7
was left sitting in the candidate list.

## Scope and roadmap

Milestones are built one at a time. 1–7 are done; 8–17 are candidates.

1. **Drawing -> road graph** (done) — freehand strokes become a clean node/edge graph.
2. **Traffic simulation** (done) — dead-end spawners, Dijkstra routing, IDM car-following,
   occupancy-claim junctions.
3. **Feedback loop** (done) — jam heatmap, flow and delay charts. Demand ramped in waves until
   2026-09-18; see "Waves were removed" below.
4. **Minimal UI** (done) — toolbar, 1x/2x/4x speed, time frozen while drawing.
5. **Automated tests** (done) — Vitest suite (`npm test`) covering the graph topology cases and
   the two simulation invariants from "Verifying changes here", plus `routing.ts` correctness and
   smoke tests for `geom.ts`/`simplify.ts`/`camera.ts`. See "Automated tests" below.
6. **Congestion-aware routing** (done) — new trips are routed on per-lane travel time from the
   congestion heat, reweighed every 5 s with damping. See "Congestion-aware routing" below.
7. **Junction tools** (done) — signals, priority roads and roundabouts, placed with the Control
   tool (`T`); plain junctions are deliberately slow so controls are upgrades. See "Junction
   controls" below.

v0 deliberately left out multiple road types, one-ways, traffic lights, zoning and any economy,
and roads are one lane per direction. Road types and a budget are now candidates; zoning is not.

### Candidate milestones

None of 8–17 is started. Each begins only when picked, with its design questions settled then.
Road budget (9) is the natural next step: priority roads currently cost nothing and dominate
the other controls (see "Junction controls"). The list
is grouped by theme, not ranked: problems the simulation exposed (8), costs and goals (9–11),
feedback (12–14) and quality of life (15–17).

8. **Bridges** — every crossing becomes a junction. A modifier key while drawing would carry a
   road over the others with no node, so no conflict points. `addStroke` splits at every crossing
   and rendering has no layers, so both need changing; the simulation only interacts at nodes and
   should need no change.
9. **Road budget** — nothing stops the player paving everything. Charge per metre, more for
   bridges, so every stroke is a trade-off. Open: refunds on erase and undo, and how the budget
   grows over time (there are no waves any more).
10. **Fixed entrances or designed levels** — every dead end is an entrance, so the player decides
    where traffic comes from. The request rate is a constant and origins are uniform
    over dead ends, so each extra stub thins the load on every entrance; whether that wins is
    untested. Worse, `requestTrip` drops a trip whose ends are not connected, so a few isolated
    roads should make much of the demand vanish, reopening the hole that "Unserved demand has to
    count" closed (read from the code, not measured). Entrances at the map edge, or scenarios
    such as a stadium or a commuter rush, would close both and give runs goals to replay.
11. **Road types** — multi-lane arterials, one-way streets, speed limits. A speed limit is a
    per-edge cap on desired speed. One-ways need the router to respect direction; it walks edges
    both ways today. Multi-lane roads need lane changing, the biggest simulation change on this
    list, and may deserve a milestone of their own.
12. **Junction inspector** — click a junction to see its throughput, average wait, and which
    movements block each other. Today only the congestion overlay, and busy junctions in debug
    mode, hint at why a junction fails.
13. **Route display** — click a car to highlight its route, or show where trips come from and go
    to. It explains why a road is busy, which matters more once routes react to congestion.
14. **Before/after comparison** — replay the same demand on the old and the new network, so a
    change is shown to help rather than judged by eye. Needs seeded demand (see 5) and a network
    snapshot.
15. **Better editing** — redo, dragging a point to reshape a road, Shift for straight lines. Undo
    is a stack of graph snapshots, so redo is a second stack. A reshaped road must stay welded to
    its nodes and can newly cross others, so it goes back through the crossing split.
16. **Save slots and export/import** — the map is one localStorage key in one browser, with no
    second slot and no way to move it. Named slots, plus JSON export/import for sharing; add a
    format version now, since bridges and road types will change the format.
17. **Touch support** — pinch to zoom, two-finger pan, toolbar buttons sized for fingers. Drawing
    already uses pointer events and the canvas sets `touch-action: none`.

## Decisions

- **Freehand drawing, not click-to-place segments.** Chosen for game feel; it is the more
  distinctive interaction and the reason the simplify/smooth pipeline exists.
- **Vanilla TypeScript + Canvas 2D, no engine.** Measured 60fps at ~1450 edges and 3.3ms per
  stroke commit, so there is no reason to reach for PixiJS/WebGL yet. Revisit only when
  vehicle counts (milestone 2) actually justify it.
- **World units are metres.** Camera zoom is screen pixels per metre.
- **Traffic enters and leaves at dead ends.** Every degree-1 node is both a source and a sink, so
  traffic appears as soon as a road is drawn, with no extra tool or UI.
- **Live editing, with time frozen while a stroke is drawn.** Chosen over separate build/run
  phases: the player fixes the network under pressure, but each stroke gets breathing room.
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
- the closest approach between any two vehicles never drops below `MOVEMENT_CLEARANCE`. This
  replaced an earlier "one vehicle per junction box" check, which conflict points make
  meaningless — vehicles are now *supposed* to share a junction. Minimum pairwise distance is the
  test that still means something, and it is what caught the conflict/reality mismatch described
  under "Conflict points" below. `2 * LANE_OFFSET` (the value originally measured here) is only
  the floor for two vehicles on opposite lanes of the *same* road — a consequence of lane
  geometry, not of the conflict check. `MOVEMENT_CLEARANCE` is deliberately set below
  `2 * LANE_OFFSET` (see its comment in `config.ts`) precisely so that turning movements can be
  marked compatible while closer together than that; measured on a 2x2 junction grid over 30
  trials of 60 simulated seconds each (`src/traffic.test.ts`), straight-through pairs bottom out
  at exactly `2 * LANE_OFFSET` (4m), turning pairs as low as ~3.54m, and nothing ever came close
  to the true `MOVEMENT_CLEARANCE` (3m) floor.

When measuring flow, watch whether **arrivals keep rising**. Falling average speed alone does not
distinguish congestion from deadlock, but a network whose arrival count has stopped moving is
deadlocked.

## Automated tests

`npm test` (Vitest, config in `vite.config.ts`) runs the suite under `src/*.test.ts`:

- `graph.test.ts` — every case from "Verifying changes here" above (single road, X crossing, T
  junction, endpoint weld, lasso, closed loop, erase-all, save/load round trip), built with
  `addStroke` on plain 2-point strokes where possible so the exact resulting topology can be
  hand-verified rather than merely observed.
- `traffic.test.ts` — the two per-frame invariants above and an arrivals-keep-rising/no-deadlock
  check, all driven with `sim.step(graph, C.SIM_STEP)` in a loop exactly as described under
  "Driving the simulation in tests", against a fixed 2x2-junction grid built directly with
  `addNode`/`addEdge` (not `addStroke`) so the topology is exact and untouched by the
  simplify/smooth/weld pipeline.
- `routing.test.ts` — Dijkstra correctness and cache invalidation on graph changes, which nothing
  else exercises (a routing bug would silently manifest as "a vehicle took a longer route," not
  as an invariant violation).
- `geom.test.ts`, `simplify.test.ts`, `camera.test.ts` — one or two smoke tests each.

`main.ts` is untested: it is the only file touching `document`/`window`, and its unconditional
`Object.assign(window, { graph, cam, sim })` plus `requestAnimationFrame` loop with no teardown
make it impractical to import under Vitest. The console-driven workflow above remains the way to
poke at a *running* game; the suite is for regression-checking the invariants mechanically.

No seeded RNG was introduced for this. `Math.random()` stays as-is in `traffic.ts`'s
`requestTrip` — the invariant tests hold for any random sequence given a long enough run, so they
need no seeding. A real seeded-PRNG abstraction is deferred to milestone 14, which actually
requires reproducible demand.


## Traffic simulation

Each road becomes two directed lanes offset `LANE_OFFSET` to the right of the centreline, so
vehicles drive on the right. Routing is Dijkstra on per-lane travel time (see "Congestion-aware routing"), cached per node pair.
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
  `2 * LANE_OFFSET` for the opposite-straight-through case tested at the time, and the lane-end
  jump at turns disappeared as a side effect. That figure is specific to same-road opposite
  lanes, not a general bound — see the corrected note under "Verifying changes here".

A junction still holds a movement for about 3 seconds per vehicle, which is the real capacity
limit of a network. Early versions sized demand to road length and saturated every junction;
demand is now a constant request rate (see the feedback loop section).

### Congestion-aware routing

`Router` weights each *directed lane* by `length / (DESIRED_SPEED * heat)`, using the same
`laneHeat` the overlay draws. `TrafficSim.updateRouteWeights` calls `Router.updateTravelTimes`
every `ROUTE_REWEIGH_SECONDS` (5), which also clears the per-pair route cache. Until the first
reweigh a lane weighs `length / DESIRED_SPEED`, which keeps plain shortest-distance ordering.
Only *new* trips are affected; `Vehicle.route` is never changed once assigned.

Two findings shaped it:

- **Damping needs two layers.** A slow cadence alone still lets every trip admitted inside one
  window pile onto the currently-best road. So each reweigh is also blended into the previous
  weight on `ROUTE_WEIGHT_TIME_CONSTANT` (20 s); a lane that jams instantly takes about 4
  reweighs (~20 s) before routes leave it.
- **Floor heat before dividing (`MIN_ROUTING_HEAT`).** A fully jammed lane must weigh a large but
  finite amount. With `Infinity`, `next < best` is `Infinity < Infinity`, false, so Dijkstra never
  relaxes past the lane and reports a reachable destination as unreachable. The floor applies to
  routing only; `laneHeat` and the overlay still reach 0.

Measured with a throwaway two-route network (direct road with a contended mid junction, plus a
longer detour): the detour carried no trips before and up to 9 vehicles after, growing
monotonically with no oscillation, and arrivals were slightly higher (64 vs 61 before failure).
The effect is modest when most demand does not use the contested pair. Lane heat only drops where
a lane actually queues, so a network whose bottleneck is a shared junction sees no rerouting.


## Feedback loop

Demand is a constant trip *request rate* (`SPAWN_RATE`), not a population target. Requests queue at their entrance until there is room to get in (see "Unserved demand"
below). Three things tell the player how the network is doing: a congestion overlay on the
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

### Unserved demand has to count

Originally a spawn attempt that found its entrance full was simply dropped. Measured consequence:
a single straight road carried what was then wave-14 demand at 38 km/h with a delay of 1.13 and could never
fail, so building *fewer* junctions was the winning strategy and a best-wave record would only
have measured how long the tab was open (the record and the waves are gone now). Trips now wait in a queue per entrance and their clock
starts at the request, so time spent outside counts as delay; the same single road now fails as
its entrances back up. Badges at dead ends show each queue.

One related guard: admitted vehicles enter no faster than the car ahead and
slowly enough to stop behind it. Entering at road speed was a latent milestone-3 bug that the
queue exposed — with a queue every admission happens at the minimum gap, right behind a stopped
car, and 8 vehicles overlapped on entrance lanes until it was fixed.

### Testing note

`requestAnimationFrame` is throttled hard while the browser pane is hidden, so the loop barely
runs and `sim.time` crawls. Measurements taken then look like the simulation is frozen or like
`window.sim` is a stale object. Bring the pane to the front before timing anything. Separately,
Vite's HMR replaces `window.sim` on every edit, so a long-running console script should re-read
`window.sim` each iteration rather than capturing it once.

### Waves were removed

The owner removed the wave mechanism on 2026-09-18 ("I don't want a constantly rising car
amount"): the demand ramp, wave clock, wave counter and countdown, best-wave record and its
`traffic-game/best-wave` localStorage key (left orphaned, harmless). Demand is now the constant
`SPAWN_RATE` (1.1 trips/s, the old wave 1). Failure is unchanged: a sustained delay ratio above
`FAIL_DELAY_RATIO`; the banner now reports how many seconds the run lasted. The code lives in git
history. Anything measured "by wave" earlier in this file is historical.

## Junction controls (milestone 7, done)

Decided with the owner: all three types (signal, priority, roundabout); placed with a Control
tool (`T`) that cycles none -> signal -> priority -> roundabout -> none on a junction of degree 3+;
signals use a fixed cycle. Plan file: `~/.claude/plans/start-with-the-planning-polished-feather.md`.

- **Phase 1 (done): plumbing.** `RoadNode.control`, `RoadGraph.setControl` (bumps `version`,
  refuses degree < 3), persisted in `toJSON`/`loadJSON` with a save `format` version (2), so undo
  and localStorage cover it. `LaneNetwork.controls` holds only effective controls (degree >= 3).
  Shared test fixture `buildGrid(control)` lives in `src/testutil.ts`, and the traffic invariant
  tests run once per control type (`CONTROLS` in `traffic.test.ts`).
- **Phase 2 (done): signals.** `LaneNetwork.phases` groups a signal's approaches into phases:
  approaches arriving from opposite directions (dot < -0.7) share a phase, chosen by how many
  movements can run together; a T's stem gets its own. Lefts stay permissive (the claim-time
  conflict check makes them wait for a gap). `TrafficSim.signalState` is a pure function of
  `sim.time` and node id (no timer state): green 8 s, yellow 2 s, all-red 1 s. Red withholds the
  claim; yellow lets in only vehicles already inside `claimDist` (they cannot stop comfortably).
- **Phase 3 (done): priority roads.** `LaneNetwork.buildPriority` picks the major road at each
  priority node: the two approaches closest to a straight line (at a T, the through road; at an X
  the first such pair by angle). Minor-approach movements get `Movement.yieldsTo` = the major
  movements they conflict with. `TrafficSim.majorIsClear` (part of the claim predicate) makes a
  minor car wait while a conflicting major car is within `YIELD_LOOKAHEAD` (40 m) and would arrive
  within `YIELD_TIME` (3 s) at its current speed; a major car creeping from rest does not count.
  Major roads never yield, so no yield cycle at a node. Rendered as dashed give-way lines at
  minor stop lines. Tests: `lanes.test.ts` (new) and "priority" in `traffic.test.ts`; the yield
  test was mutation-checked (fails with yielding disabled).
- **Priority bug found in the browser (fixed): a standing major-road queue lost to the minor
  road.** The first `majorIsClear` only counted major cars that were moving, so cars waiting at the
  line (v = 0) were ignored, and minor cars kept claiming the junction while the major queue stood
  (seen live: minor car holding at 11 m/s, major queues at r = 7 m). Now a major car within
  `YIELD_QUEUE_DIST` (12 m) of the line counts whether moving or not, unless its own exit is full
  (`exitHasRoom`; minor traffic cannot clear that). Test: "gives a major-road car standing at the
  line its turn" (mutation-checked). Live check afterwards: 0 minor claims while a major car stood
  at the line over 40 simulated seconds. Lesson: unit tests with a moving major car passed while
  this was broken; standing queues need their own test.
- **Phase 4 (done): roundabouts.** A roundabout has a bigger box than a plain junction
  (`ROUNDABOUT_ZONE` 12 m, shrunk to 45% of its shortest road, never below 5 m; ring radius
  `ROUNDABOUT_RING_FRACTION` 0.6 of that = 7.2 m) and a limit of `ROUNDABOUT_SPEED` 8 m/s.
  `LaneNetwork.ringPath` builds each movement as lane -> ring -> anticlockwise arc (decreasing
  angle, since screen y points down) -> exit lane, Chaikin-smoothed. Rendered as a ring road with an
  island. U-turns (same edge) keep a plain chord and the static conflict rule.
  - **Per-node zone and per-movement span (applies to every junction, no behaviour change for
    plain).** `Movement.zone` is the node's box radius; `Movement.span` is how far a vehicle
    travels through the box: `2 * zone` for plain (sampled by fraction, as before), the true path
    length for a roundabout. On changing lane `advanceLegs` subtracts `span - 2 * zone`, so a car's
    real position along its path stays continuous; the price is that a vehicle in the box can have
    a *negative* `s` on the exit lane (a virtual coordinate), and `computeAccelerations` adds the
    same shift to the gap to a leader on the next lane. Without it cars sped up on long arcs and
    overlapped on short right turns; the roundabout crossing tests fail if the shift is removed.
  - **Entering is judged by where cars are on the ring, not by static arc conflicts** (`ringIsClear`).
    Static conflicts made the whole ring one exclusive box: roundabouts failed even at light
    demand (8/8 trials at 1.1/s). Now an entrant yields to a ring car that will reach its entry
    within `ROUNDABOUT_YIELD_ARC` (14 m) plus `ROUNDABOUT_YIELD_TIME` (2 s) of that car's speed,
    and stays `ROUNDABOUT_FOLLOW_ARC` (8 m) plus `ROUNDABOUT_ENTRY_LAG` (4 per metre the leader
    still has to travel before reaching the ring) behind one that has just passed its entry.
    Same-approach cars are left to car following; movements into the same exit lane take turns
    (a vehicle cannot see a car still on the ring, whose exit-lane position is only virtual).
  - **Bugs found on the way, all fixed and all generic:** (1) the speed limit did not apply in the
    second half of the box, so cars accelerated to 14 m/s halfway round; `junctionSpeedCap` now
    holds the limit until the car has left the box (this also slows plain junctions on exit).
    (2) A car that claimed early and then found the exit full released at speed a few metres out
    and rolled into the box unclaimed; it may now only release if it can still stop
    (`canStop` in `junctionGap`). (3) A claimant that had not reached the ring yet was treated as
    already on it, so a faster ring car caught up with it; the entry-lag term fixes that.
  - **How it was verified.** Closest approach >= `MOVEMENT_CLEARANCE` and no lane overlap over 80
    trials of 90 s for plain, signal and priority: 0 violations. Roundabout: 26% of trials
    violated before the fixes; after them 1 in 1,500 trials (a 2.95 m scrape); after raising
    `ROUNDABOUT_ENTRY_LAG` from 2.5 to 4, 0 in 1,500. A residual rate is possible; if
    `keeps every pair of vehicles at least MOVEMENT_CLEARANCE apart (control: roundabout)` ever
    flakes, that is this, not a random failure. Method: run the sim in a loop with
    `buildGrid('roundabout')` and dump both vehicles' lane, s, v, ring angle and holding movement
    at the first violation; every cause found so far was visible in that dump.
  - **Comparison on the 2x2 grid** (8 trials, 300 s, `MAX_ACCEL` 32; arrivals; delay at light
    demand): 1.1/s (nobody fails): plain 243 / 2.11x, signal 270 / 1.83x, priority 296 / 1.28x,
    roundabout 266 / 1.88x. 2.5/s (all fail): plain 117, signal 161, priority 178, roundabout 153.
    4/s: plain 98, signal 133, priority 126, roundabout 122. Every control now beats plain.
    Priority still dominates (it costs nothing; see milestone 9). Roundabout sits between plain
    and signal; a small ring with static conflicts was strictly worse than plain, so do not
    simplify `ringIsClear` back to conflict sets.
  - **Known limits.** Roads shorter than about 27 m shrink the roundabout box (45% rule). Two
    roundabouts on one short road are not otherwise handled. No visual cue shows circulation
    direction.
- **Which road is major (owner decision, 2026-09-18: rule plus Shift-click).** Ties are the normal
  case at a four-way (both axes dead straight). `LaneNetwork.priorityAxes` ranks candidate pairs by
  straightness (scores within `AXIS_TIE` 0.05 are tied), then by total road length, then by arrival
  angle, so by default the longer road is major. Shift-click on a priority junction with the
  Control tool rotates through the candidates (`nextMajorBearing`); a T has one candidate so it
  does nothing there. The choice is stored on the node as `RoadNode.majorBearing`, the arrival
  bearing of one major approach, not an edge id: edge ids change whenever a road is split, the
  bearing at the junction does not. Matched to an approach within `BEARING_MATCH` (0.35 rad),
  otherwise the default rule applies. `setControl` clears it (any control change), and it is
  saved in `toJSON`/`loadJSON`. Tests: "choosing the major road" in `lanes.test.ts` (mutation-
  checked). Trap hit while building it: inserting an `if` between an `if` and its `else if` in
  `LaneNetwork.build` silently made every controlled junction also count as plain (and slowed
  them); the approach tests caught it.
- **Plain junctions are slow on purpose (owner decision, 2026-09-18).** Before this, no control beat
  a plain junction: it is a zero-cost reservation scheme (cars claim non-conflicting paths and cross
  at full speed), so every control only added waiting and a player had no reason to place one. Now
  a plain junction (three or more roads, no control; `LaneNetwork.plainJunctions`) caps vehicles at
  `UNCONTROLLED_SPEED` (5.5 m/s, 20 km/h). `TrafficSim.plainJunctionCap` is an acceleration cap in
  `computeAccelerations`: braking starts at a comfortable deceleration only once the car could not
  otherwise reach the limit by the box edge (~37 m out from 50 km/h), then holds the limit while
  crossing. Signals, priority and roundabout nodes are not slowed. Tests: "approaching an open
  junction" in `traffic.test.ts`.
- **Comparison on the 2x2 grid after the slowdown** (8 trials, 300 s, `MAX_ACCEL` 32). Light demand
  (1.1/s, nobody fails): delay plain 1.75x, signal 1.82x, priority 1.26x. At 2.5/s (all fail):
  arrivals plain 150, signal 184, priority 214. At 4/s: 114, 141, 133. So both controls now win
  under load, and priority beats plain even when light. Priority dominates signals here because it
  costs nothing: with no budget (milestone 9) there is no reason to pick a signal. Revisit when
  controls get a price or when signals get smarter. Before the slowdown plain won everywhere
  (2.5/s: plain 262, priority 202, signal 167).
- **Approach braking bug (fixed, applies to plain junctions too).** `junctionGap` used to return a
  stop-line obstacle for any vehicle that could not claim yet, even one far out that would be
  cleared the moment it got closer, so cars braked for open junctions from ~60 m and reached a
  green crawling. Now a vehicle beyond `claimDist` whose junction is open returns no obstacle;
  `claimDist` is the stopping distance at `CLAIM_BRAKE`, so it can still stop if the junction
  closes. Measured (12 trials, 2x2 grid, arrivals before failure): plain 88 -> ~120, signal
  54 -> ~78. Older throughput numbers in this file predate the fix. Tests: "approaching an open
  junction" in `traffic.test.ts` (a car must hold > 95% of desired speed).
- **Queue discharge was throttled by `exitHasRoom` (fixed, applies to every junction).** A trace
  of 6 queued cars at a green showed each follower waiting for its leader to be ~17 m into the exit
  lane (`RELEASE_AT + CAR_LENGTH + MIN_GAP + 1`) and braking meanwhile: one car per ~2.2 s even
  though the leader was at full speed. Now a flowing car counts by its projected position
  (`EXIT_LOOKAHEAD`, 1 s) when it moves at >= `EXIT_FLOW_SPEED_FRACTION` (0.5) of desired speed
  and everything in the first `EXIT_FLOW_CHECK_LENGTH` (60 m) of the exit lane is flowing too, so a
  queue forming just past the junction still keeps followers out of the box. Result at
  `MAX_ACCEL` 32: 4 -> 5 cars per green+yellow, headway 2.2 -> ~1.7 s. At the default 1.8 it
  barely helps (a leader accelerating from rest is below the speed fraction for seconds), and only
  2 of 8 queued cars cross in 10 s. Tests: "exit room" in `traffic.test.ts`.
- **Signal green is 15 s** (was 8). A queue discharges ~1.9 s per car, so 8 s of green passed only
  ~4-5 cars. Swept 8/12/16/20/25 s at `MAX_ACCEL` 32 on the 2x2 grid: longer green passes more per
  phase but raises delay under light traffic (signal delay 1.67x at 8 s -> 1.90x at 16 s -> 2.22x
  at 25 s, vs ~1.2x plain), so 15 s is the low end of the useful range. Signals only pay off where
  plain junctions are near capacity, which constant demand at this rate does not reach.
  Beware when tracing with an artificial queue: 8+ stopped cars trip the gridlock detector after
  ~20 s and pause the sim, which looks like a discharge plateau.
- **With constant demand and `MAX_ACCEL` 32** the 2x2 grid never fails in 600 s (plain 628
  arrivals, signal 608, 0/12 failed); at 1.8 all 12 trials fail (plain 178 arrivals, survived
  257 s; signal 86, 182 s).
- **Signals still trail plain junctions** on that grid, since plain conflict-point junctions
  already run compatible movements together. Open: whether signals win on a heavier junction.
  Green is short (8 s), which with ~2 s discharge headway passes only a few cars per phase.
- **Launch feel.** `MAX_ACCEL` is 1.8 m/s^2, so a car from rest takes ~4 s to clear the box. A
  temporary 2.6 raised arrivals (plain ~119 -> 153, signal ~77 -> 97) with all invariants green.
  The owner has tried a much larger value locally (32) and still saw only 2-3 cars pass per green.

## Minimal UI

One toolbar at the bottom (tools, pause, 1x/2x/4x, restart, undo, clear, fit, debug, help) with
hotkey hints; a `?` popover holds the navigation help. The stats panel shows graph structure only
in debug mode.

Details that were deliberate:

- **Speed runs more fixed steps per frame, never a larger `dt`**, so the physics are identical at
  4x. Measured sim-to-real ratios were exactly 1.00, 2.00 and 4.00.
- **While a stroke is being drawn the accumulator is zeroed**, so the paused time is dropped rather
  than replayed as a burst on release.
- **Undo rewinds the roads, not the run.** It used to call `sim.reset()`, which sent a player who
  undid a stroke late in a run back to the start. Graph ids are now monotonic (`clear` and `loadJSON`
  never move the counters backwards), so an id can never come back meaning a different road and
  vehicles on surviving roads are safe to keep.
- **Keyboard shortcuts ignore Cmd/Ctrl/Alt.** Before this, copying with Cmd+C cleared the map.
- **Toolbar buttons blur after a click**, because a focused button is pressed by the space bar,
  which is also the pan key.
- **Fit frames the area the panels leave free**, measured from the panels' own rectangles, and
  drops the stats-panel margin on narrow screens.
- Centred fixed elements use `left/right` insets with auto margins. `left: 50%` plus a translate
  only gives them the right half of the viewport to size into, and the toolbar wrapped at 400px.

### Driving the simulation in tests

Don't time the simulation through the page: when the browser pane is hidden,
`requestAnimationFrame` runs at about 2 ticks per second. Call `window.sim.step(window.graph,
1 / 60)` in a loop from the console instead; it is deterministic, independent of rendering, and
fast (229 simulated seconds with ~170 vehicles took 0.2s of CPU).
