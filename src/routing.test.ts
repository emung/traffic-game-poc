import { describe, expect, it } from 'vitest';
import { RoadGraph } from './graph';
import { Router } from './routing';

describe('Router', () => {
  it('prefers the shorter of two parallel routes', () => {
    const graph = new RoadGraph();
    const a = graph.addNode({ x: 0, y: 0 });
    const b = graph.addNode({ x: 100, y: 0 });
    const mid = graph.addNode({ x: 50, y: 50 });
    const short = graph.addEdge(a.id, b.id, [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    graph.addEdge(a.id, mid.id, [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    ]);
    graph.addEdge(mid.id, b.id, [
      { x: 50, y: 50 },
      { x: 100, y: 0 },
    ]);

    const router = new Router();
    router.sync(graph);
    expect(router.path(graph, a.id, b.id)).toEqual([short.id]);
  });

  it('returns null for unreachable nodes', () => {
    const graph = new RoadGraph();
    const a = graph.addNode({ x: 0, y: 0 });
    const b = graph.addNode({ x: 100, y: 0 });
    graph.addEdge(a.id, b.id, [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);

    const c = graph.addNode({ x: 500, y: 500 });
    const d = graph.addNode({ x: 600, y: 500 });
    graph.addEdge(c.id, d.id, [
      { x: 500, y: 500 },
      { x: 600, y: 500 },
    ]);

    const router = new Router();
    router.sync(graph);
    expect(router.path(graph, a.id, c.id)).toBeNull();
  });

  it('picks up a new shorter route after the graph changes', () => {
    const graph = new RoadGraph();
    const a = graph.addNode({ x: 0, y: 0 });
    const b = graph.addNode({ x: 100, y: 0 });
    const mid = graph.addNode({ x: 50, y: 50 });
    const long1 = graph.addEdge(a.id, mid.id, [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    ]);
    const long2 = graph.addEdge(mid.id, b.id, [
      { x: 50, y: 50 },
      { x: 100, y: 0 },
    ]);

    const router = new Router();
    router.sync(graph);
    expect(router.path(graph, a.id, b.id)).toEqual([long1.id, long2.id]);

    const short = graph.addEdge(a.id, b.id, [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    router.sync(graph);
    expect(router.path(graph, a.id, b.id)).toEqual([short.id]);
  });
});
