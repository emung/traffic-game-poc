import {
  type Vec2,
  clone,
  dist,
  lerp,
  arcLengthAt,
  closestOnPolyline,
  polylineLength,
  segmentIntersect,
  splitPolyline,
} from './geom';
import { simplify, smooth, nudgeEndpoint } from './simplify';
import { MERGE_DIST, MIN_ROAD_LENGTH, SIMPLIFY_EPS, SMOOTH_PASSES, SNAP_RADIUS } from './config';

export type JunctionControl = 'signal' | 'priority' | 'roundabout';

export const JUNCTION_CONTROLS: readonly JunctionControl[] = ['signal', 'priority', 'roundabout'];

/** Bumped when the saved shape changes; a save without one predates junction controls. */
const FORMAT_VERSION = 2;

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
}

export interface EdgeHit {
  edge: RoadEdge;
  segIdx: number;
  t: number;
  point: Vec2;
  dist: number;
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

  addNode(pos: Vec2): RoadNode {
    const node: RoadNode = { id: this.nextNode++, pos: clone(pos), edges: [] };
    this.nodes.set(node.id, node);
    this.version++;
    return node;
  }

  addEdge(a: number, b: number, points: Vec2[]): RoadEdge {
    const edge: RoadEdge = { id: this.nextEdge++, a, b, points };
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

  nodeNear(pos: Vec2, radius: number): RoadNode | null {
    let best: RoadNode | null = null;
    let bestDist = radius;
    for (const node of this.nodes.values()) {
      const d = dist(pos, node.pos);
      if (d <= bestDist) {
        bestDist = d;
        best = node;
      }
    }
    return best;
  }

  edgeNear(pos: Vec2, radius: number): EdgeHit | null {
    let best: EdgeHit | null = null;
    for (const edge of this.edges.values()) {
      const hit = closestOnPolyline(pos, edge.points);
      if (!hit || hit.dist > radius) continue;
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
    this.addEdge(edge.a, node.id, left);
    this.addEdge(node.id, edge.b, right);
    return node.id;
  }

  /**
   * Turns a raw freehand stroke into road segments: cleans the geometry, welds both
   * ends onto whatever is already there, and splits at every crossing it makes.
   */
  addStroke(raw: Vec2[]): boolean {
    const smoothed = smooth(simplify(raw, SIMPLIFY_EPS), SMOOTH_PASSES);
    const pts = simplify(smoothed, SIMPLIFY_EPS * 0.3);
    if (pts.length < 2 || polylineLength(pts) < MIN_ROAD_LENGTH) return false;

    const a = this.weldEndpoint(pts, true);
    const b = this.weldEndpoint(pts, false);

    const queue: Piece[] = [{ pts, a, b }];
    while (queue.length) {
      const piece = queue.pop()!;

      const self = this.firstSelfCrossing(piece.pts);
      if (self) {
        const node = this.addNode(self.point);
        const [left, rest] = splitPolyline(piece.pts, self.i, self.t);
        const [mid, right] = splitPolyline(rest, self.j - self.i, self.u);
        queue.push(
          { pts: left, a: piece.a, b: node.id },
          { pts: mid, a: node.id, b: node.id },
          { pts: right, a: node.id, b: piece.b },
        );
        continue;
      }

      const cross = this.firstCrossing(piece.pts);
      if (cross) {
        const node = this.splitEdge(cross.edge.id, cross.eSegIdx, cross.eT);
        const [left, right] = splitPolyline(piece.pts, cross.pSegIdx, cross.pT);
        queue.push({ pts: left, a: piece.a, b: node }, { pts: right, a: node, b: piece.b });
        continue;
      }

      if (polylineLength(piece.pts) > 1e-6) this.addEdge(piece.a, piece.b, piece.pts);
    }
    return true;
  }

  private weldEndpoint(pts: Vec2[], atStart: boolean): number {
    const p = pts[atStart ? 0 : pts.length - 1];

    const node = this.nodeNear(p, SNAP_RADIUS);
    if (node) {
      nudgeEndpoint(pts, atStart, node.pos, SNAP_RADIUS * 2);
      return node.id;
    }

    const hit = this.edgeNear(p, SNAP_RADIUS);
    if (hit) {
      const id = this.splitEdge(hit.edge.id, hit.segIdx, hit.t);
      nudgeEndpoint(pts, atStart, this.nodes.get(id)!.pos, SNAP_RADIUS * 2);
      return id;
    }

    return this.addNode(p).id;
  }

  private firstCrossing(pts: Vec2[]): Crossing | null {
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
          if (!best || s < best.s) {
            best = { s, edge, pSegIdx: i, pT: hit.t, eSegIdx: j, eT: hit.u };
          }
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
      edges: [...this.edges.values()].map((e) => ({ id: e.id, a: e.a, b: e.b, points: e.points })),
    });
  }

  loadJSON(raw: string): void {
    const data = JSON.parse(raw) as {
      nextNode: number;
      nextEdge: number;
      nodes: Array<{ id: number; pos: Vec2; control?: JunctionControl; majorBearing?: number }>;
      edges: Array<{ id: number; a: number; b: number; points: Vec2[] }>;
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
      this.edges.set(e.id, { id: e.id, a: e.a, b: e.b, points: e.points });
      this.nodes.get(e.a)!.edges.push(e.id);
      this.nodes.get(e.b)!.edges.push(e.id);
    }
  }
}
