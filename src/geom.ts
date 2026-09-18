export interface Vec2 {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const clone = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

export function normalize(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Unit normal pointing to the right of `dir`, in screen coordinates where y grows downward. */
export const rightNormal = (dir: Vec2): Vec2 => ({ x: -dir.y, y: dir.x });

export interface SegHit {
  /** Parameter along the first segment, 0..1. */
  t: number;
  /** Parameter along the second segment, 0..1. */
  u: number;
  point: Vec2;
}

/** Proper crossing of two segments. Collinear overlaps are treated as no hit. */
export function segmentIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): SegHit | null {
  const r = sub(p2, p1);
  const s = sub(p4, p3);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-12) return null;
  const qp = sub(p3, p1);
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, point: add(p1, scale(r, t)) };
}

export interface ClosestHit {
  t: number;
  point: Vec2;
  dist: number;
}

export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): ClosestHit {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  if (l2 < 1e-12) return { t: 0, point: clone(a), dist: dist(p, a) };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2));
  const point = add(a, scale(ab, t));
  return { t, point, dist: dist(p, point) };
}

export interface PolyHit extends ClosestHit {
  segIdx: number;
}

export function closestOnPolyline(p: Vec2, pts: Vec2[]): PolyHit | null {
  if (pts.length < 2) return null;
  let best: PolyHit | null = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const hit = closestOnSegment(p, pts[i], pts[i + 1]);
    if (!best || hit.dist < best.dist) best = { ...hit, segIdx: i };
  }
  return best;
}

export function polylineLength(pts: Vec2[]): number {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += dist(pts[i], pts[i + 1]);
  return total;
}

/** Arc length from the start of the polyline to the point at `segIdx + t`. */
export function arcLengthAt(pts: Vec2[], segIdx: number, t: number): number {
  let total = 0;
  for (let i = 0; i < segIdx; i++) total += dist(pts[i], pts[i + 1]);
  return total + dist(pts[segIdx], pts[segIdx + 1]) * t;
}

export function splitPolyline(pts: Vec2[], segIdx: number, t: number): [Vec2[], Vec2[]] {
  const p = lerp(pts[segIdx], pts[segIdx + 1], t);
  return [
    [...pts.slice(0, segIdx + 1).map(clone), p],
    [clone(p), ...pts.slice(segIdx + 1).map(clone)],
  ];
}

/** The part of a polyline between arc lengths `s0` and `s1`, clamped to its ends. */
export function slicePolyline(pts: Vec2[], s0: number, s1: number): Vec2[] {
  const out: Vec2[] = [];
  let at = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = dist(pts[i], pts[i + 1]);
    const next = at + d;
    if (next >= s0 && at <= s1 && d > 0) {
      if (!out.length) out.push(lerp(pts[i], pts[i + 1], Math.max(0, (s0 - at) / d)));
      if (next <= s1) out.push(clone(pts[i + 1]));
      else {
        out.push(lerp(pts[i], pts[i + 1], (s1 - at) / d));
        break;
      }
    }
    at = next;
  }
  return out;
}

/** Smallest distance between two segments; zero when they cross. */
export function segmentDistance(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number {
  if (segmentIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    closestOnSegment(a1, b1, b2).dist,
    closestOnSegment(a2, b1, b2).dist,
    closestOnSegment(b1, a1, a2).dist,
    closestOnSegment(b2, a1, a2).dist,
  );
}

/** Intersection of two infinite lines given as point + direction, or null when near-parallel. */
export function lineIntersection(p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2): Vec2 | null {
  const denom = cross(d1, d2);
  if (Math.abs(denom) < 1e-6) return null;
  const t = cross(sub(p2, p1), d2) / denom;
  return add(p1, scale(d1, t));
}

export function quadraticBezier(a: Vec2, control: Vec2, b: Vec2, samples: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    out.push({
      x: u * u * a.x + 2 * u * t * control.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
    });
  }
  return out;
}

/** Smallest distance between two polylines. */
export function polylineDistance(a: Vec2[], b: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      best = Math.min(best, segmentDistance(a[i], a[i + 1], b[j], b[j + 1]));
      if (best === 0) return 0;
    }
  }
  return best;
}

/** Position and tangent at arc-length fraction `t` along a polyline. */
export function samplePolyline(pts: Vec2[], t: number): { pos: Vec2; dir: Vec2 } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  const target = Math.max(0, Math.min(1, t)) * total;
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < target) i++;
  const segLen = cum[i + 1] - cum[i];
  const f = segLen < 1e-9 ? 0 : (target - cum[i]) / segLen;
  return { pos: lerp(pts[i], pts[i + 1], f), dir: normalize(sub(pts[i + 1], pts[i])) };
}
