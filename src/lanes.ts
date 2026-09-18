import {
  type Vec2,
  dist,
  lerp,
  lineIntersection,
  normalize,
  polylineDistance,
  polylineLength,
  quadraticBezier,
  rightNormal,
  sub,
} from './geom';
import { type JunctionControl, type RoadGraph, type Span } from './graph';
import {
  JUNCTION_RADIUS,
  LANE_OFFSET,
  MOVEMENT_CLEARANCE,
  RAMP_LENGTH,
  ROUNDABOUT_RING_FRACTION,
  ROUNDABOUT_ZONE,
} from './config';
import { smooth } from './simplify';

/** Straightness scores this close count as a tie when ranking candidate major roads. */
const AXIS_TIE = 0.05;
/** How much less straight than the best a pair may be and still be offered as a major road. */
const AXIS_CANDIDATE_SLACK = 0.3;
/** How close (radians) a stored bearing must be to an approach to select its road. */
const BEARING_MATCH = 0.35;

/** Two approaches count as opposite when their arrival directions have a dot product below this. */
const OPPOSITE_DOT = -0.7;

export interface Lane {
  id: number;
  edgeId: number;
  from: number;
  to: number;
  points: Vec2[];
  /** Cumulative arc length at each vertex. */
  cum: number[];
  length: number;
  /** Where the lane is up on a bridge, in lane arc length; null on the ground. See `RoadGraph.elevatedRange`. */
  elevated: Span | null;
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
  /** How far back from the node the box starts, and how far past it ends: the node's zone. */
  zone: number;
  /**
   * Distance a vehicle travels through the box. For a plain junction the box is `2 * zone` of lane
   * distance and the path is sampled by fraction; for a roundabout it is the true arc length, so a
   * car covers the ring at its real speed instead of speeding up on long arcs and bunching up on
   * short ones. The difference from `2 * zone` is added when the vehicle changes lane.
   */
  span: number;
  /** Roundabout movements only: where the path meets the ring, for judging who yields to whom. */
  ring?: {
    /** Ring angle at entry, and how far the arc runs anticlockwise (decreasing angle) to the exit. */
    entry: number;
    sweep: number;
    radius: number;
    /** Distance along the path at which it joins and leaves the ring. */
    pathIn: number;
    pathOut: number;
  };
  /** Keys of major-road movements this one must give way to (priority junctions, minor road only). */
  yieldsTo: number[];
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
  return { id, edgeId, from, to, points, cum, length: cum[cum.length - 1], elevated: null };
}

export class LaneNetwork {
  readonly lanes = new Map<number, Lane>();
  /** Node id -> lane ids leaving that node. */
  readonly outgoing = new Map<number, number[]>();
  /** Node id -> every way through that junction. */
  readonly movements = new Map<number, Movement[]>();
  private readonly movementIndex = new Map<string, Movement>();
  /** Node id -> its control. Only nodes where it applies (three or more roads) are listed. */
  readonly controls = new Map<number, JunctionControl>();
  /** Signalised node id -> its phases in cycle order, each the incoming lanes green together. */
  readonly phases = new Map<number, number[][]>();
  /** Priority node id -> its incoming lanes on the major road. Every other approach is minor. */
  readonly majorLanes = new Map<number, Set<number>>();
  /** Roundabout node id -> the radius of its box (where vehicles enter and leave the ring). */
  private readonly roundaboutZones = new Map<number, number>();
  /** Junctions (three or more roads) with no control: vehicles slow down through these. */
  readonly plainJunctions = new Set<number>();
  /** Priority node id -> the player's chosen major-road bearing, when there is one. */
  private readonly majorBearings = new Map<number, number>();
  deadEnds: number[] = [];
  totalLength = 0;
  builtVersion = -1;

  build(graph: RoadGraph): void {
    this.lanes.clear();
    this.outgoing.clear();
    this.movements.clear();
    this.movementIndex.clear();
    this.controls.clear();
    this.phases.clear();
    this.majorLanes.clear();
    this.plainJunctions.clear();
    this.roundaboutZones.clear();
    this.majorBearings.clear();
    this.deadEnds = [];
    this.totalLength = 0;

    for (const edge of graph.edges.values()) {
      const forward = makeLane(edge.id * 2, edge.id, edge.a, edge.b, edge.points);
      const backward = makeLane(edge.id * 2 + 1, edge.id, edge.b, edge.a, [...edge.points].reverse());
      const span = graph.elevatedRange(edge);
      if (span) {
        // Ramps are measured on each lane itself, not scaled from the centreline, so a ramp is
        // exactly RAMP_LENGTH on every lane and always covers the junction box at its end.
        const rampA = Number.isFinite(span.lo);
        const rampB = Number.isFinite(span.hi);
        forward.elevated = {
          lo: rampA ? RAMP_LENGTH : -Infinity,
          hi: rampB ? forward.length - RAMP_LENGTH : Infinity,
        };
        backward.elevated = {
          lo: rampB ? RAMP_LENGTH : -Infinity,
          hi: rampA ? backward.length - RAMP_LENGTH : Infinity,
        };
      }
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
      // A control on a node that lost roads keeps its value in the graph but does nothing here.
      if (node.control && node.edges.length >= 3) {
        this.controls.set(node.id, node.control);
        if (node.control === 'priority' && node.majorBearing !== undefined) {
          this.majorBearings.set(node.id, node.majorBearing);
        }
      } else if (node.edges.length >= 3) {
        this.plainJunctions.add(node.id);
      }
    }
    this.buildRoundaboutZones();
    this.buildMovements(graph);
    this.buildApproaches();
    this.buildPriority();
    this.builtVersion = graph.version;
  }

  /**
   * Enumerates every way through each junction and works out which pairs actually cross.
   * Paths are sampled a junction radius back from the node rather than at it: every lane ends
   * exactly at the node, so measured there the junction has no extent and nothing ever crosses.
   */
  private buildMovements(graph: RoadGraph): void {
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
            yieldsTo: [],
            path: [],
            zone: this.zoneOf(node),
            span: 0,
          });
        }
      }

      const centre = graph.nodes.get(node)!.pos;
      for (const m of list) {
        m.path = this.movementPath(m.inLane, m.outLane, node, centre);
        const round = this.controls.get(node) === 'roundabout';
        m.span = round ? polylineLength(m.path) : 2 * m.zone;
        if (round) m.ring = this.ringOf(m, centre);
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
   * Splits each signal's approaches into phases. Approaches arriving from opposite directions
   * share a phase, since their straight-throughs never meet, which halves the wait of a plain
   * one-at-a-time cycle. A left turn still crosses the opposing straight-through; that stays
   * permissive, because the claim-time conflict check makes it wait for a gap. Pairs are picked
   * greedily by how many of their movements can run together, and an approach with no opposite
   * (the stem of a T) gets a phase of its own.
   */
  private buildApproaches(): void {
    for (const [node, control] of this.controls) {
      if (control !== 'signal') continue;
      const ins = [...this.lanes.values()].filter((l) => l.to === node);
      const dirOf = (l: Lane) => {
        const p = l.points;
        return normalize(sub(p[p.length - 1], p[p.length - 2]));
      };
      const angle = (l: Lane) => Math.atan2(dirOf(l).y, dirOf(l).x);
      ins.sort((a, b) => angle(a) - angle(b) || a.id - b.id);

      const movements = this.movements.get(node) ?? [];
      const compatible = (a: Lane, b: Lane) => {
        let n = 0;
        for (const ma of movements) {
          if (ma.inLane !== a.id) continue;
          for (const mb of movements) if (mb.inLane === b.id && !ma.conflicts.has(mb.key)) n++;
        }
        return n;
      };

      const pairs: Array<{ i: number; j: number; score: number }> = [];
      for (let i = 0; i < ins.length; i++) {
        for (let j = i + 1; j < ins.length; j++) {
          const da = dirOf(ins[i]);
          const db = dirOf(ins[j]);
          if (da.x * db.x + da.y * db.y > OPPOSITE_DOT) continue;
          pairs.push({ i, j, score: compatible(ins[i], ins[j]) });
        }
      }
      pairs.sort((p, q) => q.score - p.score || p.i - q.i);

      const phaseOf = new Array<number>(ins.length).fill(-1);
      const groups: number[][] = [];
      for (const { i, j } of pairs) {
        if (phaseOf[i] >= 0 || phaseOf[j] >= 0) continue;
        phaseOf[i] = phaseOf[j] = groups.length;
        groups.push([i, j]);
      }
      for (let i = 0; i < ins.length; i++) {
        if (phaseOf[i] < 0) groups.push([i]);
      }
      groups.sort((g, h) => g[0] - h[0]);
      this.phases.set(
        node,
        groups.map((g) => g.map((i) => ins[i].id)),
      );
    }
  }

  /**
   * The roads that could be a priority junction's major road, best first: pairs of approaches
   * close to a straight line through the node. Pairs within `AXIS_TIE` of the straightest count as
   * tied, and among tied pairs the longer roads win, since a long road is the likelier main road
   * (a tie is the normal case at a four-way, where both axes are dead straight). Remaining ties
   * fall back to arrival angle so the order is deterministic. A T has one candidate, an X two.
   */
  priorityAxes(node: number): Array<{ lanes: [number, number]; bearing: number }> {
    const ins = [...this.lanes.values()].filter((l) => l.to === node);
    const dirOf = (l: Lane) => {
      const p = l.points;
      return normalize(sub(p[p.length - 1], p[p.length - 2]));
    };
    const bearingOf = (l: Lane) => Math.atan2(dirOf(l).y, dirOf(l).x);
    ins.sort((a, b) => bearingOf(a) - bearingOf(b) || a.id - b.id);

    const pairs: Array<{ a: Lane; b: Lane; dot: number; length: number; order: number }> = [];
    for (let i = 0; i < ins.length; i++) {
      for (let j = i + 1; j < ins.length; j++) {
        const da = dirOf(ins[i]);
        const db = dirOf(ins[j]);
        pairs.push({
          a: ins[i],
          b: ins[j],
          dot: da.x * db.x + da.y * db.y,
          length: ins[i].length + ins[j].length,
          order: pairs.length,
        });
      }
    }
    if (pairs.length === 0) return [];
    const straightest = Math.min(...pairs.map((p) => p.dot));
    return pairs
      .filter((p) => p.dot <= straightest + AXIS_CANDIDATE_SLACK)
      .sort((p, q) => {
        if (Math.abs(p.dot - q.dot) > AXIS_TIE) return p.dot - q.dot;
        return q.length - p.length || p.order - q.order;
      })
      .map((p) => ({ lanes: [p.a.id, p.b.id] as [number, number], bearing: bearingOf(p.a) }));
  }

  /** The bearing to store so the next axis in `priorityAxes` becomes the major road; unchanged if there is only one. */
  nextMajorBearing(node: number): number | null {
    const axes = this.priorityAxes(node);
    const current = this.majorLanes.get(node);
    if (axes.length < 2 || !current) return null;
    const at = axes.findIndex((x) => x.lanes.every((id) => current.has(id)));
    return axes[(at + 1) % axes.length].bearing;
  }

  /**
   * Picks each priority junction's major road: the player's choice if they made one (matched by
   * bearing), otherwise the best `priorityAxes` candidate. Every other approach is minor and gives
   * way to any major-road movement it would cross. Major roads never give way, so no two
   * movements at one node can wait on each other.
   */
  private buildPriority(): void {
    for (const [node, control] of this.controls) {
      if (control !== 'priority') continue;
      const axes = this.priorityAxes(node);
      if (axes.length === 0) continue;

      let chosen = axes[0];
      const wanted = this.majorBearings.get(node);
      if (wanted !== undefined) {
        let bestDiff = BEARING_MATCH;
        for (const axis of axes) {
          for (const id of axis.lanes) {
            const l = this.lanes.get(id)!;
            const p = l.points;
            const bearing = Math.atan2(p[p.length - 1].y - p[p.length - 2].y, p[p.length - 1].x - p[p.length - 2].x);
            const diff = Math.abs(Math.atan2(Math.sin(bearing - wanted), Math.cos(bearing - wanted)));
            if (diff < bestDiff) {
              bestDiff = diff;
              chosen = axis;
            }
          }
        }
      }

      const major = new Set<number>(chosen.lanes);
      this.majorLanes.set(node, major);

      const movements = this.movements.get(node) ?? [];
      for (const m of movements) {
        if (major.has(m.inLane)) continue;
        for (const other of movements) {
          if (major.has(other.inLane) && m.conflicts.has(other.key)) m.yieldsTo.push(other.key);
        }
      }
    }
  }

  /**
   * The turning curve between two lanes. Its control point is where the two lane tangents meet,
   * which is the natural corner of the turn, so the curve stays on its own side instead of
   * running through the node where every lane converges. Vehicles are positioned along this
   * same curve while crossing, so conflict detection and where vehicles actually are agree.
   */
  private movementPath(inLaneId: number, outLaneId: number, node: number, centre: Vec2): Vec2[] {
    const inLane = this.lanes.get(inLaneId)!;
    const outLane = this.lanes.get(outLaneId)!;
    const zone = this.zoneOf(node);
    if (this.controls.get(node) === 'roundabout' && inLane.edgeId !== outLane.edgeId) {
      return this.ringPath(inLane, outLane, zone, centre);
    }
    const entry = this.sample(inLane, Math.max(0, inLane.length - zone));
    const exit = this.sample(outLane, Math.min(outLane.length, zone));
    const corner = lineIntersection(entry.pos, entry.dir, exit.pos, exit.dir);
    if (!corner) return [entry.pos, exit.pos];
    // A control point behind the entry or beyond the exit means the tangents meet the wrong
    // way round (a U-turn); the straight chord is the sensible fallback.
    const ahead = (corner.x - entry.pos.x) * entry.dir.x + (corner.y - entry.pos.y) * entry.dir.y;
    const before = (exit.pos.x - corner.x) * exit.dir.x + (exit.pos.y - corner.y) * exit.dir.y;
    if (ahead <= 0 || before <= 0) return [entry.pos, exit.pos];
    return quadraticBezier(entry.pos, corner, exit.pos, 8);
  }

  /**
   * Where a roundabout movement runs round the ring. The ring section is the stretch of the path
   * between the entry point and the exit point, a fixed distance in from each end of the path.
   * Undefined for a U-turn (a chord that never uses the ring).
   */
  private ringOf(m: Movement, centre: Vec2): Movement['ring'] {
    const inLane = this.lanes.get(m.inLane)!;
    const outLane = this.lanes.get(m.outLane)!;
    if (inLane.edgeId === outLane.edgeId) return undefined;
    const ringR = m.zone * ROUNDABOUT_RING_FRACTION;
    const enter = this.sample(inLane, Math.max(0, inLane.length - ringR)).pos;
    const leave = this.sample(outLane, Math.min(outLane.length, ringR)).pos;
    const a0 = Math.atan2(enter.y - centre.y, enter.x - centre.x);
    const a1 = Math.atan2(leave.y - centre.y, leave.x - centre.x);
    let sweep = (a0 - a1) % (2 * Math.PI);
    if (sweep < 0) sweep += 2 * Math.PI;
    const lead = m.zone - ringR;
    return {
      entry: a0,
      sweep,
      radius: (dist(enter, centre) + dist(leave, centre)) / 2,
      pathIn: lead,
      pathOut: Math.max(lead, m.span - lead),
    };
  }

  /** Radius of a node's box: a roundabout's own, else the plain junction radius. */
  zoneOf(node: number): number {
    return this.roundaboutZones.get(node) ?? JUNCTION_RADIUS;
  }

  /**
   * How far along an exit lane a vehicle must be for its rear to have cleared the box. A plain
   * junction's box ends `zone` out; a roundabout's paths only need the ring itself, so cars give
   * it back as soon as they have left the ring, instead of holding the whole box while they drive
   * away down the exit road.
   */
  releaseAt(node: number, carLength: number): number {
    return (this.ringRadiusOf(node) ?? this.zoneOf(node)) + carLength;
  }

  /** Radius of a roundabout's ring, or null for any other node. */
  ringRadiusOf(node: number): number | null {
    const zone = this.roundaboutZones.get(node);
    return zone === undefined ? null : zone * ROUNDABOUT_RING_FRACTION;
  }

  /**
   * A roundabout's box is as big as `ROUNDABOUT_ZONE`, but never more than 45% of its shortest
   * road, so that the boxes of two roundabouts joined by a short road do not overlap; below the
   * plain junction radius it just behaves like a small one.
   */
  private buildRoundaboutZones(): void {
    for (const [node, control] of this.controls) {
      if (control !== 'roundabout') continue;
      let shortest = Infinity;
      for (const lane of this.lanes.values()) {
        if (lane.to === node || lane.from === node) shortest = Math.min(shortest, lane.length);
      }
      this.roundaboutZones.set(node, Math.max(JUNCTION_RADIUS, Math.min(ROUNDABOUT_ZONE, shortest * 0.45)));
    }
  }

  /**
   * Through a roundabout: along the entry lane to the ring, anticlockwise round it to the exit,
   * then out along the exit lane, with the corners smoothed off. Right-hand traffic circulates
   * anticlockwise. Screen y points down, so anticlockwise is decreasing angle. Two movements
   * conflict when their arcs come close, which is the test `buildMovements` already applies, so a
   * roundabout needs no conflict rules of its own.
   */
  private ringPath(inLane: Lane, outLane: Lane, zone: number, centre: Vec2): Vec2[] {
    const ring = zone * ROUNDABOUT_RING_FRACTION;
    const start = this.sample(inLane, Math.max(0, inLane.length - zone)).pos;
    const enter = this.sample(inLane, Math.max(0, inLane.length - ring)).pos;
    const leave = this.sample(outLane, Math.min(outLane.length, ring)).pos;
    const end = this.sample(outLane, Math.min(outLane.length, zone)).pos;

    const a0 = Math.atan2(enter.y - centre.y, enter.x - centre.x);
    const a1 = Math.atan2(leave.y - centre.y, leave.x - centre.x);
    const r0 = dist(enter, centre);
    const r1 = dist(leave, centre);
    let sweep = (a0 - a1) % (2 * Math.PI);
    if (sweep < 0) sweep += 2 * Math.PI;
    if (sweep < 1e-3) return [start, end];

    const steps = Math.max(2, Math.ceil(sweep / (Math.PI / 12)));
    const pts: Vec2[] = [start, enter];
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const a = a0 - sweep * t;
      const r = r0 + (r1 - r0) * t;
      pts.push({ x: centre.x + Math.cos(a) * r, y: centre.y + Math.sin(a) * r });
    }
    pts.push(leave, end);
    return smooth(pts, 2);
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
