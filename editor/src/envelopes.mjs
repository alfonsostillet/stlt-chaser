// Envelopes: Bézier curves of opacity (y) over a step's lifetime (x), both 0..1.
import { newId, numberedName, uniqueName } from './document.mjs';

export const LUT_SIZE = 256;
export const MAX_ENVELOPES = 512;

export function defaultCurvePoints() {
  return [
    { x: 0, y: 1, in: [0, 0], out: [0.35, 0] },
    { x: 1, y: 0, in: [-0.35, 0], out: [0, 0] },
  ];
}

export function createEnvelope(name = 'S Curve', points = defaultCurvePoints()) {
  const envelope = { id: newId('e'), name, points };
  envelope.lut = sampleLut(envelope.points);
  return envelope;
}

export function createEnvelopeLibrary() {
  return { format: 'stilletchaser-envelopes', version: 1, envelopes: [createEnvelope()] };
}

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// Control points of the segment between two anchors; handles are clamped inside
// the segment's x range so the curve stays a function of x.
export function segmentControls(a, b) {
  const span = b.x - a.x;
  const outX = Math.min(Math.max(a.out[0], 0), span);
  const inX = Math.max(Math.min(b.in[0], 0), -span);
  return [
    [a.x, a.y],
    [a.x + outX, a.y + a.out[1]],
    [b.x + inX, b.y + b.in[1]],
    [b.x, b.y],
  ];
}

export function evaluate(points, x) {
  if (points.length === 0) return 0;
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;
  let i = 0;
  while (i < points.length - 2 && x > points[i + 1].x) i += 1;
  const [c0, c1, c2, c3] = segmentControls(points[i], points[i + 1]);
  // x(t) is monotonic with clamped handles, so bisection finds t.
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k += 1) {
    const mid = (lo + hi) / 2;
    if (bezier(c0[0], c1[0], c2[0], c3[0], mid) < x) lo = mid;
    else hi = mid;
  }
  const y = bezier(c0[1], c1[1], c2[1], c3[1], (lo + hi) / 2);
  return Math.max(0, Math.min(1, y));
}

export function sampleLut(points) {
  return Array.from({ length: LUT_SIZE }, (_, i) => Math.round(evaluate(points, i / (LUT_SIZE - 1)) * 10000) / 10000);
}

export function addEnvelope(library, afterIndex) {
  if (library.envelopes.length >= MAX_ENVELOPES) return afterIndex;
  library.envelopes.splice(afterIndex + 1, 0, createEnvelope(numberedName(library.envelopes, 'Envelope')));
  return afterIndex + 1;
}

export function duplicateEnvelope(library, index, toIndex = index + 1) {
  if (library.envelopes.length >= MAX_ENVELOPES) return index;
  const copy = structuredClone(library.envelopes[index]);
  copy.id = newId('e');
  copy.name = uniqueName(library.envelopes, `${copy.name} copy`);
  library.envelopes.splice(toIndex, 0, copy);
  return toIndex;
}

// The library never becomes empty: removing the last envelope resets it to the default curve.
export function removeEnvelope(library, index) {
  if (library.envelopes.length === 1) {
    library.envelopes[0].points = defaultCurvePoints();
    library.envelopes[0].lut = sampleLut(library.envelopes[0].points);
    return 0;
  }
  library.envelopes.splice(index, 1);
  return Math.min(index, library.envelopes.length - 1);
}
