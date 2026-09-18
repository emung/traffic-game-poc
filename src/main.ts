import { type Vec2, dist } from './geom';
import { RoadGraph, type RoadEdge } from './graph';
import { Camera } from './camera';
import { render, type ViewState } from './render';
import { TrafficSim } from './traffic';
import {
  MAX_SUBSTEPS,
  SAMPLE_SPACING_PX,
  SIM_STEP,
  SNAP_RADIUS,
  UNDO_LIMIT,
  WAVE_SECONDS,
} from './config';

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
/** Simulated seconds per real second. */
let speed = 1;

const view: ViewState = { liveStroke: null, snap: null, hoverEdge: null, debug: false };
const undoStack: string[] = [];

const STORAGE_KEY = 'traffic-game/graph';
const BEST_WAVE_KEY = 'traffic-game/best-wave';

let bestWave = Number(localStorage.getItem(BEST_WAVE_KEY)) || 0;
/** The record as it stood when this run began, so the end of a run can say whether it beat it. */
let bestBeforeRun = bestWave;
let failureShown = false;

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

/**
 * The part of the screen the stats panel and toolbar do not cover, measured from the panels
 * themselves. On a narrow screen the stats panel is left out, since reserving it would leave
 * almost nothing to frame the network in.
 */
function unobstructedArea(): { left: number; top: number; right: number; bottom: number } {
  const stats = document.getElementById('stats')!.getBoundingClientRect();
  const toolbar = document.getElementById('toolbar')!.getBoundingClientRect();
  const left = cam.width - stats.right > 300 ? stats.right + 12 : 12;
  return { left, top: 12, right: cam.width - 12, bottom: toolbar.top - 12 };
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
  const area = unobstructedArea();
  const pad = 80;
  cam.zoom = Math.min(
    20,
    Math.max(
      0.25,
      Math.min((area.right - area.left) / (maxX - minX + pad), (area.bottom - area.top) / (maxY - minY + pad)),
    ),
  );
  // Put the network's centre at the centre of the visible area rather than of the window.
  cam.x = (minX + maxX) / 2 - ((area.left + area.right) / 2 - cam.width / 2) / cam.zoom;
  cam.y = (minY + maxY) / 2 - ((area.top + area.bottom) / 2 - cam.height / 2) / cam.zoom;
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

function buttons(action: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(`#toolbar [data-action="${action}"]`)];
}

function setTool(next: Tool): void {
  tool = next;
  view.snap = null;
  view.hoverEdge = null;
  canvas.classList.toggle('erasing', tool === 'erase');
  for (const btn of buttons('draw')) btn.classList.toggle('active', tool === 'draw');
  for (const btn of buttons('erase')) btn.classList.toggle('active', tool === 'erase');
}

function setRunning(run: boolean): void {
  sim.running = run;
  for (const btn of buttons('play')) {
    btn.querySelector('.label')!.textContent = run ? 'Pause' : 'Play';
    btn.classList.toggle('active', !run);
  }
}

function setSpeed(next: number): void {
  speed = next;
  for (const btn of buttons('speed')) btn.classList.toggle('active', Number(btn.dataset.speed) === speed);
}

function setDebug(on: boolean): void {
  view.debug = on;
  for (const btn of buttons('debug')) btn.classList.toggle('active', on);
}

const help = document.getElementById('help') as HTMLElement;

function toggleHelp(): void {
  help.hidden = !help.hidden;
  for (const btn of buttons('help')) btn.classList.toggle('active', !help.hidden);
}

function startRun(): void {
  sim.reset();
  bestBeforeRun = bestWave;
  failureShown = false;
  setRunning(true);
}

/**
 * Undo rewinds the roads, not the run. Traffic on roads that survive keeps going, which is what
 * makes fixing a bad stroke mid-wave cheap; restarting the run is a separate, explicit action.
 */
function undo(): void {
  const snapshot = undoStack.pop();
  if (!snapshot) return;
  graph.loadJSON(snapshot);
  view.hoverEdge = null;
  persist();
}

function clearAll(): void {
  pushUndo();
  graph.clear();
  persist();
  startRun();
}

const actions: Record<string, (btn: HTMLButtonElement) => void> = {
  draw: () => setTool('draw'),
  erase: () => setTool('erase'),
  play: () => setRunning(!sim.running),
  speed: (btn) => setSpeed(Number(btn.dataset.speed)),
  reset: () => startRun(),
  undo: () => undo(),
  clear: () => clearAll(),
  fit: () => fitView(),
  debug: () => setDebug(!view.debug),
  help: () => toggleHelp(),
};

for (const btn of document.querySelectorAll<HTMLButtonElement>('#toolbar button')) {
  btn.addEventListener('click', () => {
    actions[btn.dataset.action!](btn);
    // Give focus back to the page: a focused button would otherwise be pressed by the next
    // space bar, which is also the pan key.
    btn.blur();
  });
}

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  // Leave browser shortcuts alone: without this, copying with Cmd+C cleared the whole map.
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key.toLowerCase()) {
    case ' ':
      e.preventDefault();
      spaceHeld = true;
      canvas.classList.add('panning');
      break;
    case 'd':
      setTool('draw');
      break;
    case 'e':
      setTool('erase');
      break;
    case 'p':
      setRunning(!sim.running);
      break;
    case '1':
    case '2':
    case '4':
      setSpeed(Number(e.key));
      break;
    case 'r':
      startRun();
      break;
    case 'c':
      clearAll();
      break;
    case 'f':
      fitView();
      break;
    case 'g':
      setDebug(!view.debug);
      break;
    case '?':
      toggleHelp();
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

const el = {
  structure: document.getElementById('structure') as HTMLElement,
  nodes: document.getElementById('n-nodes')!,
  edges: document.getElementById('n-edges')!,
  junctions: document.getElementById('n-junctions')!,
  deadends: document.getElementById('n-deadends')!,
  wave: document.getElementById('n-wave')!,
  best: document.getElementById('n-best')!,
  waveBar: document.getElementById('wave-bar') as HTMLElement,
  next: document.getElementById('n-next')!,
  cars: document.getElementById('n-cars')!,
  speed: document.getElementById('n-speed')!,
  waiting: document.getElementById('n-waiting')!,
  arrived: document.getElementById('n-arrived')!,
  length: document.getElementById('n-length')!,
  flow: document.getElementById('n-flow')!,
  trip: document.getElementById('n-trip')!,
  hold: document.getElementById('hold') as HTMLElement,
  banner: document.getElementById('banner') as HTMLElement,
  bannerSub: document.getElementById('banner-sub')!,
  bannerBest: document.getElementById('banner-best')!,
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
  el.structure.hidden = !view.debug;
  if (view.debug) {
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
  }

  const t = sim.stats();
  const busy = t.vehicles > 0 || t.waiting > 0;
  if (busy && t.wave > bestWave) {
    bestWave = t.wave;
    localStorage.setItem(BEST_WAVE_KEY, String(bestWave));
  }
  el.wave.textContent = String(t.wave);
  el.best.textContent = String(bestWave);
  el.waveBar.style.width = `${(1 - sim.waveRemaining / WAVE_SECONDS) * 100}%`;
  el.next.textContent = busy ? `in ${Math.ceil(sim.waveRemaining)} s` : 'no traffic';

  el.cars.textContent = String(t.vehicles);
  el.speed.textContent = `${t.avgSpeedKmh.toFixed(0)} km/h`;
  el.waiting.textContent = String(t.waiting);
  el.arrived.textContent = String(t.arrivals);
  const m = graph.totalLength();
  el.length.textContent = m > 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  el.flow.textContent = `${t.flowPerMin.toFixed(1)} /min`;
  el.trip.textContent = t.avgTripSeconds
    ? `${t.delayRatio.toFixed(1)}x · ${t.avgTripSeconds.toFixed(0)} s`
    : '--';

  drawSpark(sparkFlow, sim.history.map((h) => h.flow), '#7dd3fc', false);
  // Plotted as delay beyond a free run, so an unobstructed network sits on the floor of the
  // chart rather than a flat line at 1x reading as maxed out.
  drawSpark(sparkTrip, sim.history.map((h) => h.delay - 1), '#fbbf24', true);

  if (t.failed && !failureShown) {
    failureShown = true;
    setRunning(false);
    el.bannerSub.textContent = `gridlocked in wave ${t.wave} · journeys took ${t.delayRatio.toFixed(1)}x too long`;
    el.bannerBest.textContent =
      t.wave > bestBeforeRun ? `new best: wave ${t.wave}` : `best: wave ${bestWave}`;
  }
  el.banner.hidden = !t.failed;
  el.hold.hidden = !(drawing && sim.running);
}

let lastTime = performance.now();
let accumulator = 0;

function frame(now: number): void {
  const elapsed = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;

  if (drawing) {
    // Time stands still while a stroke is being drawn, so a fix can be drawn with care even
    // mid-wave. The time that passed is dropped, not replayed as a burst on release.
    accumulator = 0;
  } else {
    accumulator += elapsed * speed;
    const maxSteps = MAX_SUBSTEPS * speed;
    let steps = 0;
    while (accumulator >= SIM_STEP && steps < maxSteps) {
      sim.step(graph, SIM_STEP);
      accumulator -= SIM_STEP;
      steps++;
    }
    // Drop the backlog rather than spiralling if a frame ran long.
    if (steps === maxSteps) accumulator = 0;
  }

  sim.sync(graph);
  render(ctx, cam, graph, sim, view);
  updateHud();
  requestAnimationFrame(frame);
}

window.addEventListener('resize', resize);
resize();
restore();
startRun();
requestAnimationFrame(frame);

Object.assign(window, { graph, cam, sim });
