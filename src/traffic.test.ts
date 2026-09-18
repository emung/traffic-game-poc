import { describe, expect, it } from 'vitest';
import { RoadGraph, type RoadNode } from './graph';
import { type Pose } from './lanes';
import { TrafficSim, type Vehicle } from './traffic';
import * as C from './config';

/**
 * A small 2x2 grid of real four-way junctions with a dead-end stub off each one, so routes cross
 * several junctions and turning movements actually happen. Built directly with addNode/addEdge,
 * not addStroke, so the topology is exact and untouched by the simplify/smooth/weld pipeline.
 */
function buildGrid(): RoadGraph {
  const graph = new RoadGraph();
  const j1 = graph.addNode({ x: 100, y: 100 });
  const j2 = graph.addNode({ x: 200, y: 100 });
  const j3 = graph.addNode({ x: 100, y: 200 });
  const j4 = graph.addNode({ x: 200, y: 200 });
  const d1 = graph.addNode({ x: 0, y: 100 });
  const d2 = graph.addNode({ x: 300, y: 100 });
  const d3 = graph.addNode({ x: 0, y: 200 });
  const d4 = graph.addNode({ x: 300, y: 200 });
  const d5 = graph.addNode({ x: 100, y: 0 });
  const d6 = graph.addNode({ x: 200, y: 0 });
  const d7 = graph.addNode({ x: 100, y: 300 });
  const d8 = graph.addNode({ x: 200, y: 300 });

  const link = (a: RoadNode, b: RoadNode) => graph.addEdge(a.id, b.id, [{ ...a.pos }, { ...b.pos }]);
  link(j1, j2);
  link(j1, j3);
  link(j2, j4);
  link(j3, j4);
  link(j1, d1);
  link(j1, d5);
  link(j2, d2);
  link(j2, d6);
  link(j3, d3);
  link(j3, d7);
  link(j4, d4);
  link(j4, d8);

  return graph;
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

  describe('junction invariants over a sustained run', () => {
    const SIM_SECONDS = 60;
    const STEPS = Math.round(SIM_SECONDS / C.SIM_STEP);

    it('never overlaps two vehicles on the same lane', () => {
      const graph = buildGrid();
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
      const graph = buildGrid();
      const sim = new TrafficSim();
      sim.running = true;
      let sawTraffic = false;
      const minGap = C.MOVEMENT_CLEARANCE;

      for (let i = 0; i < STEPS; i++) {
        sim.step(graph, C.SIM_STEP);
        if (sim.vehicles.length > 0) sawTraffic = true;

        const poses: Array<{ veh: Vehicle; pose: Pose }> = [];
        for (const v of sim.vehicles) {
          const pose = sim.poseOf(v);
          if (pose) poses.push({ veh: v, pose });
        }

        for (let a = 0; a < poses.length; a++) {
          for (let b = a + 1; b < poses.length; b++) {
            const d = Math.hypot(
              poses[a].pose.pos.x - poses[b].pose.pos.x,
              poses[a].pose.pos.y - poses[b].pose.pos.y,
            );
            if (d < minGap - 1e-2) {
              throw new Error(
                `closest-approach violation at t=${sim.time.toFixed(3)}s: vehicle ${poses[a].veh.id} ` +
                  `and ${poses[b].veh.id} are ${d.toFixed(3)}m apart (minimum is ${minGap.toFixed(3)}m)`,
              );
            }
          }
        }
      }

      expect(sawTraffic).toBe(true);
    });
  });

  it('keeps arrivals rising over several waves and avoids deadlock', () => {
    const graph = buildGrid();
    const sim = new TrafficSim();
    sim.running = true;

    const WAVES_TO_COVER = 4;
    const SIM_SECONDS = C.WAVE_SECONDS * WAVES_TO_COVER;
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
});
