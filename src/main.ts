import { type Vec2, dist } from './geom';
import { RoadGraph, type RoadEdge } from './graph';
import { Camera } from './camera';
import { render, type ViewState } from './render';
import { TrafficSim } from './traffic';
import { MAX_SUBSTEPS, SAMPLE_SPACING_PX, SIM_STEP, SNAP_RADIUS, UNDO_LIMIT } from './config';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const cam = new Camera();
const graph = new RoadGraph();
const sim = new TrafficSim();

type Tool = 'draw' | 'erase';
let tool: Tool = 'draw';
let spaceHeld = false;
let panning = false;
let drawing = false;
let stroke: Vec2[] = [];
let lastScreen: Vec2 = { x: 0, y: 0 };

const view: ViewState = { liveStroke: null, snap: null, hoverEdge: null, debug: false };
const undoStack: string[] = [];

const STORAGE_KEY = 'traffic-game/graph';

function pushUndo(): void {
  undoStack.push(graph.toJSON());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function persist(): void {
  localStorage.setItem(STORAGE_KEY, graph.toJSON());
}

function restore(): void {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) graph.loadJSON(saved);
}

function fitView(): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of graph.nodes.values()) {
    minX = Math.min(minX, node.pos.x);
    maxX = Math.max(maxX, node.pos.x);
    minY = Math.min(minY, node.pos.y);
    maxY = Math.max(maxY, node.pos.y);
  }
  if (minX === Infinity) {
    cam.x = 0;
    cam.y = 0;
    cam.zoom = 2;
    return;
  }
  cam.x = (minX + maxX) / 2;
  cam.y = (minY + maxY) / 2;
  const pad = 80;
  cam.zoom = Math.min(
    20,
    Math.max(0.25, Math.min(cam.width / (maxX - minX + pad), cam.height / (maxY - minY + pad))),
  );
}

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  cam.width = canvas.clientWidth;
  cam.height = canvas.clientHeight;
  cam.dpr = dpr;
  canvas.width = Math.round(cam.width * dpr);
  canvas.height = Math.round(cam.height * dpr);
}

function screenOf(e: PointerEvent | WheelEvent): Vec2 {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function snapTargetAt(p: Vec2): ViewState['snap'] {
  const node = graph.nodeNear(p, SNAP_RADIUS);
  if (node) return { pos: node.pos, kind: 'node' };
  const hit = graph.edgeNear(p, SNAP_RADIUS);
  if (hit) return { pos: hit.point, kind: 'edge' };
  return null;
}

function edgeUnder(p: Vec2): RoadEdge | null {
  return graph.edgeNear(p, 6)?.edge ?? null;
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  lastScreen = screenOf(e);

  if (e.button === 1 || spaceHeld) {
    panning = true;
    return;
  }
  if (e.button !== 0) return;

  const world = cam.screenToWorld(lastScreen);
  if (tool === 'erase') {
    const edge = edgeUnder(world);
    if (edge) {
      pushUndo();
      graph.removeEdge(edge.id);
      graph.pruneOrphans();
      view.hoverEdge = null;
      persist();
    }
    return;
  }

  drawing = true;
  stroke = [world];
  view.liveStroke = stroke;
});

canvas.addEventListener('pointermove', (e) => {
  const screen = screenOf(e);
  const world = cam.screenToWorld(screen);

  if (panning) {
    cam.panByScreen(screen.x - lastScreen.x, screen.y - lastScreen.y);
    lastScreen = screen;
    return;
  }
  lastScreen = screen;

  if (drawing) {
    const spacing = SAMPLE_SPACING_PX / cam.zoom;
    if (dist(world, stroke[stroke.length - 1]) >= spacing) stroke.push(world);
    view.snap = snapTargetAt(world);
    return;
  }

  view.snap = tool === 'draw' ? snapTargetAt(world) : null;
  view.hoverEdge = tool === 'erase' ? edgeUnder(world) : null;
});

function endStroke(): void {
  if (!drawing) return;
  drawing = false;
  view.liveStroke = null;
  view.snap = null;

  pushUndo();
  if (graph.addStroke(stroke)) persist();
  else undoStack.pop();
  stroke = [];
}

canvas.addEventListener('pointerup', () => {
  panning = false;
  endStroke();
});

canvas.addEventListener('pointercancel', () => {
  panning = false;
  drawing = false;
  view.liveStroke = null;
  stroke = [];
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    cam.zoomAt(screenOf(e), Math.exp(-e.deltaY * 0.0015));
  },
  { passive: false },
);

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function setTool(next: Tool): void {
  tool = next;
  view.snap = null;
  view.hoverEdge = null;
  canvas.classList.toggle('erasing', tool === 'erase');
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#tools button')) {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  }
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('#tools button')) {
  btn.addEventListener('click', () => setTool(btn.dataset.tool as Tool));
}

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    const snapshot = undoStack.pop();
    if (snapshot) {
      graph.loadJSON(snapshot);
      sim.reset();
      view.hoverEdge = null;
      persist();
    }
    return;
  }
  switch (e.key.toLowerCase()) {
    case ' ':
      spaceHeld = true;
      canvas.classList.add('panning');
      break;
    case 'd':
      setTool('draw');
      break;
    case 'e':
      setTool('erase');
      break;
    case 'g':
      view.debug = !view.debug;
      break;
    case 'f':
      fitView();
      break;
    case 'c':
      pushUndo();
      graph.clear();
      sim.reset();
      persist();
      break;
    case 'p':
      setRunning(!sim.running);
      break;
    case 'r':
      sim.reset();
      setRunning(true);
      break;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceHeld = false;
    panning = false;
    canvas.classList.remove('panning');
  }
});

const playBtn = document.getElementById('play') as HTMLButtonElement;

function setRunning(run: boolean): void {
  sim.running = run;
  playBtn.textContent = run ? 'Pause' : 'Play';
  playBtn.classList.toggle('active', run);
}

playBtn.addEventListener('click', () => setRunning(!sim.running));

const el = {
  nodes: document.getElementById('n-nodes')!,
  edges: document.getElementById('n-edges')!,
  junctions: document.getElementById('n-junctions')!,
  deadends: document.getElementById('n-deadends')!,
  length: document.getElementById('n-length')!,
  wave: document.getElementById('n-wave')!,
  cars: document.getElementById('n-cars')!,
  speed: document.getElementById('n-speed')!,
  arrived: document.getElementById('n-arrived')!,
  flow: document.getElementById('n-flow')!,
  trip: document.getElementById('n-trip')!,
  banner: document.getElementById('banner') as HTMLElement,
  bannerSub: document.getElementById('banner-sub')!,
};

const sparkFlow = (document.getElementById('spark-flow') as HTMLCanvasElement).getContext('2d')!;
const sparkTrip = (document.getElementById('spark-trip') as HTMLCanvasElement).getContext('2d')!;

/**
 * Draws one metric's recent history. The scale is taken from the data rather than fixed, so a
 * change the player just drew is visible even when the absolute numbers are small.
 */
function drawSpark(
  c: CanvasRenderingContext2D,
  values: number[],
  colour: string,
  lowerIsBetter: boolean,
): void {
  const { width: w, height: h } = c.canvas;
  c.clearRect(0, 0, w, h);
  if (values.length < 2) return;

  const peak = Math.max(...values, 1e-6);
  const pad = 4;
  const x = (i: number) => (i / (values.length - 1)) * w;
  const y = (v: number) => h - pad - (v / peak) * (h - pad * 2);

  c.beginPath();
  c.moveTo(x(0), h);
  for (let i = 0; i < values.length; i++) c.lineTo(x(i), y(values[i]));
  c.lineTo(x(values.length - 1), h);
  c.closePath();
  c.fillStyle = colour;
  c.globalAlpha = 0.16;
  c.fill();

  c.globalAlpha = 1;
  c.beginPath();
  for (let i = 0; i < values.length; i++) {
    if (i === 0) c.moveTo(x(i), y(values[i]));
    else c.lineTo(x(i), y(values[i]));
  }
  c.strokeStyle = colour;
  c.lineWidth = 2;
  c.stroke();

  // mark the latest value, green when the metric is heading the right way
  const last = values[values.length - 1];
  const prev = values[Math.max(0, values.length - 6)];
  const improving = lowerIsBetter ? last < prev : last > prev;
  c.beginPath();
  c.arc(x(values.length - 1), y(last), 3, 0, Math.PI * 2);
  c.fillStyle = improving ? '#4ade80' : '#f87171';
  c.fill();
}

function updateHud(): void {
  let junctions = 0;
  let deadends = 0;
  for (const node of graph.nodes.values()) {
    if (node.edges.length >= 3) junctions++;
    else if (node.edges.length === 1) deadends++;
  }
  el.nodes.textContent = String(graph.nodes.size);
  el.edges.textContent = String(graph.edges.size);
  el.junctions.textContent = String(junctions);
  el.deadends.textContent = String(deadends);
  const m = graph.totalLength();
  el.length.textContent = m > 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;

  const t = sim.stats();
  el.wave.textContent = String(t.wave);
  el.cars.textContent = String(t.vehicles);
  el.speed.textContent = `${t.avgSpeedKmh.toFixed(0)} km/h`;
  el.arrived.textContent = String(t.arrivals);
  el.flow.textContent = `${t.flowPerMin.toFixed(1)} /min`;
  el.trip.textContent = t.avgTripSeconds
    ? `${t.delayRatio.toFixed(1)}x · ${t.avgTripSeconds.toFixed(0)} s`
    : '--';

  drawSpark(sparkFlow, sim.history.map((h) => h.flow), '#7dd3fc', false);
  drawSpark(sparkTrip, sim.history.map((h) => h.delay), '#fbbf24', true);

  el.banner.hidden = !t.failed;
  if (t.failed) {
    el.bannerSub.textContent = `wave ${t.wave} · journeys took ${t.delayRatio.toFixed(1)}x too long`;
  }
  if (t.failed && playBtn.textContent !== 'Play') setRunning(false);
}

let lastTime = performance.now();
let accumulator = 0;

function frame(now: number): void {
  accumulator += Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;

  let steps = 0;
  while (accumulator >= SIM_STEP && steps < MAX_SUBSTEPS) {
    sim.step(graph, SIM_STEP);
    accumulator -= SIM_STEP;
    steps++;
  }
  // Drop the backlog rather than spiralling if a frame ran long.
  if (steps === MAX_SUBSTEPS) accumulator = 0;

  sim.sync(graph);
  render(ctx, cam, graph, sim, view);
  updateHud();
  requestAnimationFrame(frame);
}

window.addEventListener('resize', resize);
resize();
restore();
setRunning(true);
requestAnimationFrame(frame);

Object.assign(window, { graph, cam, sim });
