import { describe, expect, it } from 'vitest';
import { RoadGraph } from './graph';
import { JUNCTION_RADIUS, RAMP_LENGTH } from './config';
import { buildBranch } from './testutil';

/** Every edge's geometry must be exactly incident to its endpoint nodes, never merely near them. */
function assertWelded(graph: RoadGraph): void {
  for (const edge of graph.edges.values()) {
    const a = graph.nodes.get(edge.a)!;
    const b = graph.nodes.get(edge.b)!;
    expect(edge.points[0]).toEqual(a.pos);
    expect(edge.points[edge.points.length - 1]).toEqual(b.pos);
  }
}

/** A two-point stroke. */
function line(x0: number, y0: number, x1: number, y1: number) {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y1 },
  ];
}

function degreeHistogram(graph: RoadGraph): number[] {
  return [...graph.nodes.values()].map((n) => n.edges.length).sort((a, b) => a - b);
}

describe('RoadGraph', () => {
  it('turns a single straight stroke into one edge between two nodes', () => {
    const graph = new RoadGraph();
    expect(
      graph.addStroke([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ]),
    ).toBe(true);

    expect(graph.nodes.size).toBe(2);
    expect(graph.edges.size).toBe(1);
    expect(degreeHistogram(graph)).toEqual([1, 1]);
    assertWelded(graph);
  });

  it('splits both strokes at an X crossing', () => {
    const graph = new RoadGraph();
    graph.addStroke([
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ]);
    graph.addStroke([
      { x: 50, y: 0 },
      { x: 50, y: 100 },
    ]);

    expect(graph.nodes.size).toBe(5);
    expect(graph.edges.size).toBe(4);
    expect(degreeHistogram(graph)).toEqual([1, 1, 1, 1, 4]);
    assertWelded(graph);
  });

  it('welds a new stroke onto the middle of an existing road (T junction)', () => {
    const graph = new RoadGraph();
    graph.addStroke([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    graph.addStroke([
      { x: 50, y: 40 },
      { x: 50, y: 3 },
    ]);

    expect(graph.nodes.size).toBe(4);
    expect(graph.edges.size).toBe(3);
    expect(degreeHistogram(graph)).toEqual([1, 1, 1, 3]);
    assertWelded(graph);
  });

  it('welds a new stroke onto an existing endpoint node instead of creating a new one', () => {
    const graph = new RoadGraph();
    graph.addStroke([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    graph.addStroke([
      { x: 100, y: 10 },
      { x: 200, y: 10 },
    ]);

    expect(graph.nodes.size).toBe(3);
    expect(degreeHistogram(graph)).toEqual([1, 1, 2]);
    assertWelded(graph);
  });

  it('splits a lasso stroke at its one self-crossing', () => {
    const graph = new RoadGraph();
    const ok = graph.addStroke([
      { x: 0, y: 0 },
      { x: 0, y: 80 },
      { x: 50, y: 80 },
      { x: 50, y: 40 },
      { x: -30, y: 40 },
    ]);
    expect(ok).toBe(true);

    expect(graph.edges.size).toBe(3);
    expect(degreeHistogram(graph)).toEqual([1, 1, 4]);
    assertWelded(graph);
  });

  it('welds a closed loop onto itself, with node.edges listing the edge twice', () => {
    const graph = new RoadGraph();
    const radius = 60;
    const points = Array.from({ length: 33 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return { x: radius * Math.cos(a), y: radius * Math.sin(a) };
    });
    expect(graph.addStroke(points)).toBe(true);

    expect(graph.nodes.size).toBe(1);
    expect(graph.edges.size).toBe(1);
    const [node] = graph.nodes.values();
    const [edge] = graph.edges.values();
    // A self-loop road meets its node at both ends, so the edge id must appear twice, not once:
    // node.edges is an array specifically to allow this, unlike a Set which would deduplicate it.
    expect(node.edges).toEqual([edge.id, edge.id]);
    assertWelded(graph);
  });

  it('erases every road and prunes orphaned nodes', () => {
    const graph = new RoadGraph();
    graph.addStroke([
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ]);
    graph.addStroke([
      { x: 50, y: 0 },
      { x: 50, y: 100 },
    ]);
    const versionBefore = graph.version;

    for (const id of [...graph.edges.keys()]) graph.removeEdge(id);
    graph.pruneOrphans();

    expect(graph.nodes.size).toBe(0);
    expect(graph.edges.size).toBe(0);
    expect(graph.version).toBeGreaterThan(versionBefore);
  });

  it('round-trips through toJSON/loadJSON and keeps ids monotonic', () => {
    const original = new RoadGraph();
    original.addStroke([
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ]);
    original.addStroke([
      { x: 50, y: 0 },
      { x: 50, y: 100 },
    ]);
    original.addStroke([
      { x: 150, y: 40 },
      { x: 150, y: 3 },
    ]);
    const maxIdBefore = Math.max(...original.nodes.keys(), ...original.edges.keys());
    const json = original.toJSON();

    const reloaded = new RoadGraph();
    reloaded.loadJSON(json);

    expect(reloaded.nodes.size).toBe(original.nodes.size);
    expect(reloaded.edges.size).toBe(original.edges.size);
    expect(degreeHistogram(reloaded)).toEqual(degreeHistogram(original));
    for (const [id, node] of original.nodes) {
      expect(reloaded.nodes.get(id)!.pos).toEqual(node.pos);
    }
    assertWelded(reloaded);

    reloaded.addStroke([
      { x: 300, y: 0 },
      { x: 400, y: 0 },
    ]);
    const newIds = [...reloaded.nodes.keys(), ...reloaded.edges.keys()].filter((id) => id > maxIdBefore);
    expect(newIds.length).toBeGreaterThan(0);
    for (const id of newIds) {
      expect(original.nodes.has(id) || original.edges.has(id)).toBe(false);
    }
  });
});

describe('junction control', () => {
  function crossing(): { graph: RoadGraph; centreId: number; endId: number } {
    const graph = new RoadGraph();
    graph.addStroke([
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ]);
    graph.addStroke([
      { x: 50, y: 0 },
      { x: 50, y: 100 },
    ]);
    const nodes = [...graph.nodes.values()];
    return {
      graph,
      centreId: nodes.find((n) => n.edges.length === 4)!.id,
      endId: nodes.find((n) => n.edges.length === 1)!.id,
    };
  }

  it('sets and clears a control, bumping the version so the lane network rebuilds', () => {
    const { graph, centreId } = crossing();
    const before = graph.version;

    expect(graph.setControl(centreId, 'signal')).toBe(true);
    expect(graph.nodes.get(centreId)!.control).toBe('signal');
    expect(graph.version).toBeGreaterThan(before);

    expect(graph.setControl(centreId, null)).toBe(true);
    expect(graph.nodes.get(centreId)!.control).toBeUndefined();
  });

  it('refuses a control on a dead end or an unknown node', () => {
    const { graph, endId } = crossing();
    const before = graph.version;

    expect(graph.setControl(endId, 'roundabout')).toBe(false);
    expect(graph.setControl(9999, 'signal')).toBe(false);
    expect(graph.nodes.get(endId)!.control).toBeUndefined();
    expect(graph.version).toBe(before);
  });

  it('survives a save/load round trip, and a save from before controls loads as plain', () => {
    const { graph, centreId } = crossing();
    graph.setControl(centreId, 'priority');

    const reloaded = new RoadGraph();
    reloaded.loadJSON(graph.toJSON());
    expect(reloaded.nodes.get(centreId)!.control).toBe('priority');

    const old = JSON.parse(graph.toJSON());
    delete old.format;
    for (const n of old.nodes) delete n.control;
    const legacy = new RoadGraph();
    legacy.loadJSON(JSON.stringify(old));
    expect(legacy.nodes.get(centreId)!.control).toBeUndefined();
  });

  it('keeps the control when a new road welds onto the junction', () => {
    const { graph, centreId } = crossing();
    graph.setControl(centreId, 'roundabout');

    // Ends on the centre node, so it welds to it instead of creating a new one.
    graph.addStroke([
      { x: 50, y: 50 },
      { x: 90, y: 90 },
    ]);
    expect(graph.nodes.get(centreId)!.control).toBe('roundabout');
  });

  it('starts a node created by splitting a road plain', () => {
    const { graph, centreId } = crossing();
    graph.setControl(centreId, 'signal');
    const known = new Set(graph.nodes.keys());

    graph.addStroke([
      { x: 20, y: 0 },
      { x: 20, y: 100 },
    ]);
    const created = [...graph.nodes.values()].filter((n) => !known.has(n.id));
    expect(created.length).toBeGreaterThan(0);
    for (const n of created) expect(n.control).toBeUndefined();
  });
});

describe('bridges', () => {
  const bridgeOf = (graph: RoadGraph) => [...graph.edges.values()].filter((e) => e.bridge);
  const groundOf = (graph: RoadGraph) => [...graph.edges.values()].filter((e) => !e.bridge);

  it('carries a bridge over a road with no junction', () => {
    const graph = new RoadGraph();
    graph.addStroke(line(0, 50, 100, 50));
    graph.addStroke(line(50, 0, 50, 100), { bridge: true });

    expect(graph.edges.size).toBe(2);
    expect(degreeHistogram(graph)).toEqual([1, 1, 1, 1]);
    expect(bridgeOf(graph)).toHaveLength(1);
    expect(groundOf(graph)[0].points).toEqual(line(0, 50, 100, 50));
    assertWelded(graph);
  });

  it('passes a road under a bridge with no junction', () => {
    const graph = new RoadGraph();
    graph.addStroke(line(50, 0, 50, 100), { bridge: true });
    graph.addStroke(line(0, 50, 100, 50));

    expect(graph.edges.size).toBe(2);
    expect(degreeHistogram(graph)).toEqual([1, 1, 1, 1]);
    expect(bridgeOf(graph)[0].points).toEqual(line(50, 0, 50, 100));
  });

  it('joins two crossing bridges at a junction up top', () => {
    const graph = new RoadGraph();
    graph.addStroke(line(0, 50, 100, 50), { bridge: true });
    graph.addStroke(line(50, 0, 50, 100), { bridge: true });

    expect(graph.edges.size).toBe(4);
    expect(degreeHistogram(graph)).toEqual([1, 1, 1, 1, 4]);
    expect(bridgeOf(graph)).toHaveLength(4);
    const centre = [...graph.nodes.values()].find((n) => n.edges.length === 4)!;
    expect(graph.isElevatedNode(centre.id)).toBe(true);
    assertWelded(graph);
  });

  it('welds a bridge end onto a bridge mid-span, up top', () => {
    const graph = new RoadGraph();
    graph.addStroke(line(0, 0, 100, 0), { bridge: true });
    graph.addStroke(line(50, 40, 50, 3), { bridge: true });

    expect(degreeHistogram(graph)).toEqual([1, 1, 1, 3]);
    const t = [...graph.nodes.values()].find((n) => n.edges.length === 3)!;
    expect(graph.isElevatedNode(t.id)).toBe(true);
  });

  it('lands a bridge on the middle of a road as a ramp (T junction)', () => {
    const graph = new RoadGraph();
    graph.addStroke(line(0, 0, 100, 0));
    graph.addStroke(line(50, 40, 50, 3), { bridge: true });

    expect(degreeHistogram(graph)).toEqual([1, 1, 1, 3]);
    expect(bridgeOf(graph)).toHaveLength(1);
    expect(groundOf(graph)).toHaveLength(2);
    const t = [...graph.nodes.values()].find((n) => n.edges.length === 3)!;
    expect(graph.isElevatedNode(t.id)).toBe(false);
    assertWelded(graph);
  });

  it('does not weld a road end onto a bridge mid-span', () => {
    const graph = new RoadGraph();
    graph.addStroke(line(0, 0, 100, 0), { bridge: true });
    graph.addStroke(line(50, 40, 50, 3));

    expect(graph.edges.size).toBe(2);
    expect(degreeHistogram(graph)).toEqual([1, 1, 1, 1]);
    expect(bridgeOf(graph)[0].points).toEqual(line(0, 0, 100, 0));
  });

  it('welds a road end on a ramp to the ramp node', () => {
    const graph = new RoadGraph();
    graph.addStroke(line(0, 0, 100, 0), { bridge: true });
    graph.addStroke(line(5, 40, 5, 3));

    expect(graph.edges.size).toBe(2);
    expect(degreeHistogram(graph)).toEqual([1, 1, 2]);
    expect(graph.nodeNear({ x: 0, y: 0 }, 0.01)!.edges).toHaveLength(2);
    assertWelded(graph);
  });

  it('makes a junction where a road crosses a ramp, since the ramp is on the ground', () => {
    const graph = new RoadGraph();
    graph.addStroke(line(0, 0, 100, 0), { bridge: true });
    graph.addStroke(line(8, -40, 8, 40));

    expect(degreeHistogram(graph)).toEqual([1, 1, 1, 1, 4]);
    const junction = [...graph.nodes.values()].find((n) => n.edges.length === 4)!;
    expect(junction.pos.x).toBeCloseTo(8);
    expect(graph.isElevatedNode(junction.id)).toBe(false);
    // Both halves of the bridge are still bridges; the span starts a ramp past the junction.
    expect(bridgeOf(graph)).toHaveLength(2);
  });

  it('keeps a bridge too short for its ramps on the ground, so a road crossing it meets it', () => {
    const graph = new RoadGraph();
    graph.addStroke(line(0, 0, 0, 2 * RAMP_LENGTH - 2), { bridge: true });
    expect(graph.elevatedRange(bridgeOf(graph)[0])).toBeNull();

    graph.addStroke(line(-50, 10, 50, 10));
    expect(degreeHistogram(graph)).toEqual([1, 1, 1, 1, 4]);
  });

  it('is elevated between its ramps, and right up to an end at a junction up top', () => {
    const graph = new RoadGraph();
    graph.addStroke(line(0, 0, 100, 0), { bridge: true });
    const [deck] = bridgeOf(graph);
    expect(graph.isElevatedAt(deck, RAMP_LENGTH - 1)).toBe(false);
    expect(graph.isElevatedAt(deck, 50)).toBe(true);
    expect(graph.isElevatedAt(deck, 100 - RAMP_LENGTH + 1)).toBe(false);

    // A second bridge makes the middle a junction up top: no ramp at that end of either half.
    graph.addStroke(line(50, -50, 50, 50), { bridge: true });
    const half = bridgeOf(graph).find((e) => e.points.some((p) => p.x === 0 && p.y === 0))!;
    const length = graph.edgeLength(half);
    const atCentre = graph.nodes.get(half.a)!.pos.x === 50 ? 1 : length - 1;
    expect(graph.isElevatedAt(half, atCentre)).toBe(true);

    graph.addStroke(line(0, 80, 100, 80));
    const road = groundOf(graph)[0];
    expect(graph.isElevatedAt(road, 50)).toBe(false);
  });

  it('erases a bridge without touching the road below', () => {
    const graph = new RoadGraph();
    graph.addStroke(line(0, 50, 100, 50));
    graph.addStroke(line(50, 0, 50, 100), { bridge: true });
    graph.removeEdge(bridgeOf(graph)[0].id);
    graph.pruneOrphans();

    expect(graph.nodes.size).toBe(2);
    expect(graph.edges.size).toBe(1);
    expect(groundOf(graph)[0].points).toEqual(line(0, 50, 100, 50));
  });

  it('survives a save/load round trip, and a save from before bridges loads as all ground', () => {
    const graph = new RoadGraph();
    graph.addStroke(line(0, 50, 100, 50));
    graph.addStroke(line(50, 0, 50, 100), { bridge: true });
    const saved = graph.toJSON();
    expect(JSON.parse(saved).format).toBe(3);

    const loaded = new RoadGraph();
    loaded.loadJSON(saved);
    expect(bridgeOf(loaded)).toHaveLength(1);
    expect(groundOf(loaded)).toHaveLength(1);

    const old = JSON.parse(saved);
    old.format = 2;
    for (const e of old.edges) delete e.bridge;
    const legacy = new RoadGraph();
    legacy.loadJSON(JSON.stringify(old));
    expect(bridgeOf(legacy)).toHaveLength(0);
    expect(legacy.edges.size).toBe(2);
  });
});

describe('junction box', () => {
  /** The reach the box needs at `degrees`: where two facing lanes are MOVEMENT_CLEARANCE apart. */
  const need = (degrees: number) => {
    const half = (degrees * Math.PI) / 360;
    return (3 / 2 + 2 * Math.cos(half)) / Math.sin(half);
  };

  it('stays at the junction radius where roads meet square, and at a dead end', () => {
    const graph = buildBranch(90);
    expect(graph.junctionZone(1)).toBe(JUNCTION_RADIUS);
    expect(graph.junctionZone(2)).toBe(JUNCTION_RADIUS);
  });

  it('reaches out as far as the sharpest pair of roads needs', () => {
    expect(buildBranch(45).junctionZone(1)).toBeCloseTo(need(45), 1);
    expect(buildBranch(27).junctionZone(1)).toBeCloseTo(need(27), 1);
    expect(need(45)).toBeGreaterThan(8);
  });

  it('never reaches past 45% of its shortest road', () => {
    const graph = new RoadGraph();
    const c = graph.addNode({ x: 0, y: 0 });
    for (const [x, y] of [
      [-100, 0],
      [100, 0],
      [20 * Math.cos(Math.PI / 6), 20 * Math.sin(Math.PI / 6)],
    ]) {
      const n = graph.addNode({ x, y });
      graph.addEdge(c.id, n.id, [{ ...c.pos }, { ...n.pos }]);
    }
    expect(graph.junctionZone(c.id)).toBeCloseTo(9, 5);
  });

  it('makes a ramp at least as long as the box at its end', () => {
    // A bridge landing at 27 degrees onto a road: that junction's box reaches ~14.7 m.
    const graph = new RoadGraph();
    graph.addStroke(line(0, 0, 200, 0));
    const a = (27 * Math.PI) / 180;
    graph.addStroke(line(100 + 150 * Math.cos(a), -150 * Math.sin(a), 100, 0), { bridge: true });
    const deck = [...graph.edges.values()].find((e) => e.bridge)!;
    const ramp = graph.nodes.get(deck.a)!.edges.length === 3 ? deck.a : deck.b;
    expect(graph.rampLength(ramp)).toBeCloseTo(need(27), 1);
    const span = graph.elevatedRange(deck)!;
    if (ramp === deck.b) expect(graph.edgeLength(deck) - span.hi).toBeCloseTo(need(27), 1);
    else expect(span.lo).toBeCloseTo(need(27), 1);
  });
});
