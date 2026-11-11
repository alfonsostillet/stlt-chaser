// The stage canvas: draws the slices, toggles them in the selected step, pans and zooms.
// With the Factory open it shows the step each slice lights in, and a click moves a slice there.
import { bounds, boxesOverlap, centroid, pointInPolygon } from './geometry.mjs';
import { isVisibleInView, setVisibleInView, toggleSliceInStep, setSliceInStep } from './document.mjs';
import { firstSteps, isPatternFactory } from './factory.mjs';

import { THEME } from './theme.mjs';

// Read when a canvas is made, after the host's palette is in place.
const colors = () => ({
  slice: THEME.sliceOff,
  hover: THEME.sliceHover,
  on: THEME.accent,
  outline: THEME.outline,
  label: THEME.textDim,
  labelOn: THEME.onAccent,
  band: THEME.accentWash,
  bandLine: THEME.accent,
  badge: 'rgba(0, 0, 0, 0.72)',
  badgeText: '#ffffff',
});
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 20;

export function createCanvas(canvas, store, { onFactoryPick }) {
  const COLORS = colors();
  const ctx = canvas.getContext('2d');
  const view = { zoom: 1, panX: 0, panY: 0, fitted: false };
  let hoverId = null;
  let drag = null;
  let spaceDown = false;
  let frameRequested = false;

  const doc = () => store.state.doc;
  const ui = () => store.state.ui;
  // The Factory panel is open on a sequence it made: numbers on the slices, clicks move them.
  const factoryOpen = () => ui().panel === 'factory' && isPatternFactory(store.currentSequence.factory);

  function visibleSlices() {
    const v = store.currentView;
    return doc().slices.filter((s) => isVisibleInView(v, s.id));
  }

  function displayedStep() {
    const sequence = store.currentSequence;
    const index = ui().playStep ?? ui().stepIndex;
    return new Set(sequence.steps[index] ?? []);
  }

  const toWorld = (x, y) => [(x - view.panX) / view.zoom, (y - view.panY) / view.zoom];
  const toScreen = (x, y) => [x * view.zoom + view.panX, y * view.zoom + view.panY];

  function sliceAt(x, y) {
    const [wx, wy] = toWorld(x, y);
    const slices = visibleSlices();
    // Later slices are drawn on top, so test them first.
    for (let i = slices.length - 1; i >= 0; i -= 1) if (pointInPolygon(wx, wy, slices[i].points)) return slices[i];
    return null;
  }

  function fit() {
    const slices = visibleSlices().length ? visibleSlices() : doc().slices;
    const rect = canvas.getBoundingClientRect();
    if (!slices.length || rect.width === 0) return;
    const b = bounds(slices.flatMap((s) => s.points));
    const margin = 40;
    const zoom = Math.min((rect.width - margin * 2) / (b.maxX - b.minX || 1), (rect.height - margin * 2) / (b.maxY - b.minY || 1));
    view.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    view.panX = rect.width / 2 - ((b.minX + b.maxX) / 2) * view.zoom;
    view.panY = rect.height / 2 - ((b.minY + b.maxY) / 2) * view.zoom;
    view.fitted = true;
    redraw();
    store.setUi({});
  }

  function zoomAt(factor, x, y) {
    const [wx, wy] = toWorld(x, y);
    view.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * factor));
    view.panX = x - wx * view.zoom;
    view.panY = y - wy * view.zoom;
    redraw();
    store.setUi({});
  }

  function setZoomPercent(percent) {
    const rect = canvas.getBoundingClientRect();
    zoomAt(Math.max(MIN_ZOOM, percent / 100) / view.zoom, rect.width / 2, rect.height / 2);
  }

  function redraw() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(draw);
  }

  function draw() {
    frameRequested = false;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    if (!view.fitted && rect.width > 0) {
      fit();
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const lit = displayedStep();
    ctx.save();
    ctx.translate(view.panX, view.panY);
    ctx.scale(view.zoom, view.zoom);
    for (const slice of visibleSlices()) {
      const on = lit.has(slice.id);
      ctx.beginPath();
      slice.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = on ? COLORS.on : slice.id === hoverId ? COLORS.hover : COLORS.slice;
      ctx.fill();
      // Dashed outlines, like the input rectangles in Arena's Advanced Output.
      ctx.lineWidth = 1 / view.zoom;
      ctx.setLineDash(on ? [] : [4 / view.zoom, 3 / view.zoom]);
      ctx.strokeStyle = on ? COLORS.on : COLORS.outline;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    drawLabels(lit);
    if (factoryOpen()) drawStepNumbers();
    if (drag?.type === 'band') {
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      ctx.fillStyle = COLORS.band;
      ctx.strokeStyle = COLORS.bandLine;
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    }
    canvas.style.cursor = cursorFor();
  }

  function drawLabels(lit) {
    ctx.font = '11px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const slice of visibleSlices()) {
      const b = bounds(slice.points);
      const width = (b.maxX - b.minX) * view.zoom;
      const height = (b.maxY - b.minY) * view.zoom;
      if (width < 50 || height < 18 || !slice.name) continue;
      ctx.fillStyle = lit.has(slice.id) ? COLORS.labelOn : COLORS.label;
      const [cx, cy] = toScreen(...centroid(slice.points));
      ctx.fillText(slice.name, cx, cy, width - 6);
    }
  }

  // The step each slice first lights in, on a dark disc at its centre.
  function drawStepNumbers() {
    const first = firstSteps(store.currentSequence.steps);
    ctx.font = '600 11px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const slice of visibleSlices()) {
      if (!first.has(slice.id)) continue;
      const text = String(first.get(slice.id) + 1);
      const [x, y] = toScreen(...centroid(slice.points));
      const r = Math.max(9, ctx.measureText(text).width / 2 + 5);
      ctx.fillStyle = COLORS.badge;
      ctx.beginPath();
      ctx.arc(x, y + (slice.name ? 14 : 0), r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.badgeText;
      ctx.fillText(text, x, y + (slice.name ? 14 : 0) + 0.5);
    }
  }

  function cursorFor() {
    if (drag?.type === 'pan') return 'grabbing';
    if (spaceDown || ui().tool === 'hand') return 'grab';
    return hoverId ? 'pointer' : 'crosshair';
  }

  // ---- Pointer handling ----

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    const x = event.offsetX;
    const y = event.offsetY;
    if (event.button === 1 || spaceDown || ui().tool === 'hand') {
      drag = { type: 'pan', x, y, panX: view.panX, panY: view.panY };
      redraw();
      return;
    }
    if (event.button !== 0) return;

    const slice = sliceAt(x, y);
    if (slice && factoryOpen() && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      onFactoryPick(slice.id);
      return;
    }
    if (slice && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      const key = `snake-${Date.now()}`;
      drag = { type: 'snake', visited: new Set([slice.id]), key };
      store.edit((d) => toggleSliceInStep(d.sequences[ui().sequenceIndex], ui().stepIndex, slice.id), { coalesce: key });
      return;
    }
    drag = { type: 'band', x0: x, y0: y, x1: x, y1: y };
  });

  canvas.addEventListener('pointermove', (event) => {
    const x = event.offsetX;
    const y = event.offsetY;
    if (!drag) {
      const nextHover = sliceAt(x, y)?.id ?? null;
      if (nextHover !== hoverId) {
        hoverId = nextHover;
        redraw();
      }
      return;
    }
    switch (drag.type) {
      case 'pan':
        view.panX = drag.panX + (x - drag.x);
        view.panY = drag.panY + (y - drag.y);
        redraw();
        break;
      case 'snake': {
        const slice = sliceAt(x, y);
        if (slice && !drag.visited.has(slice.id)) {
          drag.visited.add(slice.id);
          store.edit((d) => toggleSliceInStep(d.sequences[ui().sequenceIndex], ui().stepIndex, slice.id), { coalesce: drag.key });
        }
        break;
      }
      case 'band':
        drag.x1 = x;
        drag.y1 = y;
        redraw();
        break;
    }
  });

  canvas.addEventListener('pointerup', (event) => {
    if (drag?.type === 'band') applyBand(event);
    if (drag?.type === 'snake') store.endCoalesce();
    drag = null;
    redraw();
  });

  function applyBand(event) {
    const [ax, ay] = toWorld(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1));
    const [bx, by] = toWorld(Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1));
    const box = { minX: ax, minY: ay, maxX: bx, maxY: by };
    const ids = visibleSlices().filter((s) => boxesOverlap(box, bounds(s.points))).map((s) => s.id);
    if (!ids.length) return;
    const { sequenceIndex, stepIndex, viewIndex } = ui();
    store.edit((d) => {
      const sequence = d.sequences[sequenceIndex];
      for (const id of ids) {
        if (event.altKey) setVisibleInView(d.views[viewIndex], id, false);
        else if (event.shiftKey) setSliceInStep(sequence, stepIndex, id, true);
        else if (event.ctrlKey) setSliceInStep(sequence, stepIndex, id, false);
        else toggleSliceInStep(sequence, stepIndex, id);
      }
    });
  }

  canvas.addEventListener('pointerleave', () => {
    if (!drag && hoverId) {
      hoverId = null;
      redraw();
    }
  });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomAt(Math.exp(-event.deltaY * 0.0015), event.offsetX, event.offsetY);
  }, { passive: false });

  window.addEventListener('keydown', (event) => {
    if (event.target.closest?.('input, select, textarea')) return;
    if (event.code === 'Space' && !spaceDown) {
      spaceDown = true;
      redraw();
      event.preventDefault();
    }
    if (event.ctrlKey && (event.key === '+' || event.key === '=')) zoomAt(1.25, canvas.clientWidth / 2, canvas.clientHeight / 2);
    if (event.ctrlKey && event.key === '-') zoomAt(0.8, canvas.clientWidth / 2, canvas.clientHeight / 2);
  });
  window.addEventListener('keyup', (event) => {
    if (event.code === 'Space') {
      spaceDown = false;
      redraw();
    }
  });
  new ResizeObserver(redraw).observe(canvas);

  return {
    redraw,
    fit,
    setZoomPercent,
    get zoomPercent() {
      return Math.round(view.zoom * 100);
    },
    refit() {
      view.fitted = false;
      redraw();
    },
  };
}
