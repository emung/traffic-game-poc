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

  /** A direct a-b road (100m) plus a detour via a node `detourY` metres off to the side. */
  function directAndDetour(detourY: number) {
    const graph = new RoadGraph();
    const a = graph.addNode({ x: 0, y: 0 });
    const b = graph.addNode({ x: 100, y: 0 });
    const mid = graph.addNode({ x: 50, y: detourY });
    const direct = graph.addEdge(a.id, b.id, [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    const via1 = graph.addEdge(a.id, mid.id, [
      { x: 0, y: 0 },
      { x: 50, y: detourY },
    ]);
    const via2 = graph.addEdge(mid.id, b.id, [
      { x: 50, y: detourY },
      { x: 100, y: 0 },
    ]);
    return { graph, a, b, direct, detour: [via1.id, via2.id] };
  }

  it('routes around a congested lane', () => {
    const { graph, a, b, direct, detour } = directAndDetour(100);
    const baseline = new Router();
    baseline.sync(graph);
    expect(baseline.path(graph, a.id, b.id)).toEqual([direct.id]);

    const router = new Router();
    router.sync(graph);
    router.updateTravelTimes(new Map([[direct.id * 2, 0]]));
    expect(router.path(graph, a.id, b.id)).toEqual(detour);
  });

  it('expires cached routes when travel times are updated', () => {
    const { graph, a, b, direct, detour } = directAndDetour(100);
    const router = new Router();
    router.sync(graph);
    expect(router.path(graph, a.id, b.id)).toEqual([direct.id]);

    router.updateTravelTimes(new Map([[direct.id * 2, 0]]));
    expect(router.path(graph, a.id, b.id)).toEqual(detour);
  });

  it('damps a new jam instead of switching to it instantly', () => {
    const { graph, a, b, direct, detour } = directAndDetour(600);
    const router = new Router();
    router.sync(graph);
    router.updateTravelTimes(new Map());
    expect(router.path(graph, a.id, b.id)).toEqual([direct.id]);

    const jammed = new Map([[direct.id * 2, 0]]);
    router.updateTravelTimes(jammed);
    expect(router.path(graph, a.id, b.id)).toEqual([direct.id]);

    for (let i = 0; i < 19; i++) router.updateTravelTimes(jammed);
    expect(router.path(graph, a.id, b.id)).toEqual(detour);
  });
});
