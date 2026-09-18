import { describe, expect, it } from 'vitest';
import { Camera } from './camera';

describe('Camera', () => {
  it('round-trips world <-> screen coordinates', () => {
    const cam = new Camera();
    cam.width = 800;
    cam.height = 600;
    cam.x = 120;
    cam.y = -40;
    cam.zoom = 3.5;

    for (const p of [
      { x: 0, y: 0 },
      { x: 500, y: -250 },
      { x: -80, y: 300 },
    ]) {
      const screen = cam.worldToScreen(p);
      const world = cam.screenToWorld(screen);
      expect(world.x).toBeCloseTo(p.x);
      expect(world.y).toBeCloseTo(p.y);
    }
  });
});
