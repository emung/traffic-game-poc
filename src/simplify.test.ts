import { describe, expect, it } from 'vitest';
import { simplify, smooth } from './simplify';

describe('simplify', () => {
  it('collapses many collinear points to the two endpoints', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i * 5, y: 0 }));
    const out = simplify(pts, 1);
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 95, y: 0 },
    ]);
  });
});

describe('smooth', () => {
  it('leaves the endpoints of the stroke unchanged', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 20 },
      { x: 30, y: 0 },
      { x: 40, y: 15 },
    ];
    const out = smooth(pts, 2);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
  });
});
