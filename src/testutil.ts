import { type JunctionControl, RoadGraph, type RoadNode } from './graph';

/**
 * A small 2x2 grid of real four-way junctions with a dead-end stub off each one, so routes cross
 * several junctions and turning movements actually happen. Built directly with addNode/addEdge,
 * not addStroke, so the topology is exact and untouched by the simplify/smooth/weld pipeline.
 * Node ids 1-4 are the junctions, 5-12 the stubs. `control` is applied to all four junctions.
 */
export function buildGrid(control: JunctionControl | null = null): RoadGraph {
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

  if (control) for (const j of [j1, j2, j3, j4]) graph.setControl(j.id, control);
  return graph;
}
