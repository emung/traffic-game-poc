import { type RoadGraph } from './graph';
import { type Lane, LaneNetwork, type Pose } from './lanes';
import { Router } from './routing';
import * as C from './config';

export interface Vehicle {
  id: number;
  /** Lane ids, in travel order. */
  route: number[];
  leg: number;
  /** Arc length of the front bumper along the current lane. */
  s: number;
  v: number;
  desiredSpeed: number;
  /** Node whose junction box this vehicle has reserved, if any. */
  holding: number | null;
  spawnedAt: number;
}

export interface TrafficStats {
  vehicles: number;
  avgSpeedKmh: number;
  arrivals: number;
  avgTripSeconds: number;
  stuck: number;
}

/** Distance past a junction at which a vehicle has cleared the box and gives it back. */
const RELEASE_AT = C.JUNCTION_RADIUS + C.CAR_LENGTH;

/** Intelligent Driver Model acceleration. */
function idmAccel(v: Vehicle, gap: number, leaderSpeed: number): number {
  const free = 1 - (v.v / v.desiredSpeed) ** 4;
  let a = C.MAX_ACCEL * free;
  if (Number.isFinite(gap)) {
    const dv = v.v - leaderSpeed;
    const desiredGap =
      C.MIN_GAP +
      Math.max(0, v.v * C.TIME_HEADWAY + (v.v * dv) / (2 * Math.sqrt(C.MAX_ACCEL * C.COMFORT_BRAKE)));
    a = C.MAX_ACCEL * (free - (desiredGap / Math.max(gap, 0.25)) ** 2);
  }
  return Math.max(-C.MAX_BRAKE, Math.min(C.MAX_ACCEL, a));
}

export class TrafficSim {
  readonly network = new LaneNetwork();
  private readonly router = new Router();
  vehicles: Vehicle[] = [];
  /** Lane id -> vehicles on it, sorted by increasing s. */
  private byLane = new Map<number, Vehicle[]>();
  /** Node id -> id of the vehicle currently holding the junction. */
  readonly junctions = new Map<number, number>();
  private nextId = 1;
  private spawnTimer = 0;
  running = false;
  time = 0;
  private arrivals = 0;
  private tripTimeTotal = 0;

  /** Rebuilds the lane network when the road graph has changed, resetting traffic. */
  sync(graph: RoadGraph): void {
    if (this.network.builtVersion === graph.version) return;
    this.network.build(graph);
    this.router.sync(graph);
    this.junctions.clear();
    this.byLane.clear();
    // Drawing a road only rebuilds the edges it touched, so traffic elsewhere carries on.
    // Anything whose remaining route lost a lane is dropped rather than teleported.
    this.vehicles = this.vehicles.filter((v) => {
      v.holding = null;
      for (let i = v.leg; i < v.route.length; i++) {
        if (!this.network.lanes.has(v.route[i])) return false;
      }
      return true;
    });
  }

  reset(): void {
    this.vehicles = [];
    this.byLane.clear();
    this.junctions.clear();
    this.arrivals = 0;
    this.tripTimeTotal = 0;
    this.time = 0;
  }

  step(graph: RoadGraph, dt: number): void {
    this.sync(graph);
    if (!this.running) return;
    this.time += dt;

    this.indexLanes();
    const accel = this.computeAccelerations();

    for (const v of this.vehicles) {
      v.v = Math.max(0, v.v + (accel.get(v.id) ?? 0) * dt);
      v.s += v.v * dt;
    }

    this.advanceLegs();

    this.spawnTimer += dt;
    while (this.spawnTimer >= C.SPAWN_INTERVAL) {
      this.spawnTimer -= C.SPAWN_INTERVAL;
      this.trySpawn(graph);
    }
  }

  private indexLanes(): void {
    this.byLane.clear();
    for (const v of this.vehicles) {
      const laneId = v.route[v.leg];
      const list = this.byLane.get(laneId);
      if (list) list.push(v);
      else this.byLane.set(laneId, [v]);
    }
    for (const list of this.byLane.values()) list.sort((a, b) => a.s - b.s);
  }

  private computeAccelerations(): Map<number, number> {
    const accel = new Map<number, number>();
    for (const [laneId, list] of this.byLane) {
      const lane = this.network.lanes.get(laneId);
      if (!lane) continue;

      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        const leader = list[i + 1];
        let gap = Infinity;
        let leaderSpeed = v.v;

        if (leader) {
          gap = leader.s - C.CAR_LENGTH - v.s;
          leaderSpeed = leader.v;
        } else {
          const next = this.laneAhead(v);
          const ahead = next ? this.byLane.get(next.id)?.[0] : undefined;
          if (next && ahead) {
            gap = lane.length - v.s + ahead.s - C.CAR_LENGTH;
            leaderSpeed = ahead.v;
          }
        }

        const stopGap = this.junctionGap(v, lane);
        if (stopGap !== null && stopGap < gap) {
          gap = stopGap;
          leaderSpeed = 0;
        }
        accel.set(v.id, idmAccel(v, gap, leaderSpeed));
      }
    }
    return accel;
  }

  /**
   * Distance at which the vehicle must stop for the junction ahead, or null when it may
   * proceed. Claiming and giving up the claim both happen here.
   */
  private junctionGap(v: Vehicle, lane: Lane): number | null {
    const next = this.laneAhead(v);
    if (!next) return null;

    const node = lane.to;
    const remaining = lane.length - v.s;
    const stopGap = Math.max(0, remaining - C.JUNCTION_RADIUS);
    const insideBox = remaining < C.JUNCTION_RADIUS;

    if (v.holding === node) {
      // Once the nose is in the box the vehicle is committed. Before that, it gives the
      // junction back if the far side filled up during the approach -- holding a box it
      // cannot clear is what gridlocks the network.
      if (!insideBox && !this.exitHasRoom(next)) {
        this.release(v);
        return stopGap;
      }
      return null;
    }

    // Claim as late as possible so the box is not held for a whole street, but never later
    // than the point where the vehicle could still stop at the line. A fast vehicle therefore
    // claims early and keeps its speed, while a queued one claims late and the junction cycles
    // quickly. Braking itself is planned from any distance, so a vehicle that cannot claim has
    // always slowed down by the time it arrives.
    const claimDist = Math.max(
      C.JUNCTION_CLAIM_DIST,
      C.JUNCTION_RADIUS + (v.v * v.v) / (2 * C.CLAIM_BRAKE),
    );
    if (remaining <= claimDist && !this.junctions.has(node) && this.exitHasRoom(next)) {
      this.junctions.set(node, v.id);
      v.holding = node;
      return null;
    }
    return stopGap;
  }

  /**
   * True when a vehicle entering `next` is guaranteed to reach the point where it releases the
   * junction. A vehicle can only advance to `blocker.s - CAR_LENGTH - MIN_GAP`, so the exit must
   * hold a full car beyond the release threshold -- otherwise the vehicle parks in the box and
   * the junction is never handed back.
   */
  private exitHasRoom(next: Lane): boolean {
    const blocker = this.byLane.get(next.id)?.[0];
    if (!blocker) return true;
    return blocker.s > RELEASE_AT + C.CAR_LENGTH + C.MIN_GAP + 1;
  }

  private laneAhead(v: Vehicle): Lane | undefined {
    if (v.leg + 1 >= v.route.length) return undefined;
    return this.network.lanes.get(v.route[v.leg + 1]);
  }

  private release(v: Vehicle): void {
    if (v.holding === null) return;
    if (this.junctions.get(v.holding) === v.id) this.junctions.delete(v.holding);
    v.holding = null;
  }

  private advanceLegs(): void {
    const survivors: Vehicle[] = [];
    for (const v of this.vehicles) {
      let lane = this.network.lanes.get(v.route[v.leg]);
      if (!lane) continue;

      while (v.s > lane.length && v.leg < v.route.length - 1) {
        // Hard invariant: never cross a junction without holding it, whatever the car
        // following model did. Without this a fast approach can overshoot the stop line.
        if (v.holding !== lane.to) {
          v.s = lane.length;
          v.v = 0;
          break;
        }
        v.s -= lane.length;
        v.leg++;
        lane = this.network.lanes.get(v.route[v.leg])!;
      }

      if (v.leg === v.route.length - 1 && v.s >= lane.length) {
        this.release(v);
        this.arrivals++;
        this.tripTimeTotal += this.time - v.spawnedAt;
        continue;
      }

      if (v.holding !== null && lane.from === v.holding && v.s > RELEASE_AT) {
        this.release(v);
      }
      survivors.push(v);
    }
    this.vehicles = survivors;
  }

  private trySpawn(graph: RoadGraph): void {
    const ends = this.network.deadEnds;
    if (ends.length < 2 || this.vehicles.length >= this.demandCap()) return;

    const from = ends[(Math.random() * ends.length) | 0];
    const to = ends[(Math.random() * ends.length) | 0];
    if (from === to) return;

    const edgePath = this.router.path(graph, from, to);
    if (!edgePath || edgePath.length === 0) return;

    const route: number[] = [];
    let node = from;
    for (const edgeId of edgePath) {
      const lane = this.network.laneFor(edgeId, node, graph);
      if (!lane) return;
      route.push(lane.id);
      const edge = graph.edges.get(edgeId)!;
      node = edge.a === node ? edge.b : edge.a;
    }

    const blocker = this.byLane.get(route[0])?.[0];
    if (blocker && blocker.s < C.CAR_LENGTH + C.MIN_GAP * 3) return;

    this.vehicles.push({
      id: this.nextId++,
      route,
      leg: 0,
      s: 0,
      v: C.DESIRED_SPEED * 0.5,
      desiredSpeed: C.DESIRED_SPEED * (1 + (Math.random() - 0.5) * 2 * C.SPEED_VARIATION),
      holding: null,
      spawnedAt: this.time,
    });
  }

  /**
   * How many vehicles the network is allowed to hold. Demand is scaled to road capacity so a
   * small network is busy rather than instantly gridlocked.
   */
  private demandCap(): number {
    const perVehicle = C.CAR_LENGTH + C.MIN_GAP + 3;
    const capacity = this.network.totalLength / perVehicle;
    return Math.max(4, Math.min(C.MAX_VEHICLES, Math.round(capacity * C.TARGET_OCCUPANCY)));
  }

  poseOf(v: Vehicle): Pose | null {
    const lane = this.network.lanes.get(v.route[v.leg]);
    return lane ? this.network.sample(lane, v.s) : null;
  }

  stats(): TrafficStats {
    let speedSum = 0;
    let stuck = 0;
    for (const v of this.vehicles) {
      speedSum += v.v;
      if (v.v < 0.5) stuck++;
    }
    const n = this.vehicles.length;
    return {
      vehicles: n,
      avgSpeedKmh: n ? (speedSum / n) * 3.6 : 0,
      arrivals: this.arrivals,
      avgTripSeconds: this.arrivals ? this.tripTimeTotal / this.arrivals : 0,
      stuck,
    };
  }
}
