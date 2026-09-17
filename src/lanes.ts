import { type Vec2, dist, lerp, normalize, rightNormal, sub } from './geom';
import { type RoadGraph } from './graph';
import { LANE_OFFSET } from './config';

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
  deadEnds: number[] = [];
  totalLength = 0;
  builtVersion = -1;

  build(graph: RoadGraph): void {
    this.lanes.clear();
    this.outgoing.clear();
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
    this.builtVersion = graph.version;
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
