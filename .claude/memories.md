# Project memories

## Working in this repo

Work goes straight onto `main`. The owner confirmed on 2026-09-18 that this personal repo does
not use feature branches, so there is no need to ask before editing files on `main`.

## Scope and roadmap

Milestones are built one at a time. 1–4 were the v0 prototype and are done; 5–17 are candidates.

1. **Drawing -> road graph** (done) — freehand strokes become a clean node/edge graph.
2. **Traffic simulation** (done) — dead-end spawners, Dijkstra routing, IDM car-following,
   occupancy-claim junctions.
3. **Feedback loop** (done) — jam heatmap, flow and delay charts, demand that ramps in waves.
4. **Minimal UI** (done) — toolbar, 1x/2x/4x speed, time frozen while drawing, wave
   countdown, best-wave record.

v0 deliberately left out multiple road types, one-ways, traffic lights, zoning and any economy,
and roads are one lane per direction. Road types, junction tools and a budget are now candidates;
zoning is not.

### Candidate milestones

None is started. Each begins only when picked, with its design questions settled then. Tests (5)
then congestion-aware routing (6) are the recommended next steps. Beyond that the list is grouped
by theme, not ranked: problems the simulation exposed (6–8), costs and goals (9–11), feedback
(12–14) and quality of life (15–17).

5. **Automated tests** — there are none. Every check so far was run by hand in the console, and
   each one caught a real bug. Turn the cases under "Verifying changes here" into a suite before
   6, so routing changes cannot quietly break the junction invariants. Vitest fits the Vite
   setup, and only `main.ts` touches the DOM, so graph and simulation can run headless. Trip ends
   and driver speeds come from `Math.random`, so reproducible runs need a seeded source; 14 needs
   one too.
6. **Congestion-aware routing** — routes are static shortest-distance, so a new road carries every
   trip it shortens and no other, whatever the traffic: a bypass drawn around a jam either stays
   empty or inherits the whole jam. Route on travel time instead, using the per-lane speeds the
   congestion overlay already smooths. Naive rerouting sends everyone onto the new road and then
   back, so it needs damping, and the per-pair route cache has to expire.
7. **Junction tools** — junctions are the capacity limit, about 3 s per vehicle, and drawing more
   road is the only fix today. Candidates: traffic lights, priority roads, roundabouts. Which of
   them, and how the player places one, is the first decision.
8. **Bridges** — every crossing becomes a junction. A modifier key while drawing would carry a
   road over the others with no node, so no conflict points. `addStroke` splits at every crossing
   and rendering has no layers, so both need changing; the simulation only interacts at nodes and
   should need no change.
9. **Road budget** — nothing stops the player paving everything. Charge per metre, more for
   bridges, so every stroke is a trade-off. Open: refunds on erase and undo, and how the budget
   grows between waves.
10. **Fixed entrances or designed levels** — every dead end is an entrance, so the player decides
    where traffic comes from. The request rate depends only on the wave and origins are uniform
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

A junction still holds a movement for about 3 seconds per vehicle, which is the real capacity
limit of a network. Early versions sized demand to road length and saturated every junction;
demand is now a rate that ramps in waves (see the feedback loop section).

Routing is static shortest-distance, so all traffic funnels onto the same path and hotspots are
sharper than in reality. That is arguably the right behaviour for a game about spotting
bottlenecks, but it is a modelling choice, not an accident, and candidate milestone 6 proposes
changing it.


## Feedback loop

Demand rises in waves (`WAVE_SECONDS`), driving a trip *request rate* rather than a population
target. Requests queue at their entrance until there is room to get in (see "Unserved demand"
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
a single straight road carried wave-14 demand at 38 km/h with a delay of 1.13 and could never
fail, so building *fewer* junctions was the winning strategy and a best-wave record would only
have measured how long the tab was open. Trips now wait in a queue per entrance and their clock
starts at the request, so time spent outside counts as delay; the same single road now fails as
its entrances back up. Badges at dead ends show each queue.

Two related guards: the wave clock only runs while there is traffic or a queue, so an empty or
unconnected map cannot bank waves; and admitted vehicles enter no faster than the car ahead and
slowly enough to stop behind it. Entering at road speed was a latent milestone-3 bug that the
queue exposed — with a queue every admission happens at the minimum gap, right behind a stopped
car, and 8 vehicles overlapped on entrance lanes until it was fixed.

### Testing note

`requestAnimationFrame` is throttled hard while the browser pane is hidden, so the loop barely
runs and `sim.time` crawls. Measurements taken then look like the simulation is frozen or like
`window.sim` is a stale object. Bring the pane to the front before timing anything. Separately,
Vite's HMR replaces `window.sim` on every edit, so a long-running console script should re-read
`window.sim` each iteration rather than capturing it once.

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
  undid a stroke in wave 5 back to wave 1. Graph ids are now monotonic (`clear` and `loadJSON`
  never move the counters backwards), so an id can never come back meaning a different road and
  vehicles on surviving roads are safe to keep.
- **Keyboard shortcuts ignore Cmd/Ctrl/Alt.** Before this, copying with Cmd+C cleared the map.
- **Toolbar buttons blur after a click**, because a focused button is pressed by the space bar,
  which is also the pan key.
- **Fit frames the area the panels leave free**, measured from the panels' own rectangles, and
  drops the stats-panel margin on narrow screens.
- Centred fixed elements use `left/right` insets with auto margins. `left: 50%` plus a translate
  only gives them the right half of the viewport to size into, and the toolbar wrapped at 400px.
- The best wave is stored under `traffic-game/best-wave` and only advances while there is traffic.

### Driving the simulation in tests

Don't time the simulation through the page: when the browser pane is hidden,
`requestAnimationFrame` runs at about 2 ticks per second. Call `window.sim.step(window.graph,
1 / 60)` in a loop from the console instead; it is deterministic, independent of rendering, and
fast (229 simulated seconds with ~170 vehicles took 0.2s of CPU).
