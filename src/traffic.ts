import { samplePolyline } from './geom';
import { type RoadGraph } from './graph';
import { type Lane, LaneNetwork, type Movement, type Pose } from './lanes';
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
  /** Seconds this trip would take with the road to itself; the yardstick for delay. */
  freeFlowTime: number;
  routeLength: number;
  /** Distance from the start of the route to the start of each leg. */
  legStart: number[];
  /** The junction movement this vehicle has reserved, if any. */
  holding: { node: number; key: number } | null;
  /** When the trip was requested, not when the vehicle got in: queueing outside counts. */
  tripStart: number;
}

/** A trip that has been requested but cannot get into the network yet. */
interface WaitingTrip {
  to: number;
  requestedAt: number;
  desiredSpeed: number;
  /** Route length at request time; only used to weigh how late the trip is running. */
  routeLength: number;
}

interface PlannedRoute {
  lanes: number[];
  legStart: number[];
  length: number;
}

export interface TrafficStats {
  vehicles: number;
  avgSpeedKmh: number;
  arrivals: number;
  /** Arrivals per minute over the recent window, not since the start. */
  flowPerMin: number;
  /** Mean trip time of recent arrivals, so it recovers when the network improves. */
  avgTripSeconds: number;
  /**
   * How many times longer journeys take than a free run, counting vehicles still travelling as
   * well as those that arrived. Arrivals alone are survivorship-biased: in a real jam nothing
   * arrives at all, so an arrivals-only measure reports that everything is fine.
   */
  delayRatio: number;
  stuck: number;
  /** Trips queued at entrances because there is no room to get in. */
  waiting: number;
  wave: number;
  failed: boolean;
}

export interface HistorySample {
  flow: number;
  delay: number;
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
  /** Node id -> movement key -> how many vehicles are currently performing it. */
  readonly active = new Map<number, Map<number, number>>();
  /** Lane id -> how freely traffic is moving on it, 1 free and 0 stopped. */
  readonly laneHeat = new Map<number, number>();
  readonly history: HistorySample[] = [];
  /** Entrance node -> trips queued there, oldest first. */
  private readonly waiting = new Map<number, WaitingTrip[]>();
  private nextId = 1;
  private waveClock = 0;
  private spawnCredit = 0;
  private historyTimer = 0;
  private routeReweighTimer = 0;
  private lowSpeedFor = 0;
  running = false;
  failed = false;
  time = 0;
  private arrivals = 0;
  private recentArrivals: Array<{ at: number; trip: number; ratio: number }> = [];

  /** Rebuilds the lane network when the road graph has changed, keeping traffic that still has a road. */
  sync(graph: RoadGraph): void {
    if (this.network.builtVersion === graph.version) return;
    this.network.build(graph);
    this.router.sync(graph);
    this.active.clear();
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

    // Queued trips have not set off, so they are simply re-planned on the new roads when they
    // get in. Only those whose entrance or destination is no longer a dead end are dropped.
    const ends = new Set(this.network.deadEnds);
    for (const [from, queue] of this.waiting) {
      const kept = ends.has(from) ? queue.filter((t) => ends.has(t.to)) : [];
      if (kept.length) this.waiting.set(from, kept);
      else this.waiting.delete(from);
    }
  }

  reset(): void {
    this.vehicles = [];
    this.byLane.clear();
    this.active.clear();
    this.laneHeat.clear();
    this.history.length = 0;
    this.recentArrivals = [];
    this.arrivals = 0;
    this.time = 0;
    this.spawnCredit = 0;
    this.historyTimer = 0;
    this.routeReweighTimer = 0;
    this.lowSpeedFor = 0;
    this.failed = false;
    this.waiting.clear();
    this.waveClock = 0;
  }

  /**
   * Demand steps up every wave, so a network that copes now will not cope for long. The wave
   * clock only runs while there is traffic to serve, so an empty or unconnected map cannot bank
   * waves by being left open.
   */
  get wave(): number {
    return Math.floor(this.waveClock / C.WAVE_SECONDS) + 1;
  }

  /** Simulated seconds until demand next steps up. */
  get waveRemaining(): number {
    return C.WAVE_SECONDS - (this.waveClock % C.WAVE_SECONDS);
  }

  get waitingCount(): number {
    let n = 0;
    for (const queue of this.waiting.values()) n += queue.length;
    return n;
  }

  waitingAt(node: number): number {
    return this.waiting.get(node)?.length ?? 0;
  }

  private spawnRate(): number {
    return C.BASE_SPAWN_RATE * (1 + (this.wave - 1) * C.WAVE_GROWTH);
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
    this.updateHeat(dt);
    this.updateRouteWeights(dt);

    this.spawnCredit += dt * this.spawnRate();
    while (this.spawnCredit >= 1) {
      this.spawnCredit -= 1;
      this.requestTrip(graph);
    }
    this.admitWaiting(graph);

    if (this.vehicles.length || this.waitingCount) this.waveClock += dt;
    this.sampleHistory(dt);
    this.checkGridlock(dt);
  }

  /** Smooths each lane's speed ratio so the congestion overlay does not flicker. */
  private updateHeat(dt: number): void {
    const alpha = 1 - Math.exp(-dt / C.HEAT_TIME_CONSTANT);
    for (const lane of this.network.lanes.values()) {
      const list = this.byLane.get(lane.id);
      let target = 1;
      if (list && list.length) {
        let sum = 0;
        for (const v of list) sum += Math.min(1, v.v / v.desiredSpeed);
        // Weighted by how full the lane is: one car pulling away from a dead end is not a jam,
        // so slow traffic only reads as congestion once there is enough of it to be queueing.
        const occupancy = (list.length * (C.CAR_LENGTH + C.MIN_GAP)) / lane.length;
        const density = Math.min(1, occupancy / C.HEAT_DENSITY_FULL);
        target = 1 - (1 - sum / list.length) * density;
      }
      const current = this.laneHeat.get(lane.id) ?? 1;
      this.laneHeat.set(lane.id, current + (target - current) * alpha);
    }
  }

  /**
   * Reweighs the router from the freshly updated lane heat, on a slower cadence than heat itself
   * so route choice does not chase every instantaneous fluctuation.
   */
  private updateRouteWeights(dt: number): void {
    this.routeReweighTimer += dt;
    if (this.routeReweighTimer < C.ROUTE_REWEIGH_SECONDS) return;
    this.routeReweighTimer = 0;
    this.router.updateTravelTimes(this.laneHeat);
  }

  private sampleHistory(dt: number): void {
    this.historyTimer += dt;
    if (this.historyTimer < C.HISTORY_SAMPLE_SECONDS) return;
    this.historyTimer = 0;
    const s = this.stats();
    this.history.push({ flow: s.flowPerMin, delay: s.delayRatio });
    if (this.history.length > C.HISTORY_LENGTH) this.history.shift();
  }

  /** A network this far behind for this long has failed; waiting longer will not clear it. */
  private checkGridlock(dt: number): void {
    const delay = this.stats().delayRatio;
    const measurable = this.vehicles.length + this.waitingCount >= 8;
    this.lowSpeedFor = measurable && delay > C.FAIL_DELAY_RATIO ? this.lowSpeedFor + dt : 0;
    if (this.lowSpeedFor >= C.FAIL_SECONDS) {
      this.failed = true;
      this.running = false;
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
   * proceed. Reserving and giving up the reservation both happen here.
   */
  private junctionGap(v: Vehicle, lane: Lane): number | null {
    const next = this.laneAhead(v);
    if (!next) return null;

    const node = lane.to;
    const remaining = lane.length - v.s;
    const stopGap = Math.max(0, remaining - C.JUNCTION_RADIUS);
    const insideBox = remaining < C.JUNCTION_RADIUS;

    if (v.holding && v.holding.node === node) {
      // Once the nose is in the box the vehicle is committed. Before that, it gives the
      // movement back if the far side filled up during the approach -- holding a path it
      // cannot clear is what gridlocks the network.
      if (!insideBox && !this.exitHasRoom(next)) {
        this.release(v);
        return stopGap;
      }
      return null;
    }

    const movement = this.network.movementFor(lane.id, next.id);
    if (!movement) return null;

    // Claim as late as possible so the path is not held for a whole street, but never later
    // than the point where the vehicle could still stop at the line. A fast vehicle therefore
    // claims early and keeps its speed, while a queued one claims late and the junction cycles
    // quickly. Braking itself is planned from any distance, so a vehicle that cannot claim has
    // always slowed down by the time it arrives.
    const claimDist = Math.max(
      C.JUNCTION_CLAIM_DIST,
      C.JUNCTION_RADIUS + (v.v * v.v) / (2 * C.CLAIM_BRAKE),
    );
    if (remaining <= claimDist && this.movementIsClear(movement) && this.exitHasRoom(next)) {
      this.claim(v, movement);
      return null;
    }
    return stopGap;
  }

  /**
   * True when nothing crossing this movement's path is in the junction. Vehicles making the
   * same movement, or any non-conflicting one, go at the same time: two opposite
   * straight-throughs never meet, so making them queue for each other throttles the junction
   * for no reason.
   */
  private movementIsClear(movement: Movement): boolean {
    const atNode = this.active.get(movement.node);
    if (!atNode) return true;
    for (const [key, count] of atNode) {
      if (count > 0 && movement.conflicts.has(key)) return false;
    }
    return true;
  }

  private claim(v: Vehicle, movement: Movement): void {
    let atNode = this.active.get(movement.node);
    if (!atNode) {
      atNode = new Map();
      this.active.set(movement.node, atNode);
    }
    atNode.set(movement.key, (atNode.get(movement.key) ?? 0) + 1);
    v.holding = { node: movement.node, key: movement.key };
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
    if (!v.holding) return;
    const atNode = this.active.get(v.holding.node);
    if (atNode) {
      const left = (atNode.get(v.holding.key) ?? 0) - 1;
      if (left > 0) atNode.set(v.holding.key, left);
      else atNode.delete(v.holding.key);
      if (atNode.size === 0) this.active.delete(v.holding.node);
    }
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
        if (!v.holding || v.holding.node !== lane.to) {
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
        const trip = this.time - v.tripStart;
        this.recentArrivals.push({ at: this.time, trip, ratio: trip / v.freeFlowTime });
        continue;
      }

      if (v.holding && lane.from === v.holding.node && v.s > RELEASE_AT) {
        this.release(v);
      }
      survivors.push(v);
    }
    this.vehicles = survivors;
  }

  /** Queues one trip at an entrance. Demand arrives whether or not the roads can take it. */
  private requestTrip(graph: RoadGraph): void {
    const ends = this.network.deadEnds;
    if (ends.length < 2 || this.waitingCount >= C.MAX_WAITING) return;

    const i = (Math.random() * ends.length) | 0;
    const from = ends[i];
    const to = ends[(i + 1 + ((Math.random() * (ends.length - 1)) | 0)) % ends.length];
    const route = this.planRoute(graph, from, to);
    if (!route) return;

    const trip: WaitingTrip = {
      to,
      requestedAt: this.time,
      desiredSpeed: C.DESIRED_SPEED * (1 + (Math.random() - 0.5) * 2 * C.SPEED_VARIATION),
      routeLength: route.length,
    };
    const queue = this.waiting.get(from);
    if (queue) queue.push(trip);
    else this.waiting.set(from, [trip]);
  }

  /**
   * Lets the oldest trip at each entrance in once there is room behind it. Without the queue,
   * demand the roads cannot take in simply vanished: a single road with no junctions then never
   * fell behind however high demand climbed, and building fewer junctions was the best strategy.
   */
  private admitWaiting(graph: RoadGraph): void {
    for (const [from, queue] of this.waiting) {
      if (!queue.length || this.vehicles.length >= C.MAX_VEHICLES) continue;

      // An entrance is a dead end, so it has exactly one lane in; check it before planning.
      const entrance = this.network.outgoing.get(from)?.[0];
      if (entrance === undefined) continue;
      const blocker = this.byLane.get(entrance)?.[0];
      if (blocker && blocker.s < C.CAR_LENGTH + C.MIN_GAP * 3) continue;

      const trip = queue.shift()!;
      const route = this.planRoute(graph, from, trip.to);
      if (!route) continue;

      // Enter no faster than the car ahead and slowly enough to stop behind it. Entering at road
      // speed rear-ended queued cars: with a queue, every admission happens at the minimum gap,
      // leaving only a few metres to brake in.
      let v = trip.desiredSpeed * 0.9;
      if (blocker) {
        const room = Math.max(0, blocker.s - C.CAR_LENGTH - C.MIN_GAP);
        v = Math.min(v, blocker.v, Math.sqrt(2 * C.COMFORT_BRAKE * room));
      }

      this.vehicles.push({
        id: this.nextId++,
        route: route.lanes,
        leg: 0,
        s: 0,
        v,
        desiredSpeed: trip.desiredSpeed,
        freeFlowTime: route.length / trip.desiredSpeed,
        routeLength: route.length,
        legStart: route.legStart,
        holding: null,
        tripStart: trip.requestedAt,
      });
    }
  }

  private planRoute(graph: RoadGraph, from: number, to: number): PlannedRoute | null {
    const edgePath = this.router.path(graph, from, to);
    if (!edgePath || edgePath.length === 0) return null;

    const lanes: number[] = [];
    const legStart: number[] = [];
    let length = 0;
    let node = from;
    for (const edgeId of edgePath) {
      const lane = this.network.laneFor(edgeId, node, graph);
      if (!lane) return null;
      lanes.push(lane.id);
      legStart.push(length);
      length += lane.length;
      const edge = graph.edges.get(edgeId)!;
      node = edge.a === node ? edge.b : edge.a;
    }
    return { lanes, legStart, length: Math.max(1, length) };
  }

  /**
   * Where the vehicle actually is. Inside a junction it follows the movement curve rather than
   * the lane, which both removes the jump between lane ends and keeps vehicles on the same
   * paths that conflict detection was computed from.
   */
  poseOf(v: Vehicle): Pose | null {
    const lane = this.network.lanes.get(v.route[v.leg]);
    if (!lane) return null;
    const r = C.JUNCTION_RADIUS;

    const next = this.laneAhead(v);
    const remaining = lane.length - v.s;
    if (next && remaining < r) {
      const movement = this.network.movementFor(lane.id, next.id);
      if (movement) return samplePolyline(movement.path, (r - remaining) / (2 * r));
    }

    if (v.leg > 0 && v.s < r) {
      const prev = this.network.lanes.get(v.route[v.leg - 1]);
      const movement = prev && this.network.movementFor(prev.id, lane.id);
      if (movement) return samplePolyline(movement.path, 0.5 + v.s / (2 * r));
    }

    return this.network.sample(lane, v.s);
  }

  stats(): TrafficStats {
    let speedSum = 0;
    let stuck = 0;
    let ratioSum = 0;
    let ratioCount = 0;
    for (const v of this.vehicles) {
      speedSum += v.v;
      if (v.v < 0.5) stuck++;
      // Project the whole journey from progress so far: time already spent, plus a free run
      // for whatever is left. A vehicle moving freely projects 1 however new it is, and one
      // that is crawling projects high straight away instead of only once it overruns.
      const travelled = v.legStart[v.leg] + v.s;
      const elapsed = this.time - v.tripStart;
      ratioSum += Math.max(1, (elapsed * v.desiredSpeed + (v.routeLength - travelled)) / v.routeLength);
      ratioCount++;
    }

    // Trips still queued outside have the whole route ahead of them on top of their wait.
    let waiting = 0;
    for (const queue of this.waiting.values()) {
      for (const trip of queue) {
        const waited = this.time - trip.requestedAt;
        ratioSum += (waited * trip.desiredSpeed + trip.routeLength) / trip.routeLength;
        ratioCount++;
        waiting++;
      }
    }

    const cutoff = this.time - C.STATS_WINDOW;
    while (this.recentArrivals.length && this.recentArrivals[0].at < cutoff) {
      this.recentArrivals.shift();
    }
    let tripSum = 0;
    for (const a of this.recentArrivals) {
      tripSum += a.trip;
      ratioSum += a.ratio;
      ratioCount++;
    }
    const span = Math.min(this.time, C.STATS_WINDOW);

    const n = this.vehicles.length;
    return {
      vehicles: n,
      avgSpeedKmh: n ? (speedSum / n) * 3.6 : 0,
      arrivals: this.arrivals,
      flowPerMin: span > 0 ? (this.recentArrivals.length / span) * 60 : 0,
      avgTripSeconds: this.recentArrivals.length ? tripSum / this.recentArrivals.length : 0,
      delayRatio: ratioCount ? ratioSum / ratioCount : 1,
      stuck,
      waiting,
      wave: this.wave,
      failed: this.failed,
    };
  }
}
