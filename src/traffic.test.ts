import { describe, expect, it } from 'vitest';
import { type JunctionControl, RoadGraph } from './graph';
import { type Lane, type Pose } from './lanes';
import { Router } from './routing';
import { arcLengthAt, closestOnPolyline } from './geom';
import { TrafficSim, type Vehicle } from './traffic';
import * as C from './config';
import { FLYOVER_CROSSINGS, buildGrid } from './testutil';

/** Every control type is held to the same invariants as a plain junction. `null` is plain. */
const CONTROLS: Array<JunctionControl | null> = [null, 'signal', 'priority', 'roundabout'];

/** Each control on the plain grid, and again with a bridge carrying traffic over it. */
const CASES = CONTROLS.flatMap((control) => [
  { control, flyover: false },
  { control, flyover: true },
]);

/** Where a vehicle is and what it holds, for a failure message: enough to reconstruct the cause. */
function vehicleSummary(p: { veh: Vehicle; pose: Pose; level: string }): string {
  const v = p.veh;
  const route = v.route.slice(Math.max(0, v.leg - 1), v.leg + 2).join('>');
  return (
    `#${v.id} lane ${v.route[v.leg]} (route ${route}) s=${v.s.toFixed(2)} v=${v.v.toFixed(2)} ` +
    `at (${p.pose.pos.x.toFixed(1)}, ${p.pose.pos.y.toFixed(1)}) ${p.level} holding ${JSON.stringify(v.holding)}`
  );
}

/** Positions of every vehicle, with its level, for pairwise distance checks. */
function posesOf(sim: TrafficSim): Array<{ veh: Vehicle; pose: Pose; level: 'ground' | 'bridge' }> {
  const poses = [];
  for (const v of sim.vehicles) {
    const pose = sim.poseOf(v);
    if (pose) poses.push({ veh: v, pose, level: sim.levelOf(v) });
  }
  return poses;
}

describe('TrafficSim', () => {
  it('does not rebuild the lane network when the graph has not changed', () => {
    const graph = buildGrid();
    const sim = new TrafficSim();
    sim.running = true;

    sim.step(graph, C.SIM_STEP);
    const networkRef = sim.network;
    const builtVersion = sim.network.builtVersion;

    sim.step(graph, C.SIM_STEP);
    expect(sim.network).toBe(networkRef);
    expect(sim.network.builtVersion).toBe(builtVersion);
    expect(sim.network.builtVersion).toBe(graph.version);
  });

  describe.each(CASES)('junction invariants over a sustained run (control: $control, flyover: $flyover)', ({ control, flyover }) => {
    const SIM_SECONDS = 60;
    const STEPS = Math.round(SIM_SECONDS / C.SIM_STEP);

    it('never overlaps two vehicles on the same lane', () => {
      const graph = buildGrid(control, { flyover });
      const sim = new TrafficSim();
      sim.running = true;
      let sawTraffic = false;

      for (let i = 0; i < STEPS; i++) {
        sim.step(graph, C.SIM_STEP);
        if (sim.vehicles.length > 0) sawTraffic = true;

        const byLane = new Map<number, Vehicle[]>();
        for (const v of sim.vehicles) {
          const laneId = v.route[v.leg];
          const list = byLane.get(laneId);
          if (list) list.push(v);
          else byLane.set(laneId, [v]);
        }
        for (const [laneId, list] of byLane) {
          list.sort((a, b) => a.s - b.s);
          for (let k = 0; k < list.length - 1; k++) {
            const follower = list[k];
            const leader = list[k + 1];
            const gap = leader.s - C.CAR_LENGTH - follower.s;
            if (gap < -1e-6) {
              throw new Error(
                `overlap at t=${sim.time.toFixed(3)}s on lane ${laneId}: vehicle ${leader.id} ` +
                  `(s=${leader.s.toFixed(2)}) and vehicle ${follower.id} (s=${follower.s.toFixed(2)}), ` +
                  `gap=${gap.toFixed(3)}`,
              );
            }
          }
        }
      }

      expect(sawTraffic).toBe(true);
    });

    // Two movements are allowed to run at the same time whenever their paths are at least
    // MOVEMENT_CLEARANCE apart (see lanes.ts's buildMovements), and MOVEMENT_CLEARANCE is
    // deliberately set below 2*LANE_OFFSET so that opposite straight-throughs -- whose lanes
    // are exactly 2*LANE_OFFSET apart -- still count as compatible (config.ts's comment on
    // MOVEMENT_CLEARANCE says so directly). So turning movements can legitimately pass as
    // close as MOVEMENT_CLEARANCE; 2*LANE_OFFSET is only the floor for same-road opposite
    // lanes, not a general property of the whole network. Measured empirically on this grid
    // (30 trials x 60s): straight-through pairs bottom out at exactly 4.0m, turning pairs as
    // low as ~3.54m, never below MOVEMENT_CLEARANCE.
    it('keeps every pair of vehicles at least MOVEMENT_CLEARANCE apart', () => {
      const graph = buildGrid(control, { flyover });
      const sim = new TrafficSim();
      sim.running = true;
      let sawTraffic = false;
      const minGap = C.MOVEMENT_CLEARANCE;

      for (let i = 0; i < STEPS; i++) {
        sim.step(graph, C.SIM_STEP);
        if (sim.vehicles.length > 0) sawTraffic = true;

        const poses = posesOf(sim);
        for (let a = 0; a < poses.length; a++) {
          for (let b = a + 1; b < poses.length; b++) {
            // One passing over the other on a bridge is not a near miss.
            if (poses[a].level !== poses[b].level) continue;
            const d = Math.hypot(
              poses[a].pose.pos.x - poses[b].pose.pos.x,
              poses[a].pose.pos.y - poses[b].pose.pos.y,
            );
            if (d < minGap - 1e-2) {
              throw new Error(
                `closest-approach violation at t=${sim.time.toFixed(3)}s: vehicle ${poses[a].veh.id} ` +
                  `and ${poses[b].veh.id} are ${d.toFixed(3)}m apart (minimum is ${minGap.toFixed(3)}m); ` +
                  [poses[a], poses[b]].map(vehicleSummary).join('; '),
              );
            }
          }
        }
      }

      expect(sawTraffic).toBe(true);
    });
  });

  it.each(CASES)('keeps arrivals rising over a long run and avoids deadlock (control: $control, flyover: $flyover)', ({ control, flyover }) => {
    const graph = buildGrid(control, { flyover });
    const sim = new TrafficSim();
    sim.running = true;

    const SIM_SECONDS = 120;
    const STEPS = Math.round(SIM_SECONDS / C.SIM_STEP);
    const CHECK_EVERY_STEPS = Math.round(1 / C.SIM_STEP);

    let lastArrivals = 0;
    for (let i = 0; i < STEPS; i++) {
      sim.step(graph, C.SIM_STEP);
      if (i % CHECK_EVERY_STEPS !== 0) continue;
      const arrivals = sim.stats().arrivals;
      if (arrivals < lastArrivals) {
        throw new Error(`arrivals dropped at t=${sim.time.toFixed(1)}s: was ${lastArrivals}, now ${arrivals}`);
      }
      lastArrivals = arrivals;
    }

    expect(sim.stats().arrivals).toBeGreaterThan(0);
    expect(sim.failed).toBe(false);
  });
  describe('bridges', () => {
    it('puts no junction where the flyover crosses the grid', () => {
      const graph = buildGrid(null, { flyover: true });
      const sim = new TrafficSim();
      sim.step(graph, C.SIM_STEP);
      for (const p of FLYOVER_CROSSINGS) {
        for (const node of graph.nodes.values()) {
          expect(Math.hypot(node.pos.x - p.x, node.pos.y - p.y)).toBeGreaterThan(C.MERGE_DIST);
        }
      }
      // Movements only exist at nodes, so none can be at the crossings; the ramps are the only
      // junctions the bridge adds.
      const bridge = [...graph.edges.values()].find((e) => e.bridge)!;
      expect(sim.network.movements.has(bridge.a)).toBe(true);
      expect(sim.network.movements.has(bridge.b)).toBe(true);
    });

    it('is on the ground on its ramps and up top between them', () => {
      const graph = buildGrid(null, { flyover: true });
      const sim = new TrafficSim();
      sim.step(graph, C.SIM_STEP);
      const bridge = [...graph.edges.values()].find((e) => e.bridge)!;
      for (const laneId of [bridge.id * 2, bridge.id * 2 + 1]) {
        const lane = sim.network.lanes.get(laneId)!;
        expect(lane.elevated).toEqual({ lo: C.RAMP_LENGTH, hi: lane.length - C.RAMP_LENGTH });
      }
      for (const edge of graph.edges.values()) {
        if (!edge.bridge) expect(sim.network.lanes.get(edge.id * 2)!.elevated).toBeNull();
      }
    });

    it('is the route traffic takes between the corners it joins', () => {
      const graph = buildGrid(null, { flyover: true });
      const bridge = [...graph.edges.values()].find((e) => e.bridge)!;
      // d1 (node 5) to d4 (node 8): the bridge beats going round the grid.
      const router = new Router();
      router.sync(graph);
      expect(router.path(graph, 5, 8)).toContain(bridge.id);
    });

    // The state the clearance check's level exemption exists for: a car on the bridge right over
    // a car on the road below, where their lanes cross. Without the exemption this is a violation.
    it('puts a car on the bridge and a car below it at one spot, on different levels', () => {
      const graph = buildGrid(null, { flyover: true });
      const sim = new TrafficSim();
      sim.step(graph, C.SIM_STEP);
      const bridge = [...graph.edges.values()].find((e) => e.bridge)!;
      const upper = sim.network.lanes.get(bridge.id * 2)!;
      const lower = sim.network.lanes.get(2 * 2)!; // j1 -> j3, under the first crossing

      let best = { d: Infinity, sUp: 0, sLow: 0 };
      for (let sUp = 0; sUp < upper.length; sUp += 0.25) {
        const hit = closestOnPolyline(sim.network.sample(upper, sUp).pos, lower.points)!;
        if (hit.dist < best.d) {
          best = { d: hit.dist, sUp, sLow: arcLengthAt(lower.points, hit.segIdx, hit.t) };
        }
      }
      const car = (id: number, lane: Lane, s: number): Vehicle => ({
        id,
        route: [lane.id],
        leg: 0,
        s,
        v: 0,
        desiredSpeed: C.DESIRED_SPEED,
        freeFlowTime: 20,
        routeLength: lane.length,
        legStart: [0],
        holding: null,
        tripStart: 0,
      });
      const up = car(9998, upper, best.sUp);
      const down = car(9999, lower, best.sLow);
      const d = Math.hypot(sim.poseOf(up)!.pos.x - sim.poseOf(down)!.pos.x, sim.poseOf(up)!.pos.y - sim.poseOf(down)!.pos.y);

      expect(d).toBeLessThan(0.5);
      expect(sim.levelOf(up)).toBe('bridge');
      expect(sim.levelOf(down)).toBe('ground');
    });

    it('counts a car on a ramp, or in the ramp junction, as on the ground', () => {
      const graph = buildGrid(null, { flyover: true });
      const sim = new TrafficSim();
      sim.step(graph, C.SIM_STEP);
      const bridge = [...graph.edges.values()].find((e) => e.bridge)!;
      const lane = sim.network.lanes.get(bridge.id * 2)!;
      const at = (s: number): Vehicle => ({
        id: 9999,
        route: [lane.id],
        leg: 0,
        s,
        v: 0,
        desiredSpeed: C.DESIRED_SPEED,
        freeFlowTime: 20,
        routeLength: lane.length,
        legStart: [0],
        holding: null,
        tripStart: 0,
      });
      expect(sim.levelOf(at(1))).toBe('ground');
      expect(sim.levelOf(at(C.RAMP_LENGTH - 0.1))).toBe('ground');
      expect(sim.levelOf(at(C.RAMP_LENGTH + 0.1))).toBe('bridge');
      expect(sim.levelOf(at(lane.length - C.RAMP_LENGTH - 0.1))).toBe('bridge');
      expect(sim.levelOf(at(lane.length - 1))).toBe('ground');
    });
  });

  describe('signals', () => {
    it('groups opposite approaches into two phases at a four-way, one of them green at a time', () => {
      const graph = buildGrid('signal');
      const sim = new TrafficSim();
      sim.step(graph, C.SIM_STEP);
      const node = 1;
      const phases = sim.network.phases.get(node)!;
      expect(phases.map((p) => p.length)).toEqual([2, 2]);

      // Each pair really is opposite: arrival directions point against each other.
      for (const [a, b] of phases) {
        const la = sim.network.lanes.get(a)!.points;
        const lb = sim.network.lanes.get(b)!.points;
        const da = { x: la.at(-1)!.x - la.at(-2)!.x, y: la.at(-1)!.y - la.at(-2)!.y };
        const db = { x: lb.at(-1)!.x - lb.at(-2)!.x, y: lb.at(-1)!.y - lb.at(-2)!.y };
        expect(da.x * db.x + da.y * db.y).toBeLessThan(0);
      }

      const served = new Set<number>();
      const slot = C.SIGNAL_GREEN_SECONDS + C.SIGNAL_ALL_RED_SECONDS;
      for (sim.time = 0; sim.time < slot * phases.length; sim.time += 0.25) {
        const greenPhases = phases.filter((p) => p.every((a) => sim.signalState(node, a) === 'green'));
        const greenLanes = phases.flat().filter((a) => sim.signalState(node, a) === 'green');
        expect(greenPhases.length).toBeLessThanOrEqual(1);
        // A phase is all green or all red, and only one phase's lanes are ever green.
        expect(greenLanes.length).toBe(greenPhases.length * 2);
        for (const a of greenLanes) served.add(a);
      }
      expect(served.size).toBe(4);
    });

    it('gives the stem of a T its own phase', () => {
      const graph = new RoadGraph();
      const c = graph.addNode({ x: 0, y: 0 });
      const west = graph.addNode({ x: -100, y: 0 });
      const east = graph.addNode({ x: 100, y: 0 });
      const south = graph.addNode({ x: 0, y: 100 });
      for (const n of [west, east, south]) graph.addEdge(c.id, n.id, [{ ...c.pos }, { ...n.pos }]);
      graph.setControl(c.id, 'signal');

      const sim = new TrafficSim();
      sim.step(graph, C.SIM_STEP);
      const phases = sim.network.phases.get(c.id)!;
      expect(phases.map((p) => p.length).sort()).toEqual([1, 2]);
    });

    it('reports no signal at a plain junction or on a lane that is not an approach', () => {
      const graph = buildGrid();
      const sim = new TrafficSim();
      sim.step(graph, C.SIM_STEP);
      expect(sim.signalState(1, 0)).toBeNull();
      expect(sim.network.phases.size).toBe(0);
    });

    it('never lets a vehicle claim a junction on a red light', () => {
      const graph = buildGrid('signal');
      const sim = new TrafficSim();
      sim.running = true;
      const seen = new Set<number>();
      let claims = 0;

      for (let i = 0; i < Math.round(90 / C.SIM_STEP); i++) {
        sim.step(graph, C.SIM_STEP);
        for (const v of sim.vehicles) {
          if (!v.holding || seen.has(v.id)) continue;
          // A vehicle first seen already past its junction claimed on an earlier leg; only new
          // claims at the node it is approaching are checked.
          const movement = sim.network.movements.get(v.holding.node)![v.holding.key];
          if (v.route[v.leg] !== movement.inLane) continue;
          seen.add(v.id);
          claims++;
          expect(sim.signalState(movement.node, movement.inLane)).not.toBe('red');
        }
      }
      expect(claims).toBeGreaterThan(0);
    });
  });
  describe('approaching an open junction', () => {
    /** A four-way with 150 m arms, and one car already at speed on the west arm heading east. */
    function approach(control: JunctionControl | null) {
      const graph = new RoadGraph();
      const c = graph.addNode({ x: 0, y: 0 });
      const arms = [
        graph.addNode({ x: -150, y: 0 }),
        graph.addNode({ x: 150, y: 0 }),
        graph.addNode({ x: 0, y: -150 }),
        graph.addNode({ x: 0, y: 150 }),
      ];
      const edges = arms.map((a) => graph.addEdge(c.id, a.id, [{ ...c.pos }, { ...a.pos }]));
      if (control) graph.setControl(c.id, control);

      const sim = new TrafficSim();
      sim.step(graph, C.SIM_STEP);
      const inLane = sim.network.laneFor(edges[0].id, arms[0].id, graph)!;
      const outLane = sim.network.laneFor(edges[1].id, c.id, graph)!;
      const car: Vehicle = {
        id: 9999,
        route: [inLane.id, outLane.id],
        leg: 0,
        s: inLane.length - 60,
        v: C.DESIRED_SPEED,
        desiredSpeed: C.DESIRED_SPEED,
        freeFlowTime: 20,
        routeLength: inLane.length + outLane.length,
        legStart: [0, inLane.length],
        holding: null,
        tripStart: 0,
      };
      sim.vehicles.push(car);
      sim.running = true;
      return { graph, sim, car, inLane, c };
    }

    function slowestApproach(sim: TrafficSim, graph: RoadGraph, car: Vehicle): number {
      let slowest = car.v;
      while (car.leg === 0 && sim.vehicles.includes(car)) {
        sim.step(graph, C.SIM_STEP);
        slowest = Math.min(slowest, car.v);
        if (sim.time > 20) throw new Error('vehicle never crossed');
      }
      return slowest;
    }

    it('slows an approaching car to the uncontrolled-junction speed, but only when it has to', () => {
      const { graph, sim, car, inLane } = approach(null);
      let earlySlowest = car.v;
      let atBox = NaN;
      while (car.leg === 0 && sim.vehicles.includes(car)) {
        sim.step(graph, C.SIM_STEP);
        const toBox = inLane.length - car.s - C.JUNCTION_RADIUS;
        // Far from the junction it must not have started slowing yet (no crawling up to it).
        if (car.leg === 0 && toBox > 45) earlySlowest = Math.min(earlySlowest, car.v);
        if (car.leg === 0 && Number.isNaN(atBox) && toBox <= 0) atBox = car.v;
        if (sim.time > 20) throw new Error('vehicle never crossed');
      }
      expect(earlySlowest).toBeGreaterThan(C.DESIRED_SPEED * 0.95);
      // Down to the limit at the box edge: neither still fast nor braked to a crawl.
      expect(atBox).toBeGreaterThan(C.UNCONTROLLED_SPEED * 0.85);
      expect(atBox).toBeLessThan(C.UNCONTROLLED_SPEED * 1.15);
    });

    it('does not slow a car for a priority junction', () => {
      const { graph, sim, car } = approach('priority');
      expect(slowestApproach(sim, graph, car)).toBeGreaterThan(C.DESIRED_SPEED * 0.95);
    });

    it('does not slow down for a signal that stays green until it has crossed', () => {
      const { graph, sim, car, inLane, c } = approach('signal');
      // Start the clock so this approach turns green now and stays green for the whole approach.
      let t = 0;
      const stays = (from: number) => {
        for (let dt = 0; dt <= 5; dt += 0.25) {
          sim.time = from + dt;
          if (sim.signalState(c.id, inLane.id) !== 'green') return false;
        }
        return true;
      };
      while (!stays(t)) t += 0.25;
      sim.time = t;
      expect(slowestApproach(sim, graph, car)).toBeGreaterThan(C.DESIRED_SPEED * 0.95);
    });

    it('stops for a red signal it cannot beat', () => {
      const { graph, sim, car, inLane, c } = approach('signal');
      let t = 0;
      const redFor = (from: number) => {
        for (let dt = 0; dt <= 6; dt += 0.25) {
          sim.time = from + dt;
          if (sim.signalState(c.id, inLane.id) !== 'red') return false;
        }
        return true;
      };
      while (!redFor(t)) t += 0.25;
      sim.time = t;
      for (let i = 0; i < Math.round(6 / C.SIM_STEP); i++) sim.step(graph, C.SIM_STEP);
      expect(car.leg).toBe(0);
      expect(car.holding).toBeNull();
    });
  });
  describe('exit room', () => {
    /** A four-way with the exit lane east of the centre, and a way to park cars on that lane. */
    function exitLane() {
      const graph = new RoadGraph();
      const c = graph.addNode({ x: 0, y: 0 });
      const east = graph.addNode({ x: 150, y: 0 });
      const west = graph.addNode({ x: -150, y: 0 });
      const north = graph.addNode({ x: 0, y: -150 });
      const e = graph.addEdge(c.id, east.id, [{ ...c.pos }, { ...east.pos }]);
      for (const n of [west, north]) graph.addEdge(c.id, n.id, [{ ...c.pos }, { ...n.pos }]);
      const sim = new TrafficSim();
      sim.step(graph, C.SIM_STEP);
      const lane = sim.network.laneFor(e.id, c.id, graph)!;
      // The rule is private; it is the piece under test, so reach it directly.
      const internals = sim as unknown as { exitHasRoom(l: typeof lane): boolean; indexLanes(): void };
      let id = 500;
      const park = (s: number, v: number) => {
        sim.vehicles.push({
          id: id++, route: [lane.id], leg: 0, s, v,
          desiredSpeed: C.DESIRED_SPEED, freeFlowTime: 10, routeLength: lane.length,
          legStart: [0], holding: null, tripStart: 0,
        });
      };
      const room = () => {
        internals.indexLanes();
        return internals.exitHasRoom(lane);
      };
      return { park, room };
    }

    it('has room on an empty exit, and when the car ahead is well clear', () => {
      const { park, room } = exitLane();
      expect(room()).toBe(true);
      park(40, 0);
      expect(room()).toBe(true);
    });

    it('has no room behind a car that has only just entered the exit and is standing', () => {
      const { park, room } = exitLane();
      park(3, 0);
      expect(room()).toBe(false);
    });

    it('counts a car that has just entered the exit at full speed as making room', () => {
      const { park, room } = exitLane();
      park(3, C.DESIRED_SPEED);
      expect(room()).toBe(true);
    });

    it('does not trust a flowing car when something slow is queued further along the exit', () => {
      const { park, room } = exitLane();
      park(3, C.DESIRED_SPEED);
      park(30, 0.5);
      expect(room()).toBe(false);
    });
  });
  describe('priority', () => {
    /** A T with 150 m arms; a minor-road car waits at the stem's line to turn right onto the major road. */
    function tSetup() {
      const graph = new RoadGraph();
      const c = graph.addNode({ x: 0, y: 0 });
      const west = graph.addNode({ x: -150, y: 0 });
      const east = graph.addNode({ x: 150, y: 0 });
      const south = graph.addNode({ x: 0, y: 150 });
      const eW = graph.addEdge(c.id, west.id, [{ ...c.pos }, { ...west.pos }]);
      const eE = graph.addEdge(c.id, east.id, [{ ...c.pos }, { ...east.pos }]);
      const eS = graph.addEdge(c.id, south.id, [{ ...c.pos }, { ...south.pos }]);
      graph.setControl(c.id, 'priority');

      const sim = new TrafficSim();
      (sim as unknown as { requestTrip(): void }).requestTrip = () => {};
      sim.step(graph, C.SIM_STEP);
      const majorIn = sim.network.laneFor(eW.id, west.id, graph)!;
      const minorIn = sim.network.laneFor(eS.id, south.id, graph)!;
      const eastOut = sim.network.laneFor(eE.id, c.id, graph)!;

      const car = (id: number, inLane: typeof majorIn, s: number, v: number): Vehicle => ({
        id, route: [inLane.id, eastOut.id], leg: 0, s, v,
        desiredSpeed: C.DESIRED_SPEED, freeFlowTime: 20, routeLength: inLane.length + eastOut.length,
        legStart: [0, inLane.length], holding: null, tripStart: 0,
      });
      const minor = car(1, minorIn, minorIn.length - 7, 0);
      sim.vehicles.push(minor);
      sim.running = true;
      return { graph, sim, majorIn, car, minor };
    }

    it('makes a minor-road car wait for a major-road car that is about to arrive', () => {
      const { graph, sim, majorIn, car, minor } = tSetup();
      const major = car(2, majorIn, majorIn.length - 30, C.DESIRED_SPEED);
      sim.vehicles.push(major);

      // While the major car is close and moving, the minor car must stay put.
      while (major.leg === 0 && sim.time < 10) {
        sim.step(graph, C.SIM_STEP);
        if (major.leg === 0) expect(minor.holding).toBeNull();
      }
      expect(major.leg).toBe(1);

      // Once it has gone, the minor car takes its turn.
      for (let i = 0; i < Math.round(10 / C.SIM_STEP) && minor.leg === 0; i++) sim.step(graph, C.SIM_STEP);
      expect(minor.leg).toBe(1);
    });

    it('gives a major-road car standing at the line its turn before the minor road', () => {
      const { graph, sim, majorIn, car, minor } = tSetup();
      // Stopped, not approaching: the minor car must still not slip in ahead of it.
      const major = car(2, majorIn, majorIn.length - 7, 0);
      sim.vehicles.push(major);

      for (let i = 0; i < Math.round(8 / C.SIM_STEP) && major.leg === 0; i++) {
        sim.step(graph, C.SIM_STEP);
        expect(minor.holding).toBeNull();
      }
      expect(major.leg).toBe(1);
    });

    it('lets a minor-road car go when the major road is empty', () => {
      const { graph, sim, minor } = tSetup();
      for (let i = 0; i < Math.round(8 / C.SIM_STEP) && minor.leg === 0; i++) sim.step(graph, C.SIM_STEP);
      expect(minor.leg).toBe(1);
    });

    it('does not hold a minor-road car for a major-road car that is still far off', () => {
      const { graph, sim, majorIn, car, minor } = tSetup();
      sim.vehicles.push(car(2, majorIn, majorIn.length - 120, C.DESIRED_SPEED));
      for (let i = 0; i < Math.round(4 / C.SIM_STEP) && !minor.holding && minor.leg === 0; i++) {
        sim.step(graph, C.SIM_STEP);
      }
      expect(minor.holding !== null || minor.leg === 1).toBe(true);
    });

    it('keeps minor-road traffic flowing under normal demand', () => {
      const graph = buildGrid('priority');
      const sim = new TrafficSim();
      sim.running = true;
      const seen = new Set<number>();
      let minorClaims = 0;
      for (let i = 0; i < Math.round(120 / C.SIM_STEP); i++) {
        sim.step(graph, C.SIM_STEP);
        for (const v of sim.vehicles) {
          if (!v.holding || seen.has(v.id)) continue;
          const m = sim.network.movements.get(v.holding.node)![v.holding.key];
          if (v.route[v.leg] !== m.inLane) continue;
          seen.add(v.id);
          if (m.yieldsTo.length > 0) minorClaims++;
        }
      }
      expect(minorClaims).toBeGreaterThan(0);
      expect(sim.failed).toBe(false);
    });
  });
  describe('roundabout crossing', () => {
    /** One car from the west arm of a roundabout to the chosen arm; returns how its drawn position behaves. */
    function cross(exitArm: 'south' | 'east' | 'north') {
      const graph = new RoadGraph();
      const c = graph.addNode({ x: 0, y: 0 });
      const west = graph.addNode({ x: -150, y: 0 });
      const arms = {
        east: graph.addNode({ x: 150, y: 0 }),
        north: graph.addNode({ x: 0, y: -150 }),
        south: graph.addNode({ x: 0, y: 150 }),
      };
      const eIn = graph.addEdge(c.id, west.id, [{ ...c.pos }, { ...west.pos }]);
      const eOut = graph.addEdge(c.id, arms[exitArm].id, [{ ...c.pos }, { ...arms[exitArm].pos }]);
      for (const other of Object.values(arms)) {
        if (other !== arms[exitArm]) graph.addEdge(c.id, other.id, [{ ...c.pos }, { ...other.pos }]);
      }
      graph.setControl(c.id, 'roundabout');

      const sim = new TrafficSim();
      (sim as unknown as { requestTrip(): void }).requestTrip = () => {};
      sim.step(graph, C.SIM_STEP);
      const inLane = sim.network.laneFor(eIn.id, west.id, graph)!;
      const outLane = sim.network.laneFor(eOut.id, c.id, graph)!;
      const car: Vehicle = {
        id: 1, route: [inLane.id, outLane.id], leg: 0, s: inLane.length - 60, v: C.ROUNDABOUT_SPEED,
        desiredSpeed: C.DESIRED_SPEED, freeFlowTime: 20, routeLength: inLane.length + outLane.length,
        legStart: [0, inLane.length], holding: null, tripStart: 0,
      };
      sim.vehicles.push(car);
      sim.running = true;

      let prev = sim.poseOf(car)!.pos;
      let maxJump = 0;
      let worstSpeedError = 0;
      let fastestInBox = 0;
      let inBoxSamples = 0;
      const zone = sim.network.zoneOf(c.id);
      while (sim.vehicles.includes(car) && sim.time < 30) {
        sim.step(graph, C.SIM_STEP);
        const pose = sim.poseOf(car);
        if (!pose) break;
        const moved = Math.hypot(pose.pos.x - prev.x, pose.pos.y - prev.y);
        maxJump = Math.max(maxJump, moved);
        const inBox = car.leg === 0 ? inLane.length - car.s < zone : car.s < zone;
        if (inBox && car.v > 1) {
          inBoxSamples++;
          fastestInBox = Math.max(fastestInBox, car.v);
          worstSpeedError = Math.max(worstSpeedError, Math.abs(moved / C.SIM_STEP - car.v) / car.v);
        }
        prev = pose.pos;
      }
      return { maxJump, worstSpeedError, fastestInBox, inBoxSamples, arrived: !sim.vehicles.includes(car) };
    }

    it.each(['south', 'east', 'north'] as const)(
      'moves a car through the ring at its real speed, without jumps (west to %s)',
      (arm) => {
        const r = cross(arm);
        expect(r.arrived).toBe(true);
        expect(r.inBoxSamples).toBeGreaterThan(10);
        // One step at 13.9 m/s is 0.23 m; a teleport would show as metres.
        expect(r.maxJump).toBeLessThan(0.5);
        // Drawn speed matches the vehicle's speed to within the path's curvature.
        expect(r.worstSpeedError).toBeLessThan(0.15);
        // The limit holds all the way round, including the half after the car has crossed the node.
        expect(r.fastestInBox).toBeLessThan(C.ROUNDABOUT_SPEED * 1.1);
      },
    );

    it('slows an approaching car to the roundabout speed, not the plain junction speed', () => {
      const graph = new RoadGraph();
      const c = graph.addNode({ x: 0, y: 0 });
      const arms = [-150, 150].map((x) => graph.addNode({ x, y: 0 }));
      const arms2 = [-150, 150].map((y) => graph.addNode({ x: 0, y }));
      const edges = [...arms, ...arms2].map((a) => graph.addEdge(c.id, a.id, [{ ...c.pos }, { ...a.pos }]));
      graph.setControl(c.id, 'roundabout');
      const sim = new TrafficSim();
      (sim as unknown as { requestTrip(): void }).requestTrip = () => {};
      sim.step(graph, C.SIM_STEP);
      const inLane = sim.network.laneFor(edges[0].id, arms[0].id, graph)!;
      const outLane = sim.network.laneFor(edges[1].id, c.id, graph)!;
      const car: Vehicle = {
        id: 1, route: [inLane.id, outLane.id], leg: 0, s: inLane.length - 70, v: C.DESIRED_SPEED,
        desiredSpeed: C.DESIRED_SPEED, freeFlowTime: 20, routeLength: inLane.length + outLane.length,
        legStart: [0, inLane.length], holding: null, tripStart: 0,
      };
      sim.vehicles.push(car);
      sim.running = true;
      let atBox = NaN;
      while (car.leg === 0 && sim.time < 20) {
        sim.step(graph, C.SIM_STEP);
        if (Number.isNaN(atBox) && inLane.length - car.s <= sim.network.zoneOf(c.id)) atBox = car.v;
      }
      expect(atBox).toBeGreaterThan(C.ROUNDABOUT_SPEED * 0.85);
      expect(atBox).toBeLessThan(C.ROUNDABOUT_SPEED * 1.15);
      expect(C.ROUNDABOUT_SPEED).toBeGreaterThan(C.UNCONTROLLED_SPEED);
    });
  });
  describe('roundabout entry', () => {
    /**
     * A four-way roundabout with 150 m arms (node 1 centre; arms 2 west, 3 east, 4 north, 5 south)
     * and a way to put a vehicle at an exact distance along a movement's path.
     */
    function ring() {
      const graph = new RoadGraph();
      const c = graph.addNode({ x: 0, y: 0 });
      const arms = [
        graph.addNode({ x: -150, y: 0 }),
        graph.addNode({ x: 150, y: 0 }),
        graph.addNode({ x: 0, y: -150 }),
        graph.addNode({ x: 0, y: 150 }),
      ];
      for (const a of arms) graph.addEdge(c.id, a.id, [{ ...c.pos }, { ...a.pos }]);
      graph.setControl(c.id, 'roundabout');

      const sim = new TrafficSim();
      sim.step(graph, C.SIM_STEP);
      const inFrom = (n: number) => [...sim.network.lanes.values()].find((l) => l.from === n && l.to === 1)!;
      const outTo = (n: number) => [...sim.network.lanes.values()].find((l) => l.from === 1 && l.to === n)!;
      const move = (from: number, to: number) => sim.network.movementFor(inFrom(from).id, outTo(to).id)!;
      const internals = sim as unknown as { ringIsClear(m: ReturnType<typeof move>): boolean };
      let id = 800;

      /** Puts a vehicle, holding `m`, `q` metres along its path (negative: still approaching the box). */
      const hold = (m: ReturnType<typeof move>, q: number, v = C.ROUNDABOUT_SPEED) => {
        const inLane = sim.network.lanes.get(m.inLane)!;
        const onApproach = q <= m.zone;
        sim.vehicles.push({
          id: id++,
          route: [m.inLane, m.outLane],
          leg: onApproach ? 0 : 1,
          s: onApproach ? inLane.length - (m.zone - q) : q - (m.span - m.zone),
          v,
          desiredSpeed: C.DESIRED_SPEED,
          freeFlowTime: 10,
          routeLength: 200,
          legStart: [0, inLane.length],
          holding: { node: 1, key: m.key },
          tripStart: 0,
        });
      };
      return { sim, move, hold, clear: (m: ReturnType<typeof move>) => internals.ringIsClear(m), W: 2, E: 3, N: 4, S: 5 };
    }

    it('does not make opposite right turns wait for each other', () => {
      const { move, hold, clear, W, E, N, S } = ring();
      hold(move(W, S), 3);
      expect(clear(move(E, N))).toBe(true);
    });

    it('makes an entering car yield to a ring car that will reach its entry point soon', () => {
      const { move, hold, clear, W, E, S } = ring();
      // West to east sweeps the south side; a car just entering it reaches the south arm's entry within a few metres.
      hold(move(W, E), 0);
      expect(clear(move(S, W))).toBe(false);
    });

    it('lets a car in once the ring car has left the ring', () => {
      const { sim, move, hold, clear, W, E, S } = ring();
      const straight = move(W, E);
      hold(straight, straight.ring!.pathOut + 1);
      expect(sim.vehicles).toHaveLength(1);
      expect(clear(move(S, W))).toBe(true);
    });

    it('makes movements into the same exit take turns while the first is on the ring', () => {
      const { move, hold, clear, W, E, N } = ring();
      const first = move(W, N);
      hold(first, first.ring!.pathIn + 2);
      expect(clear(move(E, N))).toBe(false);
    });

    it('ignores cars from its own approach, which car following looks after', () => {
      const { move, hold, clear, W, E, S } = ring();
      hold(move(W, E), 0);
      expect(clear(move(W, S))).toBe(true);
    });

    it('yields to a faster ring car from further upstream than to a slower one', () => {
      // An east-to-south car sweeps the north and west sides, reaching the west entry after about
      // 22 m of ring: outside the yield distance for a slow car (14 m + 2 s of 0.5 m/s), inside it
      // for one at roundabout speed (14 m + 2 s of 8 m/s = 30 m).
      const slow = ring();
      slow.hold(slow.move(slow.E, slow.S), -6, 0.5);
      const fast = ring();
      fast.hold(fast.move(fast.E, fast.S), -6, C.ROUNDABOUT_SPEED);
      expect(slow.clear(slow.move(slow.W, slow.E))).toBe(true);
      expect(fast.clear(fast.move(fast.W, fast.E))).toBe(false);
    });
  });
});
