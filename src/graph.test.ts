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
