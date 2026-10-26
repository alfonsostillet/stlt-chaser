// Bézier envelope editor: x is time through a step's life, y is opacity.
import { evaluate, sampleLut, segmentControls } from './envelopes.mjs';
import { THEME } from './theme.mjs';

const PAD = 40;
const HIT = 8;
const SNAP = 0.05;

export function createEnvelopeEditor(root, store) {
  root.innerHTML = `
    <div class="toolbar">
      <strong data-field="name"></strong>
      <span>X <input class="num" data-field="x" /></span>
      <span>Y <input class="num" data-field="y" /></span>
      <span>Double-click: add / remove point · Alt: break handles · Shift: one axis · Ctrl: no snapping · Right-click a segment: make linear</span>
    </div>
    <canvas></canvas>`;
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  let selection = new Set();
  let drag = null;
  let band = null;

  const envelope = () => store.state.library.envelopes[store.state.ui.envelopeIndex];
  const size = () => ({ w: canvas.clientWidth - PAD * 2, h: canvas.clientHeight - PAD * 2 });
  const toScreen = (x, y) => [PAD + x * size().w, PAD + (1 - y) * size().h];
  const toCurve = (sx, sy) => [(sx - PAD) / size().w, 1 - (sy - PAD) / size().h];
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function editPoints(change, coalesce) {
    const index = store.state.ui.envelopeIndex;
    store.edit(
      (_doc, library) => {
        const env = library.envelopes[index];
        change(env.points);
        env.points.sort((a, b) => a.x - b.x);
        env.lut = sampleLut(env.points);
      },
      { coalesce },
    );
  }

  // Hit-testing: anchors first, then handles of selected anchors, then the curve.
  function hitTest(sx, sy) {
    const points = envelope().points;
    for (let i = 0; i < points.length; i += 1) {
      const [px, py] = toScreen(points[i].x, points[i].y);
      if (Math.hypot(px - sx, py - sy) < HIT) return { kind: 'anchor', index: i };
    }
    for (const i of selection) {
      const p = points[i];
      if (!p) continue;
      for (const side of ['in', 'out']) {
        const [hx, hy] = toScreen(p.x + p[side][0], p.y + p[side][1]);
        if (Math.hypot(hx - sx, hy - sy) < HIT) return { kind: 'handle', index: i, side };
      }
    }
    const [cx] = toCurve(sx, sy);
    if (cx > 0 && cx < 1) {
      const [, cy] = toScreen(cx, evaluate(points, cx));
      if (Math.abs(cy - sy) < HIT) return { kind: 'curve', x: cx };
    }
    return null;
  }

  const snap = (v, event) => (event.ctrlKey ? v : Math.round(v / SNAP) * SNAP);

  canvas.addEventListener('dblclick', (event) => {
    const hit = hitTest(event.offsetX, event.offsetY);
    if (hit?.kind === 'anchor') {
      const count = envelope().points.length;
      if (hit.index === 0 || hit.index === count - 1) return;
      editPoints((points) => points.splice(hit.index, 1));
      selection = new Set();
    } else if (hit?.kind === 'curve') {
      const x = snap(hit.x, event);
      const y = evaluate(envelope().points, x);
      editPoints((points) => points.push({ x, y, in: [-0.08, 0], out: [0.08, 0] }));
      selection = new Set([envelope().points.findIndex((p) => p.x === x)]);
    }
    draw();
  });

  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const hit = hitTest(event.offsetX, event.offsetY);
    if (hit?.kind !== 'curve') return;
    const points = envelope().points;
    const i = points.findIndex((p, k) => k < points.length - 1 && hit.x >= p.x && hit.x <= points[k + 1].x);
    if (i < 0) return;
    if (!window.confirm('Make this segment linear?')) return;
    editPoints((pts) => {
      pts[i].out = [0, 0];
      pts[i + 1].in = [0, 0];
    });
  });

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    const hit = hitTest(event.offsetX, event.offsetY);
    const key = `env-${Date.now()}`;
    if (hit?.kind === 'anchor') {
      if (!selection.has(hit.index)) selection = new Set([hit.index]);
      const points = envelope().points;
      drag = { kind: 'anchors', key, start: toCurve(event.offsetX, event.offsetY), origin: [...selection].map((i) => ({ i, x: points[i].x, y: points[i].y })) };
    } else if (hit?.kind === 'handle') {
      drag = { kind: 'handle', key, index: hit.index, side: hit.side };
    } else {
      band = { x0: event.offsetX, y0: event.offsetY, x1: event.offsetX, y1: event.offsetY };
    }
    draw();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (band) {
      band.x1 = event.offsetX;
      band.y1 = event.offsetY;
      draw();
      return;
    }
    if (!drag) return;
    const [mx, my] = toCurve(event.offsetX, event.offsetY);
    if (drag.kind === 'anchors') {
      let dx = mx - drag.start[0];
      let dy = my - drag.start[1];
      if (event.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      editPoints((points) => {
        const last = points.length - 1;
        for (const o of drag.origin) {
          const p = points[o.i];
          // The first and last points stay at the start and end of the step.
          if (o.i !== 0 && o.i !== last) {
            const lo = points[o.i - 1].x + 0.001;
            const hi = points[o.i + 1].x - 0.001;
            p.x = Math.max(lo, Math.min(hi, snap(o.x + dx, event)));
          }
          p.y = clamp01(snap(o.y + dy, event));
        }
      }, drag.key);
    } else {
      editPoints((points) => {
        const p = points[drag.index];
        let hx = mx - p.x;
        let hy = my - p.y;
        if (event.shiftKey) Math.abs(hx) > Math.abs(hy) ? (hy = 0) : (hx = 0);
        p[drag.side] = drag.side === 'out' ? [Math.max(0, hx), hy] : [Math.min(0, hx), hy];
        // Handles are linked unless Alt is held: the other one mirrors this one's direction.
        if (!event.altKey) {
          const other = drag.side === 'out' ? 'in' : 'out';
          const length = Math.hypot(...p[other]) || Math.hypot(hx, hy);
          const norm = Math.hypot(hx, hy) || 1;
          p[other] = [(-hx / norm) * length, (-hy / norm) * length];
        }
      }, drag.key);
    }
    draw();
  });

  canvas.addEventListener('pointerup', () => {
    if (band) {
      const minX = Math.min(band.x0, band.x1);
      const maxX = Math.max(band.x0, band.x1);
      const minY = Math.min(band.y0, band.y1);
      const maxY = Math.max(band.y0, band.y1);
      selection = new Set();
      envelope().points.forEach((p, i) => {
        const [sx, sy] = toScreen(p.x, p.y);
        if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) selection.add(i);
      });
      band = null;
    }
    drag = null;
    store.endCoalesce();
    draw();
  });

  root.addEventListener('change', (event) => {
    const field = event.target.dataset.field;
    if ((field !== 'x' && field !== 'y') || selection.size !== 1) return;
    const i = [...selection][0];
    const value = clamp01(parseFloat(event.target.value));
    if (Number.isNaN(value)) return;
    editPoints((points) => {
      const last = points.length - 1;
      if (field === 'y') points[i].y = value;
      else if (i !== 0 && i !== last) points[i].x = Math.max(points[i - 1].x + 0.001, Math.min(points[i + 1].x - 0.001, value));
    });
  });

  function draw() {
    if (root.hidden) return;
    const env = envelope();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    ctx.strokeStyle = THEME.grid;
    ctx.lineWidth = 1;
    for (let v = 0; v <= 1.0001; v += 0.1) {
      const [x0, y0] = toScreen(v, 0);
      const [, y1] = toScreen(v, 1);
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, y0);
      ctx.lineTo(x0 + 0.5, y1);
      ctx.stroke();
      const [hx0, hy] = toScreen(0, v);
      const [hx1] = toScreen(1, v);
      ctx.beginPath();
      ctx.moveTo(hx0, hy + 0.5);
      ctx.lineTo(hx1, hy + 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = THEME.textDim;
    ctx.font = '11px Segoe UI, sans-serif';
    ctx.fillText('start of step', PAD, canvas.clientHeight - 14);
    ctx.fillText('end', PAD + size().w - 20, canvas.clientHeight - 14);
    ctx.fillText('opacity', 6, PAD - 10);

    ctx.strokeStyle = THEME.accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    const points = env.points;
    for (let i = 0; i < points.length - 1; i += 1) {
      const [c0, c1, c2, c3] = segmentControls(points[i], points[i + 1]).map(([x, y]) => toScreen(x, y));
      if (i === 0) ctx.moveTo(...c0);
      ctx.bezierCurveTo(...c1, ...c2, ...c3);
    }
    ctx.stroke();

    points.forEach((p, i) => {
      const [x, y] = toScreen(p.x, p.y);
      if (selection.has(i)) {
        ctx.strokeStyle = THEME.text;
        ctx.lineWidth = 1;
        for (const side of ['in', 'out']) {
          const [hx, hy] = toScreen(p.x + p[side][0], p.y + p[side][1]);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          ctx.fillStyle = THEME.text;
          ctx.beginPath();
          ctx.arc(hx, hy, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.fillStyle = selection.has(i) ? THEME.text : THEME.accent;
      ctx.fillRect(x - 5, y - 5, 10, 10);
    });

    if (band) {
      ctx.strokeStyle = THEME.text;
      ctx.strokeRect(Math.min(band.x0, band.x1) + 0.5, Math.min(band.y0, band.y1) + 0.5, Math.abs(band.x1 - band.x0), Math.abs(band.y1 - band.y0));
    }

    root.querySelector('[data-field="name"]').textContent = env.name;
    const single = selection.size === 1 ? points[[...selection][0]] : null;
    for (const field of ['x', 'y']) {
      const input = root.querySelector(`[data-field="${field}"]`);
      input.disabled = !single;
      if (document.activeElement !== input) input.value = single ? single[field].toFixed(3) : '';
    }
  }

  new ResizeObserver(draw).observe(canvas);
  return {
    render() {
      selection = new Set([...selection].filter((i) => i < envelope().points.length));
      draw();
    },
  };
}
