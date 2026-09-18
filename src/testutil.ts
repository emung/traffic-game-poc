import { type JunctionControl, RoadGraph, type RoadNode } from './graph';

/**
 * A small 2x2 grid of real four-way junctions with a dead-end stub off each one, so routes cross
 * several junctions and turning movements actually happen. Built directly with addNode/addEdge,
 * not addStroke, so the topology is exact and untouched by the simplify/smooth/weld pipeline.
 * Node ids 1-4 are the junctions, 5-12 the stubs. `control` is applied to all four junctions.
 *
 * `flyover` adds a bridge from the middle of j1's west stub (50,100) to the middle of j4's east
 * stub (250,200). Both ends are ramps (T junctions on the ground) that leave the stub at a right
 * angle, like every other junction here; its elevated span runs (50,130) -> (250,170), over
 * j1-j3 at (100,140) and j2-j4 at (200,160) with no node. It is the shortest way between the two
 * corners, so traffic actually uses it. Node ids 13 and 14 are the ramp nodes.
 *
 * The ramps are square on purpose. A road meeting another at a shallow angle (the straight
 * diagonal met the stubs at ~27 degrees) brings the two roads' lanes within ~2 m of each other
 * outside the junction box, where nothing keeps cars apart; that fails the clearance invariant
 * whether or not the road is a bridge.
 */
export const FLYOVER_CROSSINGS = [
  { x: 100, y: 140 },
  { x: 200, y: 160 },
];

export function buildGrid(control: JunctionControl | null = null, opts: { flyover?: boolean } = {}): RoadGraph {
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
  const edges = [
    link(j1, j2),
    link(j1, j3),
    link(j2, j4),
    link(j3, j4),
    link(j1, d1),
    link(j1, d5),
    link(j2, d2),
    link(j2, d6),
    link(j3, d3),
    link(j3, d7),
    link(j4, d4),
    link(j4, d8),
  ];

  if (opts.flyover) {
    const west = graph.splitEdge(edges[4].id, 0, 0.5);
    const east = graph.splitEdge(edges[10].id, 0, 0.5);
    const a = graph.nodes.get(west)!;
    const b = graph.nodes.get(east)!;
    const deck = [{ ...a.pos }, { x: 50, y: 130 }, { x: 250, y: 170 }, { ...b.pos }];
    graph.addEdge(a.id, b.id, deck, true);
  }

  if (control) for (const j of [j1, j2, j3, j4]) graph.setControl(j.id, control);
  return graph;
}
