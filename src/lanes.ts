import {
  type Vec2,
  dist,
  lerp,
  lineIntersection,
  normalize,
  polylineDistance,
  quadraticBezier,
  rightNormal,
  sub,
} from './geom';
import { type RoadGraph } from './graph';
import { JUNCTION_RADIUS, LANE_OFFSET, MOVEMENT_CLEARANCE } from './config';

export interface Lane {
  id: number;
  edgeId: number;
  from: number;
  to: number;
  points: Vec2[];
  /** Cumulative arc length at each vertex. */
  cum: number[];
  length: number;
}

export interface Pose {
  pos: Vec2;
  dir: Vec2;
}

/** One way through a junction: arrive on `inLane`, leave on `outLane`. */
export interface Movement {
  key: number;
  node: number;
  inLane: number;
  outLane: number;
  /** Keys of movements at the same node whose paths come too close to this one. */
  conflicts: Set<number>;
  /** The curve a vehicle actually drives through the junction. */
  path: Vec2[];
}

/** Shifts a polyline sideways onto its own lane, mitring each vertex between adjacent segments. */
function offsetPolyline(pts: Vec2[], offset: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    let nx = 0;
    let ny = 0;
    if (i > 0) {
      const n = rightNormal(normalize(sub(pts[i], pts[i - 1])));
      nx += n.x;
      ny += n.y;
    }
    if (i < pts.length - 1) {
      const n = rightNormal(normalize(sub(pts[i + 1], pts[i])));
      nx += n.x;
      ny += n.y;
    }
    const l = Math.hypot(nx, ny);
    if (l < 1e-9) out.push({ x: pts[i].x, y: pts[i].y });
    else out.push({ x: pts[i].x + (nx / l) * offset, y: pts[i].y + (ny / l) * offset });
  }
  return out;
}

function makeLane(id: number, edgeId: number, from: number, to: number, centre: Vec2[]): Lane {
  const points = offsetPolyline(centre, LANE_OFFSET);
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1], points[i]));
  return { id, edgeId, from, to, points, cum, length: cum[cum.length - 1] };
}

export class LaneNetwork {
  readonly lanes = new Map<number, Lane>();
  /** Node id -> lane ids leaving that node. */
  readonly outgoing = new Map<number, number[]>();
  /** Node id -> every way through that junction. */
  readonly movements = new Map<number, Movement[]>();
  private readonly movementIndex = new Map<string, Movement>();
  deadEnds: number[] = [];
  totalLength = 0;
  builtVersion = -1;

  build(graph: RoadGraph): void {
    this.lanes.clear();
    this.outgoing.clear();
    this.movements.clear();
    this.movementIndex.clear();
    this.deadEnds = [];
    this.totalLength = 0;

    for (const edge of graph.edges.values()) {
      const forward = makeLane(edge.id * 2, edge.id, edge.a, edge.b, edge.points);
      const backward = makeLane(edge.id * 2 + 1, edge.id, edge.b, edge.a, [...edge.points].reverse());
      for (const lane of [forward, backward]) {
        if (lane.length < 1e-6) continue;
        this.lanes.set(lane.id, lane);
        this.totalLength += lane.length;
        const list = this.outgoing.get(lane.from);
        if (list) list.push(lane.id);
        else this.outgoing.set(lane.from, [lane.id]);
      }
    }

    for (const node of graph.nodes.values()) {
      if (node.edges.length === 1) this.deadEnds.push(node.id);
    }
    this.buildMovements();
    this.builtVersion = graph.version;
  }

  /**
   * Enumerates every way through each junction and works out which pairs actually cross.
   * Paths are sampled a junction radius back from the node rather than at it: every lane ends
   * exactly at the node, so measured there the junction has no extent and nothing ever crosses.
   */
  private buildMovements(): void {
    const incoming = new Map<number, number[]>();
    for (const lane of this.lanes.values()) {
      const list = incoming.get(lane.to);
      if (list) list.push(lane.id);
      else incoming.set(lane.to, [lane.id]);
    }

    for (const [node, ins] of incoming) {
      const outs = this.outgoing.get(node) ?? [];
      const list: Movement[] = [];
      for (const inLane of ins) {
        for (const outLane of outs) {
          list.push({
            key: list.length,
            node,
            inLane,
            outLane,
            conflicts: new Set(),
            path: this.movementPath(inLane, outLane),
          });
        }
      }

      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          // Movements off the same approach share a queue, so car following already separates
          // them. Movements into the same exit always conflict, since they merge.
          if (list[a].inLane === list[b].inLane) continue;
          // Paths that merely pass close still conflict: two vehicles whose paths never cross
          // can otherwise clip each other where every lane converges on the node.
          const merges = list[a].outLane === list[b].outLane;
          if (merges || polylineDistance(list[a].path, list[b].path) < MOVEMENT_CLEARANCE) {
            list[a].conflicts.add(list[b].key);
            list[b].conflicts.add(list[a].key);
          }
        }
      }

      this.movements.set(node, list);
      for (const m of list) this.movementIndex.set(`${m.inLane}:${m.outLane}`, m);
    }
  }

  /**
   * The turning curve between two lanes. Its control point is where the two lane tangents meet,
   * which is the natural corner of the turn, so the curve stays on its own side instead of
   * running through the node where every lane converges. Vehicles are positioned along this
   * same curve while crossing, so conflict detection and where vehicles actually are agree.
   */
  private movementPath(inLaneId: number, outLaneId: number): Vec2[] {
    const inLane = this.lanes.get(inLaneId)!;
    const outLane = this.lanes.get(outLaneId)!;
    const entry = this.sample(inLane, Math.max(0, inLane.length - JUNCTION_RADIUS));
    const exit = this.sample(outLane, Math.min(outLane.length, JUNCTION_RADIUS));
    const corner = lineIntersection(entry.pos, entry.dir, exit.pos, exit.dir);
    if (!corner) return [entry.pos, exit.pos];
    // A control point behind the entry or beyond the exit means the tangents meet the wrong
    // way round (a U-turn); the straight chord is the sensible fallback.
    const ahead = (corner.x - entry.pos.x) * entry.dir.x + (corner.y - entry.pos.y) * entry.dir.y;
    const before = (exit.pos.x - corner.x) * exit.dir.x + (exit.pos.y - corner.y) * exit.dir.y;
    if (ahead <= 0 || before <= 0) return [entry.pos, exit.pos];
    return quadraticBezier(entry.pos, corner, exit.pos, 8);
  }

  movementFor(inLane: number, outLane: number): Movement | undefined {
    return this.movementIndex.get(`${inLane}:${outLane}`);
  }

  /** The lane covering `edgeId` when travelling away from `fromNode`. */
  laneFor(edgeId: number, fromNode: number, graph: RoadGraph): Lane | undefined {
    const edge = graph.edges.get(edgeId);
    if (!edge) return undefined;
    return this.lanes.get(edge.a === fromNode ? edgeId * 2 : edgeId * 2 + 1);
  }

  sample(lane: Lane, s: number): Pose {
    const clamped = Math.max(0, Math.min(lane.length, s));
    let lo = 0;
    let hi = lane.cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (lane.cum[mid] <= clamped) lo = mid;
      else hi = mid;
    }
    const segLen = lane.cum[lo + 1] - lane.cum[lo];
    const t = segLen < 1e-9 ? 0 : (clamped - lane.cum[lo]) / segLen;
    const a = lane.points[lo];
    const b = lane.points[lo + 1];
    return { pos: lerp(a, b, t), dir: normalize(sub(b, a)) };
  }
}
