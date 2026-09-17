import { type Vec2 } from './geom';

export class Camera {
  /** World position shown at the centre of the viewport. */
  x = 0;
  y = 0;
  /** Screen pixels per world unit. */
  zoom = 2;
  width = 1;
  height = 1;
  dpr = 1;

  worldToScreen(p: Vec2): Vec2 {
    return {
      x: (p.x - this.x) * this.zoom + this.width / 2,
      y: (p.y - this.y) * this.zoom + this.height / 2,
    };
  }

  screenToWorld(p: Vec2): Vec2 {
    return {
      x: (p.x - this.width / 2) / this.zoom + this.x,
      y: (p.y - this.height / 2) / this.zoom + this.y,
    };
  }

  applyTo(ctx: CanvasRenderingContext2D): void {
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x, -this.y);
  }

  zoomAt(screen: Vec2, factor: number): void {
    const before = this.screenToWorld(screen);
    this.zoom = Math.min(20, Math.max(0.25, this.zoom * factor));
    const after = this.screenToWorld(screen);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  panByScreen(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
  }

  visibleBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    const halfW = this.width / 2 / this.zoom;
    const halfH = this.height / 2 / this.zoom;
    return {
      minX: this.x - halfW,
      minY: this.y - halfH,
      maxX: this.x + halfW,
      maxY: this.y + halfH,
    };
  }
}
