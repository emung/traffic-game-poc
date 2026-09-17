import { type Vec2, clone, lerp, dist, sub, add, scale, len } from './geom';

/** Ramer-Douglas-Peucker. Keeps both endpoints. */
export function simplify(pts: Vec2[], eps: number): Vec2[] {
  if (pts.length < 3) return pts.map(clone);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];

  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = pts[lo];
    const b = pts[hi];
    const ab = sub(b, a);
    const abLen = len(ab);
    let worstIdx = -1;
    let worstDist = eps;

    for (let i = lo + 1; i < hi; i++) {
      const p = pts[i];
      let d: number;
      if (abLen < 1e-9) {
        d = dist(p, a);
      } else {
        d = Math.abs(ab.x * (a.y - p.y) - (a.x - p.x) * ab.y) / abLen;
      }
      if (d > worstDist) {
        worstDist = d;
        worstIdx = i;
      }
    }

    if (worstIdx !== -1) {
      keep[worstIdx] = 1;
      stack.push([lo, worstIdx], [worstIdx, hi]);
    }
  }

  return pts.filter((_, i) => keep[i] === 1).map(clone);
}

/** One Chaikin corner-cutting pass for an open curve. Endpoints are preserved. */
function chaikinOnce(pts: Vec2[]): Vec2[] {
  if (pts.length < 3) return pts;
  const out: Vec2[] = [clone(pts[0])];
  for (let i = 0; i < pts.length - 1; i++) {
    out.push(lerp(pts[i], pts[i + 1], 0.25), lerp(pts[i], pts[i + 1], 0.75));
  }
  out.push(clone(pts[pts.length - 1]));
  return out;
}

export function smooth(pts: Vec2[], iterations: number): Vec2[] {
  let out = pts;
  for (let i = 0; i < iterations; i++) out = chaikinOnce(out);
  return out;
}

/**
 * Pull one end of the polyline onto `target`, fading the correction out over
 * `influence` world units so the snap does not leave a kink at the junction.
 */
export function nudgeEndpoint(pts: Vec2[], atStart: boolean, target: Vec2, influence: number): void {
  const idx = atStart ? 0 : pts.length - 1;
  const delta = sub(target, pts[idx]);
  if (len(delta) < 1e-9) return;

  const step = atStart ? 1 : -1;
  let acc = 0;
  let prev = pts[idx];
  for (let i = idx; i >= 0 && i < pts.length; i += step) {
    acc += dist(pts[i], prev);
    prev = pts[i];
    if (acc >= influence) break;
    pts[i] = add(pts[i], scale(delta, 1 - acc / influence));
  }
}
