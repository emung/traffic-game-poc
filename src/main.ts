import { type Vec2, dist } from './geom';
import { RoadGraph, type RoadEdge } from './graph';
import { Camera } from './camera';
import { render, type ViewState } from './render';
import { SAMPLE_SPACING_PX, SNAP_RADIUS, UNDO_LIMIT } from './config';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const cam = new Camera();
const graph = new RoadGraph();

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
      persist();
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
  nodes: document.getElementById('n-nodes')!,
  edges: document.getElementById('n-edges')!,
  junctions: document.getElementById('n-junctions')!,
  deadends: document.getElementById('n-deadends')!,
  length: document.getElementById('n-length')!,
};

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
}

function frame(): void {
  render(ctx, cam, graph, view);
  updateHud();
  requestAnimationFrame(frame);
}

window.addEventListener('resize', resize);
resize();
restore();
frame();

Object.assign(window, { graph, cam });
