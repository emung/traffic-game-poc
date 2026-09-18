import { polylineLength } from './geom';
import * as C from './config';
import { type RoadGraph } from './graph';

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.vals[a], this.vals[b]] = [this.vals[b], this.vals[a]];
  }

  push(key: number, val: number): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.vals[0];
    const key = this.keys.pop()!;
    const val = this.vals.pop()!;
    if (this.keys.length) {
      this.keys[0] = key;
      this.vals[0] = val;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

/** Dijkstra over the road graph, weighted by lane travel time, with per-pair result caching. */
export class Router {
  private lengths = new Map<number, number>();
  private weights = new Map<number, number>(); // directed lane id -> current travel-time weight
  private cache = new Map<string, number[] | null>();
  private builtVersion = -1;

  sync(graph: RoadGraph): void {
    if (graph.version === this.builtVersion) return;
    this.lengths.clear();
    this.weights.clear();
    this.cache.clear();
    for (const edge of graph.edges.values()) {
      this.lengths.set(edge.id, polylineLength(edge.points));
    }
    this.builtVersion = graph.version;
  }

  /**
   * Reweighs every lane from its current heat (1 = free flow, 0 = jammed) and expires the route
   * cache -- this is what "the route cache has to expire" means in practice. Each lane's new
   * weight is blended into its previous one on ROUTE_WEIGHT_TIME_CONSTANT, slower than the
   * ROUTE_REWEIGH_SECONDS cadence this runs on, so a lane that suddenly looks better doesn't send
   * every waiting trip onto it in one go only to send them all back next cycle. Heat is floored
   * before it divides anything: a fully jammed lane must read as a severe, finite penalty, never
   * Infinity, or Dijkstra can wrongly report "no route" when the jam is the only way through.
   */
  updateTravelTimes(laneHeat: ReadonlyMap<number, number>): void {
    const alpha = 1 - Math.exp(-C.ROUTE_REWEIGH_SECONDS / C.ROUTE_WEIGHT_TIME_CONSTANT);
    const next = new Map<number, number>();
    const blend = (laneId: number, length: number): void => {
      const heat = Math.max(C.MIN_ROUTING_HEAT, laneHeat.get(laneId) ?? 1);
      const raw = length / (C.DESIRED_SPEED * heat);
      const prev = this.weights.get(laneId);
      next.set(laneId, prev === undefined ? raw : prev + (raw - prev) * alpha);
    };
    for (const [edgeId, length] of this.lengths) {
      blend(edgeId * 2, length);
      blend(edgeId * 2 + 1, length);
    }
    this.weights = next;
    this.cache.clear();
  }

  /** Edge ids from `from` to `to`, or null when unreachable. */
  path(graph: RoadGraph, from: number, to: number): number[] | null {
    const key = `${from}>${to}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const best = new Map<number, number>([[from, 0]]);
    const prevEdge = new Map<number, number>();
    const done = new Set<number>();
    const heap = new MinHeap();
    heap.push(0, from);

    while (heap.size) {
      const node = heap.pop();
      if (done.has(node)) continue;
      done.add(node);
      if (node === to) break;

      const d = best.get(node)!;
      for (const edgeId of graph.nodes.get(node)!.edges) {
        const edge = graph.edges.get(edgeId)!;
        const other = edge.a === node ? edge.b : edge.a;
        const laneId = edge.a === node ? edgeId * 2 : edgeId * 2 + 1;
        const weight = this.weights.get(laneId) ?? this.lengths.get(edgeId)! / C.DESIRED_SPEED;
        const next = d + weight;
        if (next < (best.get(other) ?? Infinity)) {
          best.set(other, next);
          prevEdge.set(other, edgeId);
          heap.push(next, other);
        }
      }
    }

    let result: number[] | null = null;
    if (best.has(to)) {
      const edges: number[] = [];
      let cur = to;
      while (cur !== from) {
        const edgeId = prevEdge.get(cur);
        if (edgeId === undefined) break;
        edges.push(edgeId);
        const edge = graph.edges.get(edgeId)!;
        cur = edge.a === cur ? edge.b : edge.a;
      }
      if (cur === from) result = edges.reverse();
    }

    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(key, result);
    return result;
  }
}
