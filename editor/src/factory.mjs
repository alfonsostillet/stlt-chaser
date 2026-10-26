// The Factory: builds a sequence from a grid laid over the slice centres.
import { bounds, centroid } from './geometry.mjs';

export const DIRECTIONS = ['Horizontal', 'Vertical', 'Row', 'Column', 'Random'];

export function defaultFactorySettings() {
  return { direction: 'Horizontal', flipX: false, flipY: false, block: 1, modulo: 0, mirrorX: false, mirrorY: false, shuffle: 0, grid: null };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

// Grid lines halfway between distinct slice centres. Hand-placed stages are rarely pixel
// aligned, so centres closer than half a typical slice count as the same column or row.
export function autoGrid(slices, compWidth, compHeight) {
  const centres = slices.map((s) => centroid(s.points));
  const extents = slices.map((s) => bounds(s.points));
  const split = (values, tolerance) => {
    const sorted = [...values].sort((a, b) => a - b);
    const lines = [];
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] - sorted[i - 1] > tolerance) lines.push((sorted[i] + sorted[i - 1]) / 2);
    }
    return lines;
  };
  const tolX = Math.max(compWidth * 0.005, 0.5 * median(extents.map((b) => b.maxX - b.minX)));
  const tolY = Math.max(compHeight * 0.005, 0.5 * median(extents.map((b) => b.maxY - b.minY)));
  return { xs: split(centres.map((c) => c[0]), tolX), ys: split(centres.map((c) => c[1]), tolY) };
}

function cellOf(grid, slice) {
  const [x, y] = centroid(slice.points);
  return { col: grid.xs.filter((line) => line < x).length, row: grid.ys.filter((line) => line < y).length };
}

// Deterministic shuffle so the same settings always give the same sequence.
function seededShuffle(items, seed) {
  const result = [...items];
  let state = (seed * 2654435761) >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Units are what one block step lights before Block, Modulo and Mirror are applied:
// a single grid cell for Horizontal/Vertical/Random, a whole row or column otherwise.
function buildUnits(cells, settings, cols, rows) {
  const colOrder = [...Array(cols).keys()];
  const rowOrder = [...Array(rows).keys()];
  if (settings.flipX) colOrder.reverse();
  if (settings.flipY) rowOrder.reverse();
  const at = (col, row) => cells.filter((c) => c.col === col && c.row === row);
  const units = [];
  switch (settings.direction) {
    case 'Vertical':
      for (const col of colOrder) for (const row of rowOrder) units.push(at(col, row));
      break;
    case 'Row':
      for (const row of rowOrder) units.push(cells.filter((c) => c.row === row));
      break;
    case 'Column':
      for (const col of colOrder) units.push(cells.filter((c) => c.col === col));
      break;
    case 'Random': {
      const all = [];
      for (const row of rowOrder) for (const col of colOrder) all.push(at(col, row));
      units.push(...seededShuffle(all.filter((u) => u.length), 1 + (settings.shuffle || 0)));
      break;
    }
    case 'Horizontal':
    default:
      for (const row of rowOrder) for (const col of colOrder) units.push(at(col, row));
  }
  return units.filter((u) => u.length);
}

/** @returns {{steps: string[][], grid: {xs:number[], ys:number[]}}} */
export function generate(slices, settings, compWidth, compHeight) {
  const grid = settings.grid ?? autoGrid(slices, compWidth, compHeight);
  const cols = grid.xs.length + 1;
  const rows = grid.ys.length + 1;
  const cells = slices.map((slice) => ({ id: slice.id, ...cellOf(grid, slice) }));
  const units = buildUnits(cells, settings, cols, rows);
  if (units.length === 0) return { steps: [[]], grid };

  const block = Math.max(1, Math.min(settings.block || 1, units.length));
  let steps = [];
  for (let i = 0; i < units.length; i += block) steps.push(units.slice(i, i + block).flat());

  if (settings.modulo > 0 && settings.modulo < steps.length) {
    const folded = Array.from({ length: settings.modulo }, () => []);
    steps.forEach((step, i) => folded[i % settings.modulo].push(...step));
    steps = folded;
  }

  const mirrored = (cell) => {
    const result = [cell];
    if (settings.mirrorX) result.push({ col: cols - 1 - cell.col, row: cell.row });
    if (settings.mirrorY) result.push({ col: cell.col, row: rows - 1 - cell.row });
    if (settings.mirrorX && settings.mirrorY) result.push({ col: cols - 1 - cell.col, row: rows - 1 - cell.row });
    return result;
  };
  let ids = steps.map((step) => {
    const lit = new Set();
    for (const cell of step) {
      for (const target of mirrored(cell)) {
        for (const c of cells) if (c.col === target.col && c.row === target.row) lit.add(c.id);
      }
    }
    return [...lit];
  });

  if (settings.shuffle && settings.direction !== 'Random') ids = seededShuffle(ids, settings.shuffle);
  return { steps: ids, grid };
}

export function maxBlock(slices, settings, compWidth, compHeight) {
  return Math.max(1, generate(slices, { ...settings, block: 1, modulo: 0, shuffle: 0 }, compWidth, compHeight).steps.length);
}
