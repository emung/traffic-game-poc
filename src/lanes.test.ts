import { describe, expect, it } from 'vitest';
import { RoadGraph } from './graph';
import { LaneNetwork } from './lanes';
import { buildGrid } from './testutil';

/** A T: a west-east road with a stem to the south. Node ids: 1 centre, 2 west, 3 east, 4 south. */
function tJunction(control: 'priority' | 'signal' | null): RoadGraph {
  const graph = new RoadGraph();
  const c = graph.addNode({ x: 0, y: 0 });
  const w = graph.addNode({ x: -100, y: 0 });
  const e = graph.addNode({ x: 100, y: 0 });
  const s = graph.addNode({ x: 0, y: 100 });
  for (const n of [w, e, s]) graph.addEdge(c.id, n.id, [{ ...c.pos }, { ...n.pos }]);
  if (control) graph.setControl(c.id, control);
  return graph;
}

function build(graph: RoadGraph): LaneNetwork {
  const network = new LaneNetwork();
  network.build(graph);
  return network;
}

describe('LaneNetwork movements', () => {
  it('records conflicts symmetrically', () => {
    const network = build(buildGrid());
    for (const list of network.movements.values()) {
      for (const m of list) {
        for (const key of m.conflicts) expect(list[key].conflicts.has(m.key)).toBe(true);
      }
    }
  });
});

describe('priority junction', () => {
  it('makes the through road of a T the major road and the stem minor', () => {
    const graph = tJunction('priority');
    const network = build(graph);
    const major = network.majorLanes.get(1)!;
    expect(major.size).toBe(2);

    const laneFrom = (node: number) => [...network.lanes.values()].find((l) => l.from === node && l.to === 1)!;
    expect(major.has(laneFrom(2).id)).toBe(true);
    expect(major.has(laneFrom(3).id)).toBe(true);
    expect(major.has(laneFrom(4).id)).toBe(false);
  });

  it('never makes a major-road movement yield, and makes crossing minor movements yield', () => {
    const network = build(tJunction('priority'));
    const major = network.majorLanes.get(1)!;
    const list = network.movements.get(1)!;

    for (const m of list) {
      if (major.has(m.inLane)) expect(m.yieldsTo).toEqual([]);
    }
    const minor = list.filter((m) => !major.has(m.inLane));
    expect(minor.length).toBeGreaterThan(0);
    // The stem's turns all cross or merge with the through road.
    const yielding = minor.filter((m) => m.yieldsTo.length > 0);
    expect(yielding.length).toBeGreaterThan(0);
    for (const m of yielding) {
      for (const key of m.yieldsTo) {
        expect(major.has(list[key].inLane)).toBe(true);
        expect(m.conflicts.has(key)).toBe(true);
      }
    }
  });

  it('picks the two most opposite approaches at a four-way', () => {
    const network = build(buildGrid('priority'));
    for (const node of [1, 2, 3, 4]) {
      const major = [...network.majorLanes.get(node)!].map((id) => network.lanes.get(id)!);
      expect(major).toHaveLength(2);
      const dir = (l: (typeof major)[number]) => {
        const p = l.points;
        return { x: p.at(-1)!.x - p.at(-2)!.x, y: p.at(-1)!.y - p.at(-2)!.y };
      };
      const [a, b] = [dir(major[0]), dir(major[1])];
      const cos = (a.x * b.x + a.y * b.y) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y));
      expect(cos).toBeCloseTo(-1, 5);
    }
  });

  it('leaves signals and plain junctions with nothing to yield to', () => {
    for (const control of [null, 'signal'] as const) {
      const network = build(tJunction(control));
      expect(network.majorLanes.size).toBe(0);
      for (const list of network.movements.values()) for (const m of list) expect(m.yieldsTo).toEqual([]);
    }
  });

  it('ignores a control on a node that no longer has three roads', () => {
    const graph = tJunction('priority');
    graph.removeEdge([...graph.edges.values()][2].id);
    expect(build(graph).majorLanes.size).toBe(0);
  });
});

describe('choosing the major road at a priority junction', () => {
  /** A four-way whose west-east arms are `ew` long and north-south arms `ns` long. Node 1 is the centre. */
  function fourWay(ew: number, ns: number): RoadGraph {
    const graph = new RoadGraph();
    const c = graph.addNode({ x: 0, y: 0 });
    for (const [x, y] of [
      [-ew, 0],
      [ew, 0],
      [0, -ns],
      [0, ns],
    ]) {
      const n = graph.addNode({ x, y });
      graph.addEdge(c.id, n.id, [{ ...c.pos }, { ...n.pos }]);
    }
    graph.setControl(c.id, 'priority');
    return graph;
  }

  /** Whether the major road runs west-east, judged from where its approach lanes start. */
  function majorRunsEastWest(network: LaneNetwork): boolean {
    const ids = [...network.majorLanes.get(1)!];
    return ids.every((id) => {
      const lane = network.lanes.get(id)!;
      return lane.points[0].y === lane.points.at(-1)!.y || Math.abs(lane.points[0].y - lane.points.at(-1)!.y) < 1e-6;
    });
  }

  it('makes the longer road major when both axes are straight', () => {
    expect(majorRunsEastWest(build(fourWay(200, 100)))).toBe(true);
    expect(majorRunsEastWest(build(fourWay(100, 200)))).toBe(false);
  });

  it('lets the player override the rule, and the choice survives save and load', () => {
    const graph = fourWay(200, 100);
    // Rule says west-east; ask for north-south by giving the bearing of the north approach (south-bound, pi/2).
    expect(graph.setMajorBearing(1, Math.PI / 2)).toBe(true);
    expect(majorRunsEastWest(build(graph))).toBe(false);

    const reloaded = new RoadGraph();
    reloaded.loadJSON(graph.toJSON());
    expect(reloaded.nodes.get(1)!.majorBearing).toBeCloseTo(Math.PI / 2);
    expect(majorRunsEastWest(build(reloaded))).toBe(false);
  });

  it('falls back to the rule when the stored bearing matches no road any more', () => {
    const graph = fourWay(200, 100);
    graph.setMajorBearing(1, 1.0);
    expect(majorRunsEastWest(build(graph))).toBe(true);
  });

  it('clears the choice when the control changes, and only takes one on a priority junction', () => {
    const graph = fourWay(200, 100);
    graph.setMajorBearing(1, Math.PI / 2);
    graph.setControl(1, 'signal');
    expect(graph.nodes.get(1)!.majorBearing).toBeUndefined();
    expect(graph.setMajorBearing(1, 0)).toBe(false);
  });

  it('bumps the graph version so the network rebuilds with the new major road', () => {
    const graph = fourWay(200, 100);
    const before = graph.version;
    graph.setMajorBearing(1, Math.PI / 2);
    expect(graph.version).toBeGreaterThan(before);
  });

  it('rotates between the two axes of a four-way and has nothing to rotate at a T', () => {
    const graph = fourWay(200, 100);
    let network = build(graph);
    expect(majorRunsEastWest(network)).toBe(true);

    graph.setMajorBearing(1, network.nextMajorBearing(1)!);
    network = build(graph);
    expect(majorRunsEastWest(network)).toBe(false);

    graph.setMajorBearing(1, network.nextMajorBearing(1)!);
    network = build(graph);
    expect(majorRunsEastWest(network)).toBe(true);

    expect(build(tJunction('priority')).nextMajorBearing(1)).toBeNull();
  });
});

describe('roundabout', () => {
  /** A four-way with 100 m arms, all four junction paths built as a roundabout. Node 1 is the centre. */
  function roundabout(arm = 100): { graph: RoadGraph; network: LaneNetwork } {
    const graph = new RoadGraph();
    const c = graph.addNode({ x: 0, y: 0 });
    for (const [x, y] of [
      [-arm, 0],
      [arm, 0],
      [0, -arm],
      [0, arm],
    ]) {
      const n = graph.addNode({ x, y });
      graph.addEdge(c.id, n.id, [{ ...c.pos }, { ...n.pos }]);
    }
    graph.setControl(c.id, 'roundabout');
    return { graph, network: build(graph) };
  }

  const laneFrom = (network: LaneNetwork, node: number) =>
    [...network.lanes.values()].find((l) => l.from === node && l.to === 1)!;
  const laneTo = (network: LaneNetwork, node: number) =>
    [...network.lanes.values()].find((l) => l.from === 1 && l.to === node)!;

  it('has a bigger box than a plain junction, and none of the other controls', () => {
    const { network } = roundabout();
    expect(network.zoneOf(1)).toBe(12);
    expect(network.ringRadiusOf(1)).toBeCloseTo(7.2);
    expect(network.plainJunctions.has(1)).toBe(false);
    expect(build(tJunction(null)).zoneOf(1)).toBe(5);
    expect(build(tJunction(null)).ringRadiusOf(1)).toBeNull();
  });

  it('shrinks its box to fit short roads, but never below a plain junction', () => {
    expect(roundabout(20).network.zoneOf(1)).toBeCloseTo(9);
    expect(roundabout(8).network.zoneOf(1)).toBe(5);
  });

  it('circulates anticlockwise: a west arrival going straight on sweeps round the south side', () => {
    const { network } = roundabout();
    const m = network.movementFor(laneFrom(network, 2).id, laneTo(network, 3).id)!;
    // West arm is node 2 (x = -100), east arm node 3. Screen y points down, so "south" is +y.
    const lowest = Math.max(...m.path.map((p) => p.y));
    const highest = Math.min(...m.path.map((p) => p.y));
    expect(lowest).toBeGreaterThan(5);
    expect(highest).toBeGreaterThan(-1);
  });

  it('keeps every path on or just outside the ring, never through the middle', () => {
    const { network } = roundabout();
    const ring = network.ringRadiusOf(1)!;
    for (const m of network.movements.get(1)!) {
      const between = m.path.filter((p) => Math.hypot(p.x, p.y) < network.zoneOf(1) - 0.5);
      for (const p of between) expect(Math.hypot(p.x, p.y)).toBeGreaterThan(ring - 1.5);
    }
  });

  it('measures the crossing by true path length, not 2 x zone', () => {
    const { network } = roundabout();
    const west = laneFrom(network, 2);
    const right = network.movementFor(west.id, laneTo(network, 5)!.id)!; // west arm to the south arm
    const straight = network.movementFor(west.id, laneTo(network, 3).id)!;
    const left = network.movementFor(west.id, laneTo(network, 4).id)!;
    expect(right.span).toBeLessThan(straight.span);
    expect(straight.span).toBeLessThan(left.span);
    // A plain junction keeps the old fixed span.
    const plain = build(tJunction(null));
    for (const list of plain.movements.values()) for (const m of list) expect(m.span).toBe(2 * m.zone);
  });

  it('lets arrivals from opposite sides pass at once only when their arcs are apart', () => {
    const { network } = roundabout();
    const west = laneFrom(network, 2).id;
    const east = laneFrom(network, 3).id;
    const list = network.movements.get(1)!;
    const wToS = list.find((m) => m.inLane === west && m.outLane === laneTo(network, 5).id)!;
    const eToN = list.find((m) => m.inLane === east && m.outLane === laneTo(network, 4).id)!;
    // Two right turns on opposite sides sweep opposite quarters of the ring.
    expect(wToS.conflicts.has(eToN.key)).toBe(false);
    // Straight-through from the west crosses the whole southern half, so it conflicts with the
    // east arrival's straight-through, which sweeps the northern half's neighbours.
    const wToE = list.find((m) => m.inLane === west && m.outLane === laneTo(network, 3).id)!;
    expect(wToE.conflicts.size).toBeGreaterThan(0);
  });
});
