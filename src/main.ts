import { type Vec2, dist } from './geom';
import { JUNCTION_CONTROLS, RoadGraph, type JunctionControl, type RoadEdge, type RoadNode } from './graph';
import { Camera } from './camera';
import { render, type ViewState } from './render';
import { TrafficSim } from './traffic';
import {
  MAX_SUBSTEPS,
  SAMPLE_SPACING_PX,
  SIM_STEP,
  SNAP_RADIUS,
  UNDO_LIMIT,
} from './config';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const cam = new Camera();
const graph = new RoadGraph();
const sim = new TrafficSim();

type Tool = 'draw' | 'erase' | 'control';
let tool: Tool = 'draw';
let spaceHeld = false;
let panning = false;
let drawing = false;
let stroke: Vec2[] = [];
let lastScreen: Vec2 = { x: 0, y: 0 };
/** Simulated seconds per real second. */
let speed = 1;

const view: ViewState = { liveStroke: null, snap: null, hoverEdge: null, hoverNode: null, debug: false };
const undoStack: string[] = [];

const STORAGE_KEY = 'traffic-game/graph';

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

/** A junction the control tool can act on: a node where at least three roads meet. */
function junctionUnder(p: Vec2): RoadNode | null {
  const node = graph.nodeNear(p, SNAP_RADIUS);
  return node && node.edges.length >= 3 ? node : null;
}

/** none -> signal -> priority -> roundabout -> none */
function nextControl(current: JunctionControl | undefined): JunctionControl | null {
  if (!current) return JUNCTION_CONTROLS[0];
  return JUNCTION_CONTROLS[JUNCTION_CONTROLS.indexOf(current) + 1] ?? null;
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
  if (tool === 'control') {
    const node = junctionUnder(world);
    if (node) {
      if (e.shiftKey && node.control === 'priority') {
        // Rotate which road is major; the network must be current to know the candidates.
        sim.sync(graph);
        const bearing = sim.network.nextMajorBearing(node.id);
        if (bearing !== null) {
          pushUndo();
          graph.setMajorBearing(node.id, bearing);
          persist();
        }
      } else {
        pushUndo();
        graph.setControl(node.id, nextControl(node.control));
        persist();
      }
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
  view.hoverNode = tool === 'control' ? junctionUnder(world) : null;
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
  view.hoverNode = null;
  canvas.classList.toggle('erasing', tool === 'erase');
  canvas.classList.toggle('controlling', tool === 'control');
  for (const btn of buttons('draw')) btn.classList.toggle('active', tool === 'draw');
  for (const btn of buttons('erase')) btn.classList.toggle('active', tool === 'erase');
  for (const btn of buttons('control')) btn.classList.toggle('active', tool === 'control');
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
  failureShown = false;
  setRunning(true);
}

/**
 * Undo rewinds the roads, not the run. Traffic on roads that survive keeps going, which is what
 * makes fixing a bad stroke mid-run cheap; restarting the run is a separate, explicit action.
 */
function undo(): void {
  const snapshot = undoStack.pop();
  if (!snapshot) return;
  graph.loadJSON(snapshot);
  view.hoverEdge = null;
  view.hoverNode = null;
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
  control: () => setTool('control'),
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
    case 't':
      setTool('control');
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
    el.bannerSub.textContent = `gridlocked after ${Math.round(sim.time)} s · journeys took ${t.delayRatio.toFixed(1)}x too long`;
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
    // mid-run. The time that passed is dropped, not replayed as a burst on release.
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
