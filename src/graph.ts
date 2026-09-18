import {
  type Vec2,
  clone,
  dist,
  lerp,
  normalize,
  slicePolyline,
  sub,
  arcLengthAt,
  closestOnPolyline,
  polylineLength,
  segmentIntersect,
  splitPolyline,
} from './geom';
import { simplify, smooth, nudgeEndpoint } from './simplify';
import {
  JUNCTION_RADIUS,
  JUNCTION_ZONE_ROAD_FRACTION,
  LANE_OFFSET,
  MERGE_DIST,
  MIN_ROAD_LENGTH,
  MOVEMENT_CLEARANCE,
  RAMP_LENGTH,
  SIMPLIFY_EPS,
  SMOOTH_PASSES,
  SNAP_RADIUS,
} from './config';

export type JunctionControl = 'signal' | 'priority' | 'roundabout';

export const JUNCTION_CONTROLS: readonly JunctionControl[] = ['signal', 'priority', 'roundabout'];

/**
 * Bumped when the saved shape changes; a save without one predates junction controls. 3 added
 * bridges; older saves simply have none.
 */
const FORMAT_VERSION = 3;

export interface RoadNode {
  id: number;
  pos: Vec2;
  /** Absent means a plain junction. Only meaningful at degree 3+; lower degrees ignore it. */
  control?: JunctionControl;
  /**
   * Priority junctions only: arrival bearing (radians) of one approach of the road the player made
   * major. Stored as a direction, not an edge id, because edge ids change whenever a road is split
   * while the bearing at this junction does not. Absent means "use the default rule".
   */
  majorBearing?: number;
  /** Incident edge ids. A self-loop appears twice: it meets the node at both ends. */
  edges: number[];
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  /** Full geometry, starting at node `a` and ending at node `b`. */
  points: Vec2[];
  /** A bridge crosses roads on the ground with no junction. Absent means a ground road. */
  bridge?: true;
}

/**
 * The elevated part of a road, as arc lengths from `a` (see `RoadGraph.elevatedRange`). An end at
 * an elevated node has no ramp, so the span reaches it: that bound is infinite.
 */
export interface Span {
  lo: number;
  hi: number;
}

export interface EdgeHit {
  edge: RoadEdge;
  segIdx: number;
  t: number;
  point: Vec2;
  dist: number;
}

/**
 * How far out from a node the junction box must reach so that, beyond it, the lanes of any two of
 * its roads are at least MOVEMENT_CLEARANCE apart. Two roads leaving at angle `a` each have a lane
 * LANE_OFFSET towards the other, and those lanes are `2 * (d sin(a/2) - LANE_OFFSET cos(a/2))`
 * apart `d` out, so the box reaches `(MOVEMENT_CLEARANCE / 2 + LANE_OFFSET cos(a/2)) / sin(a/2)`:
 * 4.1 m at a right angle (so JUNCTION_RADIUS), 8.8 m at 45 degrees, 14.7 m at 27. Inside the box
 * the junction's claims keep cars apart; outside it nothing does, so a fixed 5 m box let cars at a
 * sharp junction stand in each other's lanes. Capped at JUNCTION_ZONE_ROAD_FRACTION of the shortest
 * road (so sharper junctions on short roads still overlap a little), never below JUNCTION_RADIUS.
 */
function zoneFor(departures: Vec2[], shortest: number): number {
  let sharpest = Math.PI;
  for (let i = 0; i < departures.length; i++) {
    for (let j = i + 1; j < departures.length; j++) {
      const cos = departures[i].x * departures[j].x + departures[i].y * departures[j].y;
      sharpest = Math.min(sharpest, Math.acos(Math.max(-1, Math.min(1, cos))));
    }
  }
  const half = Math.max(sharpest / 2, 1e-3);
  const need = (MOVEMENT_CLEARANCE / 2 + LANE_OFFSET * Math.cos(half)) / Math.sin(half);
  return Math.max(JUNCTION_RADIUS, Math.min(need, shortest * JUNCTION_ZONE_ROAD_FRACTION));
}

/**
 * The direction a polyline leaves its first point in, taken a junction radius out (or halfway
 * along a short one) so a freehand wiggle at the very end does not decide it.
 */
function departure(pts: Vec2[], length: number): Vec2 {
  const out = slicePolyline(pts, 0, Math.min(JUNCTION_RADIUS, length / 2));
  return normalize(sub(out[out.length - 1], pts[0]));
}

function unlink(node: RoadNode | undefined, edgeId: number): void {
  if (!node) return;
  const i = node.edges.indexOf(edgeId);
  if (i >= 0) node.edges.splice(i, 1);
}

interface Piece {
  pts: Vec2[];
  a: number;
  b: number;
  /** Bridge strokes only: whether each end meets the ground, so a ramp starts there. */
  rampA: boolean;
  rampB: boolean;
}

interface Crossing {
  s: number;
  edge: RoadEdge;
  pSegIdx: number;
  pT: number;
  eSegIdx: number;
  eT: number;
}

interface SelfCrossing {
  i: number;
  t: number;
  j: number;
  u: number;
  point: Vec2;
}

export class RoadGraph {
  readonly nodes = new Map<number, RoadNode>();
  readonly edges = new Map<number, RoadEdge>();
  private nextNode = 1;
  private nextEdge = 1;
  /** Bumped on every structural change so dependants know to rebuild. */
  version = 0;
  /** Edge geometry never changes after creation, so lengths are cached per edge object. */
  private readonly lengths = new WeakMap<RoadEdge, number>();
  /** Junction boxes by node, valid for `zonesVersion`; any change to the graph can alter them. */
  private readonly zones = new Map<number, number>();
  private zonesVersion = -1;

  addNode(pos: Vec2): RoadNode {
    const node: RoadNode = { id: this.nextNode++, pos: clone(pos), edges: [] };
    this.nodes.set(node.id, node);
    this.version++;
    return node;
  }

  addEdge(a: number, b: number, points: Vec2[], bridge = false): RoadEdge {
    const edge: RoadEdge = { id: this.nextEdge++, a, b, points };
    if (bridge) edge.bridge = true;
    // Keep geometry exactly incident to its endpoints so the graph stays watertight.
    edge.points[0] = clone(this.nodes.get(a)!.pos);
    edge.points[edge.points.length - 1] = clone(this.nodes.get(b)!.pos);
    this.edges.set(edge.id, edge);
    this.nodes.get(a)!.edges.push(edge.id);
    this.nodes.get(b)!.edges.push(edge.id);
    this.version++;
    return edge;
  }

  removeEdge(id: number): void {
    const edge = this.edges.get(id);
    if (!edge) return;
    unlink(this.nodes.get(edge.a), id);
    unlink(this.nodes.get(edge.b), id);
    this.edges.delete(id);
    this.version++;
  }

  pruneOrphans(): void {
    for (const node of [...this.nodes.values()]) {
      if (node.edges.length === 0) {
        this.nodes.delete(node.id);
        this.version++;
      }
    }
  }

  /** Sets or clears a node's junction control. Returns false if the node cannot take one. */
  setControl(id: number, control: JunctionControl | null): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    if (control) {
      if (node.edges.length < 3) return false;
      node.control = control;
    } else {
      delete node.control;
    }
    if (control !== 'priority') delete node.majorBearing;
    this.version++;
    return true;
  }

  /** Records which road the player chose as major at a priority junction; null returns to the default rule. */
  setMajorBearing(id: number, bearing: number | null): boolean {
    const node = this.nodes.get(id);
    if (!node || node.control !== 'priority') return false;
    if (bearing === null) delete node.majorBearing;
    else node.majorBearing = bearing;
    this.version++;
    return true;
  }

  edgeLength(edge: RoadEdge): number {
    let length = this.lengths.get(edge);
    if (length === undefined) {
      length = polylineLength(edge.points);
      this.lengths.set(edge, length);
    }
    return length;
  }

  /**
   * A node is up on the bridges when at least two roads meet there and every one is a bridge: a
   * bridge/bridge junction. Anything else is on the ground, including a bridge's dead end.
   */
  isElevatedNode(id: number): boolean {
    const node = this.nodes.get(id);
    if (!node || node.edges.length < 2) return false;
    return node.edges.every((e) => this.edges.get(e)?.bridge);
  }

  /**
   * How far the junction box at a node reaches along each of its roads: sized from the sharpest
   * angle between them (see `zoneFor`). JUNCTION_RADIUS at a dead end. `extra` is a road about to
   * join the node, given as the polyline leaving it, so a stroke can size a ramp before its edge
   * exists.
   */
  junctionZone(id: number, extra?: Vec2[]): number {
    if (!extra) {
      if (this.zonesVersion !== this.version) {
        this.zones.clear();
        this.zonesVersion = this.version;
      }
      const cached = this.zones.get(id);
      if (cached !== undefined) return cached;
    }
    const node = this.nodes.get(id);
    if (!node) return JUNCTION_RADIUS;
    const departures: Vec2[] = [];
    let shortest = Infinity;
    // A self-loop is listed twice and leaves the node from both of its ends.
    const loopsSeen = new Set<number>();
    for (const edgeId of node.edges) {
      const edge = this.edges.get(edgeId)!;
      const length = this.edgeLength(edge);
      const fromA = edge.a === id && !(edge.b === id && loopsSeen.has(edgeId));
      if (edge.a === id && edge.b === id) loopsSeen.add(edgeId);
      departures.push(departure(fromA ? edge.points : [...edge.points].reverse(), length));
      shortest = Math.min(shortest, length);
    }
    if (extra) {
      const length = polylineLength(extra);
      departures.push(departure(extra, length));
      shortest = Math.min(shortest, length);
    }
    const zone = departures.length < 2 ? JUNCTION_RADIUS : zoneFor(departures, shortest);
    if (!extra) this.zones.set(id, zone);
    return zone;
  }

  /** How long a bridge's ramp down to a ground node is: at least RAMP_LENGTH, and the whole box. */
  rampLength(id: number, extra?: Vec2[]): number {
    return Math.max(RAMP_LENGTH, this.junctionZone(id, extra));
  }

  /**
   * Where along an edge (arc length from `a`) it is elevated, or null if nowhere. Each end that
   * meets the ground has a ramp at ground level (`rampLength`); an end at an elevated node has none,
   * so the span runs all the way to it (an infinite bound, which also covers the virtual negative
   * positions of vehicles in that node's box). A bridge too short for its ramps is all ground.
   */
  elevatedRange(edge: RoadEdge): Span | null {
    if (!edge.bridge) return null;
    const length = this.edgeLength(edge);
    const lo = this.isElevatedNode(edge.a) ? -Infinity : this.rampLength(edge.a);
    const hi = this.isElevatedNode(edge.b) ? Infinity : length - this.rampLength(edge.b);
    return Math.max(lo, 0) < Math.min(hi, length) ? { lo, hi } : null;
  }

  isElevatedAt(edge: RoadEdge, s: number): boolean {
    const span = this.elevatedRange(edge);
    return !!span && s > span.lo && s < span.hi;
  }

  /** `groundOnly` skips elevated nodes, which a stroke on the ground passes under. */
  nodeNear(pos: Vec2, radius: number, groundOnly = false): RoadNode | null {
    let best: RoadNode | null = null;
    let bestDist = radius;
    for (const node of this.nodes.values()) {
      if (groundOnly && this.isElevatedNode(node.id)) continue;
      const d = dist(pos, node.pos);
      if (d <= bestDist) {
        bestDist = d;
        best = node;
      }
    }
    return best;
  }

  /** `groundOnly` skips a road where the nearest point on it is elevated. */
  edgeNear(pos: Vec2, radius: number, groundOnly = false): EdgeHit | null {
    let best: EdgeHit | null = null;
    for (const edge of this.edges.values()) {
      const hit = closestOnPolyline(pos, edge.points);
      if (!hit || hit.dist > radius) continue;
      if (groundOnly && this.isElevatedAt(edge, arcLengthAt(edge.points, hit.segIdx, hit.t))) continue;
      if (!best || hit.dist < best.dist) {
        best = { edge, segIdx: hit.segIdx, t: hit.t, point: hit.point, dist: hit.dist };
      }
    }
    return best;
  }

  /** Splits an edge in two and returns the junction node. Near-endpoint splits reuse that endpoint. */
  splitEdge(edgeId: number, segIdx: number, t: number): number {
    const edge = this.edges.get(edgeId)!;
    const pos = lerp(edge.points[segIdx], edge.points[segIdx + 1], t);
    const a = this.nodes.get(edge.a)!;
    const b = this.nodes.get(edge.b)!;
    if (dist(pos, a.pos) < MERGE_DIST) return a.id;
    if (dist(pos, b.pos) < MERGE_DIST) return b.id;

    const [left, right] = splitPolyline(edge.points, segIdx, t);
    const node = this.addNode(pos);
    this.removeEdge(edgeId);
    this.addEdge(edge.a, node.id, left, edge.bridge);
    this.addEdge(node.id, edge.b, right, edge.bridge);
    return node.id;
  }

  /**
   * Turns a raw freehand stroke into road segments: cleans the geometry, welds both
   * ends onto whatever is already there, and splits at every crossing it makes. A bridge only
   * splits where it meets another road at its own level: its ramps cross the ground like any road,
   * its elevated span crosses only other spans, and ground roads pass under it.
   */
  addStroke(raw: Vec2[], opts: { bridge?: boolean } = {}): boolean {
    const bridge = !!opts.bridge;
    const smoothed = smooth(simplify(raw, SIMPLIFY_EPS), SMOOTH_PASSES);
    const pts = simplify(smoothed, SIMPLIFY_EPS * 0.3);
    if (pts.length < 2 || polylineLength(pts) < MIN_ROAD_LENGTH) return false;

    const a = this.weldEndpoint(pts, true, bridge);
    const b = this.weldEndpoint(pts, false, bridge);
    // An end meets the ground unless it will be elevated once this bridge joins it: every road
    // already there is a bridge. A fresh dead end has no roads yet and is a ramp, as it should be.
    const ramp = (id: number) => {
      const edges = this.nodes.get(id)!.edges;
      return !bridge || edges.length === 0 || !edges.every((e) => this.edges.get(e)?.bridge);
    };

    const queue: Piece[] = [{ pts, a, b, rampA: ramp(a), rampB: ramp(b) }];
    while (queue.length) {
      const piece = queue.pop()!;

      const self = this.firstSelfCrossing(piece.pts);
      if (self) {
        // A stroke crossing itself makes a junction at its own level, so on a bridge it is up top.
        const node = this.addNode(self.point);
        const [left, rest] = splitPolyline(piece.pts, self.i, self.t);
        const [mid, right] = splitPolyline(rest, self.j - self.i, self.u);
        queue.push(
          { pts: left, a: piece.a, b: node.id, rampA: piece.rampA, rampB: !bridge },
          { pts: mid, a: node.id, b: node.id, rampA: !bridge, rampB: !bridge },
          { pts: right, a: node.id, b: piece.b, rampA: !bridge, rampB: piece.rampB },
        );
        continue;
      }

      const cross = this.firstCrossing(piece, bridge);
      if (cross) {
        const node = this.splitEdge(cross.edge.id, cross.eSegIdx, cross.eT);
        const [left, right] = splitPolyline(piece.pts, cross.pSegIdx, cross.pT);
        queue.push(
          { pts: left, a: piece.a, b: node, rampA: piece.rampA, rampB: ramp(node) },
          { pts: right, a: node, b: piece.b, rampA: ramp(node), rampB: piece.rampB },
        );
        continue;
      }

      if (polylineLength(piece.pts) > 1e-6) this.addEdge(piece.a, piece.b, piece.pts, bridge);
    }
    return true;
  }

  /**
   * Whether a piece of a stroke is elevated `s` along it, by the same rule as `elevatedRange`:
   * ramps at the ends that meet the ground, too short for both ramps means all ground. Each ramp is
   * sized for its junction with this piece already joined to it.
   */
  private pieceElevatedAt(piece: Piece, bridge: boolean, s: number, total: number): boolean {
    if (!bridge) return false;
    const lo = piece.rampA ? this.rampLength(piece.a, piece.pts) : -Infinity;
    const hi = piece.rampB ? total - this.rampLength(piece.b, [...piece.pts].reverse()) : Infinity;
    return Math.max(lo, 0) < Math.min(hi, total) && s > lo && s < hi;
  }

  /**
   * Where a stroke end welds. A bridge end welds to anything: onto the ground that makes a ramp,
   * onto another bridge a junction up top. A ground end passes under bridges, so it welds only to
   * roads and nodes on the ground (a bridge's ramp node included).
   */
  private weldEndpoint(pts: Vec2[], atStart: boolean, bridge: boolean): number {
    const p = pts[atStart ? 0 : pts.length - 1];

    const node = this.nodeNear(p, SNAP_RADIUS, !bridge);
    if (node) {
      nudgeEndpoint(pts, atStart, node.pos, SNAP_RADIUS * 2);
      return node.id;
    }

    const hit = this.edgeNear(p, SNAP_RADIUS, !bridge);
    if (hit) {
      const id = this.splitEdge(hit.edge.id, hit.segIdx, hit.t);
      nudgeEndpoint(pts, atStart, this.nodes.get(id)!.pos, SNAP_RADIUS * 2);
      return id;
    }

    return this.addNode(p).id;
  }

  /** The first crossing along a piece with a road at the same level at that point. */
  private firstCrossing(piece: Piece, bridge: boolean): Crossing | null {
    const pts = piece.pts;
    const total = polylineLength(pts);
    let best: Crossing | null = null;
    for (const edge of this.edges.values()) {
      for (let i = 0; i < pts.length - 1; i++) {
        for (let j = 0; j < edge.points.length - 1; j++) {
          const hit = segmentIntersect(pts[i], pts[i + 1], edge.points[j], edge.points[j + 1]);
          if (!hit) continue;
          const s = arcLengthAt(pts, i, hit.t);
          // A crossing sitting on this piece's own ends is the junction it is already welded to.
          if (s < MERGE_DIST || total - s < MERGE_DIST) continue;
          if (best && s >= best.s) continue;
          // One road over the other: no junction.
          const up = this.pieceElevatedAt(piece, bridge, s, total);
          if (up !== this.isElevatedAt(edge, arcLengthAt(edge.points, j, hit.u))) continue;
          best = { s, edge, pSegIdx: i, pT: hit.t, eSegIdx: j, eT: hit.u };
        }
      }
    }
    return best;
  }

  private firstSelfCrossing(pts: Vec2[]): SelfCrossing | null {
    const total = polylineLength(pts);
    for (let i = 0; i < pts.length - 1; i++) {
      for (let j = i + 2; j < pts.length - 1; j++) {
        const hit = segmentIntersect(pts[i], pts[i + 1], pts[j], pts[j + 1]);
        if (!hit) continue;
        const s1 = arcLengthAt(pts, i, hit.t);
        const s2 = arcLengthAt(pts, j, hit.u);
        if (s2 - s1 < MERGE_DIST) continue;
        if (s1 < MERGE_DIST && total - s2 < MERGE_DIST) continue;
        return { i, t: hit.t, j, u: hit.u, point: hit.point };
      }
    }
    return null;
  }

  totalLength(): number {
    let total = 0;
    for (const edge of this.edges.values()) total += polylineLength(edge.points);
    return total;
  }

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.version++;
  }

  toJSON(): string {
    return JSON.stringify({
      format: FORMAT_VERSION,
      nextNode: this.nextNode,
      nextEdge: this.nextEdge,
      nodes: [...this.nodes.values()].map((n) => ({
        id: n.id,
        pos: n.pos,
        control: n.control,
        majorBearing: n.majorBearing,
      })),
      edges: [...this.edges.values()].map((e) => ({ id: e.id, a: e.a, b: e.b, points: e.points, bridge: e.bridge })),
    });
  }

  loadJSON(raw: string): void {
    const data = JSON.parse(raw) as {
      nextNode: number;
      nextEdge: number;
      nodes: Array<{ id: number; pos: Vec2; control?: JunctionControl; majorBearing?: number }>;
      edges: Array<{ id: number; a: number; b: number; points: Vec2[]; bridge?: boolean }>;
    };
    this.clear();
    // Ids never go backwards, even when an older snapshot is restored. Traffic refers to lanes
    // by id, so an id that came back meaning a different road would teleport vehicles onto it.
    this.nextNode = Math.max(this.nextNode, data.nextNode);
    this.nextEdge = Math.max(this.nextEdge, data.nextEdge);
    for (const n of data.nodes) {
      const node: RoadNode = { id: n.id, pos: n.pos, edges: [] };
      if (n.control && JUNCTION_CONTROLS.includes(n.control)) node.control = n.control;
      if (node.control === 'priority' && typeof n.majorBearing === 'number') node.majorBearing = n.majorBearing;
      this.nodes.set(n.id, node);
    }
    for (const e of data.edges) {
      const edge: RoadEdge = { id: e.id, a: e.a, b: e.b, points: e.points };
      if (e.bridge === true) edge.bridge = true;
      this.edges.set(e.id, edge);
      this.nodes.get(e.a)!.edges.push(e.id);
      this.nodes.get(e.b)!.edges.push(e.id);
    }
  }
}
