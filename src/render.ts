import { type Vec2 } from './geom';
import { type RoadEdge, type RoadGraph } from './graph';
import { type Camera } from './camera';
import { COLORS, ROAD_WIDTH, SNAP_RADIUS, CAR_LENGTH, CAR_WIDTH, LANE_OFFSET } from './config';
import { type TrafficSim } from './traffic';

export interface ViewState {
  liveStroke: Vec2[] | null;
  snap: { pos: Vec2; kind: 'node' | 'edge' } | null;
  hoverEdge: RoadEdge | null;
  debug: boolean;
}

function tracePolyline(ctx: CanvasRenderingContext2D, pts: Vec2[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
}

function drawGrid(ctx: CanvasRenderingContext2D, cam: Camera): void {
  const b = cam.visibleBounds();
  let spacing = 25;
  while (spacing * cam.zoom < 14) spacing *= 4;

  ctx.lineWidth = 1 / cam.zoom;
  for (let pass = 0; pass < 2; pass++) {
    const step = pass === 0 ? spacing : spacing * 4;
    ctx.strokeStyle = pass === 0 ? COLORS.gridMinor : COLORS.gridMajor;
    ctx.beginPath();
    for (let x = Math.floor(b.minX / step) * step; x <= b.maxX; x += step) {
      if (pass === 0 && x % (step * 4) === 0) continue;
      ctx.moveTo(x, b.minY);
      ctx.lineTo(x, b.maxY);
    }
    for (let y = Math.floor(b.minY / step) * step; y <= b.maxY; y += step) {
      if (pass === 0 && y % (step * 4) === 0) continue;
      ctx.moveTo(b.minX, y);
      ctx.lineTo(b.maxX, y);
    }
    ctx.stroke();
  }
}

function drawRoads(ctx: CanvasRenderingContext2D, graph: RoadGraph, view: ViewState): void {
  const edges = [...graph.edges.values()];
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.strokeStyle = COLORS.casing;
  ctx.lineWidth = ROAD_WIDTH + 2.5;
  for (const edge of edges) {
    tracePolyline(ctx, edge.points);
    ctx.stroke();
  }

  ctx.lineWidth = ROAD_WIDTH;
  for (const edge of edges) {
    ctx.strokeStyle = edge === view.hoverEdge ? COLORS.erase : COLORS.road;
    tracePolyline(ctx, edge.points);
    ctx.stroke();
  }

  ctx.strokeStyle = COLORS.centerline;
  ctx.lineWidth = 0.35;
  ctx.globalAlpha = 0.55;
  ctx.setLineDash([3, 4]);
  for (const edge of edges) {
    tracePolyline(ctx, edge.points);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawNodes(ctx: CanvasRenderingContext2D, graph: RoadGraph, cam: Camera): void {
  const r = Math.max(1.6, 4 / cam.zoom);
  for (const node of graph.nodes.values()) {
    ctx.fillStyle = node.edges.length >= 3 ? COLORS.node : COLORS.nodeEnd;
    ctx.beginPath();
    ctx.arc(node.pos.x, node.pos.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawOverlay(ctx: CanvasRenderingContext2D, cam: Camera, view: ViewState): void {
  if (view.liveStroke && view.liveStroke.length > 1) {
    ctx.strokeStyle = COLORS.stroke;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = ROAD_WIDTH;
    tracePolyline(ctx, view.liveStroke);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.2 / cam.zoom;
    ctx.stroke();
  }

  if (view.snap) {
    ctx.strokeStyle = COLORS.snap;
    ctx.lineWidth = 1.5 / cam.zoom;
    ctx.beginPath();
    ctx.arc(view.snap.pos.x, view.snap.pos.y, SNAP_RADIUS * 0.45, 0, Math.PI * 2);
    ctx.stroke();
    if (view.snap.kind === 'node') {
      ctx.beginPath();
      ctx.arc(view.snap.pos.x, view.snap.pos.y, SNAP_RADIUS * 0.18, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawDebug(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  graph: RoadGraph,
  view: ViewState,
): void {
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.5;
  for (const edge of graph.edges.values()) {
    for (const p of edge.points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 0.6 / cam.zoom * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (view.liveStroke) {
    ctx.fillStyle = COLORS.snap;
    for (const p of view.liveStroke) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 0.5 / cam.zoom * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawLabels(ctx: CanvasRenderingContext2D, cam: Camera, graph: RoadGraph): void {
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = '#cbd5e1';
  ctx.textAlign = 'center';
  for (const node of graph.nodes.values()) {
    const s = cam.worldToScreen(node.pos);
    if (s.x < -20 || s.y < -20 || s.x > cam.width + 20 || s.y > cam.height + 20) continue;
    ctx.fillText(`${node.id}·${node.edges.length}`, s.x, s.y - 8);
  }
}

/**
 * Paints congested lanes amber through red. Free-flowing lanes are left alone so a healthy
 * network stays calm and only the problems draw the eye.
 */
function drawHeat(ctx: CanvasRenderingContext2D, sim: TrafficSim): void {
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.lineWidth = LANE_OFFSET * 1.7;
  for (const lane of sim.network.lanes.values()) {
    const congestion = 1 - (sim.laneHeat.get(lane.id) ?? 1);
    if (congestion < 0.15) continue;
    const severity = Math.min(1, (congestion - 0.15) / 0.65);
    ctx.strokeStyle = `hsl(${Math.round(45 - 45 * severity)}, 90%, 55%)`;
    ctx.globalAlpha = 0.25 + 0.5 * severity;
    tracePolyline(ctx, lane.points);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawVehicles(ctx: CanvasRenderingContext2D, sim: TrafficSim): void {
  for (const v of sim.vehicles) {
    const pose = sim.poseOf(v);
    if (!pose) continue;
    const ratio = Math.min(1, v.v / v.desiredSpeed);
    ctx.save();
    ctx.translate(pose.pos.x, pose.pos.y);
    ctx.rotate(Math.atan2(pose.dir.y, pose.dir.x));
    ctx.fillStyle = `hsl(${Math.round(ratio * 115)}, 82%, 62%)`;
    ctx.fillRect(-CAR_LENGTH, -CAR_WIDTH / 2, CAR_LENGTH, CAR_WIDTH);
    ctx.restore();
  }
}

function drawBusyJunctions(ctx: CanvasRenderingContext2D, cam: Camera, graph: RoadGraph, sim: TrafficSim): void {
  ctx.strokeStyle = COLORS.junctionBusy;
  ctx.lineWidth = 1.2 / cam.zoom;
  for (const nodeId of sim.active.keys()) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue;
    ctx.beginPath();
    ctx.arc(node.pos.x, node.pos.y, 5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

export function render(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  graph: RoadGraph,
  sim: TrafficSim,
  view: ViewState,
): void {
  ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, cam.width, cam.height);

  ctx.save();
  cam.applyTo(ctx);
  drawGrid(ctx, cam);
  drawRoads(ctx, graph, view);
  drawHeat(ctx, sim);
  drawNodes(ctx, graph, cam);
  drawVehicles(ctx, sim);
  if (view.debug) drawBusyJunctions(ctx, cam, graph, sim);
  drawOverlay(ctx, cam, view);
  if (view.debug) drawDebug(ctx, cam, graph, view);
  ctx.restore();

  if (view.debug) drawLabels(ctx, cam, graph);
}
