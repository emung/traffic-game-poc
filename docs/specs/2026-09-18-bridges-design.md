# Milestone 8: Bridges — design

Status: approved design, not yet implemented. Date: 2026-09-18.

## Problem

Every crossing becomes a junction. `RoadGraph.addStroke` splits at every crossing with the
existing graph, so the player cannot carry a road over another one, and every crossing adds
conflict points and a slow plain junction. Bridges let a road pass over others with no node.

## Decisions (settled with the owner)

- **The whole stroke is a bridge.** A bridge stroke is elevated along its full length. It crosses
  anything on the ground with no junction and touches the ground only at its two ends, which act
  as ramps. Nothing on the ground can join it mid-span.
- **Input: both a modifier and a tool.** Holding Alt/Option with the Draw tool draws a bridge,
  and so does a new Bridge tool (`B`).
- **One elevated level.** A bridge crossing another bridge, or itself, makes a normal junction at
  bridge level. Bridges never stack.
- **Welding: bridge ends connect, ground ends pass under.** A bridge's endpoints weld to ground
  roads and nodes as usual (ramps) and also to other bridges mid-span (same level). A ground
  stroke end ignores bridge edges mid-span; it may weld to ground edges, ground nodes, and a
  bridge's ramp nodes.

Approaches considered: a per-edge boolean flag (chosen), a numeric per-edge `level` (same thing
today, and stacking was ruled out), and a separate bridge graph (rejected: bridges connect to the
ground network at their ends, and routing and lanes need one graph).

## 1. Data model and graph (`src/graph.ts`)

- **`RoadEdge.bridge?: true`.** Absent means ground. Older saves load as all-ground.
- **Node level is derived, not stored:** a node is *elevated* when its degree is >= 2 and every
  incident edge is a bridge. That covers bridge/bridge junctions, bridge self-crossings and a
  bridge welded mid-span onto another bridge. Every other node is ground: a bridge's end that
  meets a ground road (a ramp), and a bridge's dead end (degree 1), which is a ramp to nowhere and
  is where traffic enters and leaves.
- **Ramps are the ends of a bridge edge.** The first and last `RAMP_LENGTH` (new constant in
  `config.ts`, 12 m: at least the largest junction box, `ROUNDABOUT_ZONE`, and below
  `SNAP_RADIUS`) of arc length along a bridge edge, measured from an end at a *ground* node, are
  at ground level. Everything between is the elevated span. An end at an elevated node has no
  ramp. One helper, `isElevatedAt(edge, s)`, answers this for the graph, the renderer and the
  simulation alike. A bridge edge too short to have an elevated span (<= 2 * `RAMP_LENGTH`) is
  ground everywhere and behaves like a ground road for crossings.
- **`addStroke(raw, opts?: { bridge?: boolean })`.** Every edge the stroke produces carries the
  flag.
- **`firstCrossing(pts, bridge)`** skips a crossing when exactly one of the two roads is elevated
  *at the crossing point* (by `isElevatedAt`; for the stroke being added, measured along the
  piece, with its ends' levels known from the weld). Ground over elevated span and elevated span
  over ground: no split, no node. Bridge span over bridge span: split into a junction, as ground
  roads do today. A crossing on a ramp is at ground level, so it splits like any ground crossing.
  `firstSelfCrossing` is unchanged (a bridge crossing itself makes a junction on the bridge).
- **`splitEdge` copies `bridge`** to both halves.
- **`edgeNear(p, r, level?)` and `nodeNear(p, r, level?)`** take an optional level filter.
  `weldEndpoint` uses them:
  - ground stroke end: ground edges; nodes that are not elevated (includes ramp nodes). A point on
    a ramp is within `RAMP_LENGTH` < `SNAP_RADIUS` of its ramp node, and nodes are tried before
    edges, so a ground end landing on a ramp welds to the ramp node rather than splitting it;
  - bridge stroke end: any edge or node (ground ones become ramps; bridge ones join at bridge
    level).
- **Save format.** `FORMAT_VERSION` 2 -> 3; `toJSON`/`loadJSON` carry `bridge` on edges (only when
  true). Undo snapshots go through the same JSON, so undo covers bridges.
- **No change to simulation behaviour.** `LaneNetwork` and `Router` see only nodes and edges; a
  bridge adds no node where it crosses, so no movement or conflict exists there. The only
  simulation addition is the read-only `TrafficSim.levelOf` (section 3).

Known consequence: a bridge drawn exactly through an existing ground junction passes over it
without connecting. The snap preview shows no snap there, which tells the player.

## 2. Input, rendering, erasing

### Input (`src/main.ts`, `index.html`)

- **Bridge tool:** a toolbar button "Bridge" with `<kbd>B</kbd>` after Draw; hotkey `b`. It draws
  exactly like Draw, but every stroke is a bridge.
- **Alt modifier:** with the Draw tool, `isBridge = tool === 'bridge' || altKey`, read from each
  pointer move and at release (the state at release decides). With the Bridge tool, Alt changes
  nothing: it never turns a bridge back into a ground road. The keydown handler returns early
  on `altKey` to leave browser shortcuts alone, so Alt press/release must be handled before that
  early return (or in a separate listener) to refresh the preview while the mouse is still.
- **Snap preview** uses the same level rules as welding (`snapTargetAt(p, isBridge)`), so it shows
  only what the stroke end would actually weld to.
- **Help popover:** one line: "Hold Alt while drawing (or use Bridge) to build over roads".

### Rendering (`src/render.ts`)

Two passes instead of one:

1. **Ground pass:** grid, ground roads *and the ramps of bridge edges* (drawn as ordinary road),
   heat on those stretches, ground nodes with their signals and yield lines, vehicles whose level
   is ground.
2. **Bridge pass:** for the elevated span of each bridge edge only (by `isElevatedAt`): a soft
   drop shadow (deck offset slightly down-right, translucent), the deck in the road colours with a
   lighter casing that reads as railings, heat on the span; then elevated nodes with their
   controls, signals and yield lines; then vehicles whose level is bridge.

Drawing only the span in the bridge pass keeps the deck from covering a ramp junction box, where
ground-level vehicles (including ones on the ramp) are drawn in the ground pass.

A vehicle's level comes from `TrafficSim.levelOf(v)` (section 3). The live stroke preview is drawn
in the bridge style while `isBridge` is true.

### Erasing and hovering

- `edgeUnder` prefers bridge edges: where a bridge crosses a road, the click picks the bridge
  (drawn on top). The road below is erased by clicking it a little away from the bridge.
- Erasing a bridge leaves ground roads below untouched; orphaned ramp nodes go through the
  existing `pruneOrphans`.

### Control tool

Unchanged. An elevated junction of degree 3+ can take any control like any other junction.

## 3. Testing

### Shared level logic

`TrafficSim.levelOf(v): 'ground' | 'bridge'` is the single definition of a vehicle's level. On a
lane it is `isElevatedAt(edge, s)` at the vehicle's position, so a vehicle on a ramp is ground.
While crossing a junction box it is the node's level (ramp nodes are ground, bridge/bridge
junctions are elevated). The renderer and the tests both call it, so what is drawn and what is
tested cannot disagree, and vehicles near a ramp junction stay subject to the clearance check.

### `graph.test.ts` (2-point `addStroke` strokes, hand-verifiable)

- **Overpass:** ground road, then a bridge across it: 2 edges, 4 nodes, no degree-4 node, the
  ground road still one edge.
- **Underpass:** bridge first, then a ground road across it: same result.
- **Bridge meets bridge:** two crossing bridges make one degree-4 node; all 4 edges have `bridge`
  (checks that `splitEdge` copies the flag).
- **Ramp weld:** a bridge ending on the middle of a ground road splits it into a T; the bridge
  edge stays a bridge, both ground halves stay ground.
- **No mid-span weld:** a ground stroke ending on the middle of a bridge does not split it; the
  stroke gets its own end node.
- **Ground to ramp node:** a ground stroke ending at a bridge's end node, or on its ramp, welds
  to the end node.
- **Crossing on a ramp:** a ground road crossing a bridge within `RAMP_LENGTH` of its ground end
  makes a junction there (the crossing is at ground level).
- **Too short to rise:** a bridge stroke of <= 2 * `RAMP_LENGTH` crossing a ground road makes a
  junction, like a ground stroke.
- **`isElevatedAt`:** false within `RAMP_LENGTH` of a ground end, true between; true all the way
  to an end at an elevated node; false everywhere on a ground edge.
- **Erase a bridge:** the road below is unchanged; orphaned ramp nodes are pruned.
- **Save/load:** `bridge` survives a round trip with `format: 3`; a version-2 save loads as all
  ground.

### `traffic.test.ts`

- **Fixture:** `buildGrid(control, { flyover: true })` in `src/testutil.ts` adds a long diagonal
  bridge between two new dead ends, passing over two grid roads with no node at either crossing.
  Its ends are dead ends, so traffic spawns on it and uses it.
- **Clearance invariant:** only pairs with the same `levelOf` are checked. The lane-overlap
  invariant is unchanged (it compares vehicles on the same lane, which are at the same place).
- **Flyover runs:** the existing invariants and the arrivals-keep-rising check also run with the
  flyover. Direct check: the lane network has no node, and so no movement, within `MERGE_DIST` of
  either crossing point.
- **Mutation checks:** removing the level check from `firstCrossing` must fail the overpass
  test; removing the level exemption from the clearance test must fail the flyover run (proving
  bridge vehicles actually pass over ground ones).

### Browser check

Draw a bridge over a busy road with both Alt and the Bridge tool; confirm bridge vehicles draw
above ground ones, a ground stroke will not snap mid-span, and undo and reload keep the bridge.

## Documentation on completion

Move milestone 8 to the done list, update "1–8 are done", and add a "Bridges" section to
`.claude/memories.md`. Correct the roadmap statement that `addStroke` splits at every crossing
(now: only crossings on the same level).

## Out of scope

Bridge cost (milestone 9), stacking bridges, visual ramp slopes, bridge speed limits.
