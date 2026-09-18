import { describe, expect, it } from 'vitest';
import { RoadGraph } from './graph';

/** Every edge's geometry must be exactly incident to its endpoint nodes, never merely near them. */
function assertWelded(graph: RoadGraph): void {
  for (const edge of graph.edges.values()) {
    const a = graph.nodes.get(edge.a)!;
    const b = graph.nodes.get(edge.b)!;
    expect(edge.points[0]).toEqual(a.pos);
    expect(edge.points[edge.points.length - 1]).toEqual(b.pos);
  }
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
