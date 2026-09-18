import { describe, expect, it } from 'vitest';
import { polylineLength, segmentIntersect } from './geom';

describe('segmentIntersect', () => {
  it('finds the crossing point of two segments that cross', () => {
    const hit = segmentIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 });
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(5);
    expect(hit!.point.y).toBeCloseTo(5);
    expect(hit!.t).toBeGreaterThanOrEqual(0);
    expect(hit!.t).toBeLessThanOrEqual(1);
    expect(hit!.u).toBeGreaterThanOrEqual(0);
    expect(hit!.u).toBeLessThanOrEqual(1);
  });

  it('returns null for segments that do not cross', () => {
    const hit = segmentIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 5 }, { x: 1, y: 5 });
    expect(hit).toBeNull();
  });
});

describe('polylineLength', () => {
  it('sums segment lengths', () => {
    const length = polylineLength([
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 3, y: 9 },
    ]);
    expect(length).toBeCloseTo(10);
  });
});
