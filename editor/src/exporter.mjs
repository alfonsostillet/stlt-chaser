// Input / output map images: every slice in its own colour, with a test pattern
// (checkerboard, diagonals, circle, corner markers) and its name, position and size.
import { bounds, centroid } from './geometry.mjs';

export const FONTS = ['Arial', 'Segoe UI', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Courier New', 'Impact'];
export const POSITIONS = ['Top Left', 'Top Right', 'Bottom Left', 'Bottom Right'];

export function defaultExportOptions() {
  return {
    kind: 'input',
    font: 'Arial',
    fontSize: 45,
    position: 'Top Right',
    showScreenName: false,
    showResolution: true,
    showProjectInfo: false,
    projectInfo: 'Example',
    showAspectRatio: false,
    showBorder: false,
    transparent: false,
  };
}

function sliceColor(index, count) {
  const hue = (index * 360) / Math.max(1, count);
  return { base: `hsl(${hue}, 100%, 50%)`, dark: `hsl(${hue}, 100%, 25%)` };
}

function gcdRatio(w, h) {
  const r = w / h;
  return r >= 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`;
}

function tracePath(ctx, points) {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

// A label as Chaser draws it: white text on a black box, then details black on white.
function drawLabel(ctx, x, y, lines, font, size) {
  let top = y - (lines.length * size * 1.25) / 2;
  lines.forEach((line, i) => {
    const lineSize = i === 0 ? size : size * 0.8;
    ctx.font = `${lineSize}px "${font}"`;
    const width = ctx.measureText(line).width + lineSize * 0.5;
    const height = lineSize * 1.2;
    ctx.fillStyle = i === 0 ? '#000000' : '#ffffff';
    ctx.fillRect(x - width / 2, top, width, height);
    ctx.fillStyle = i === 0 ? '#ffffff' : '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(line, x, top + height / 2 + lineSize * 0.05);
    top += height + lineSize * 0.05;
  });
}

function drawSlice(ctx, points, index, count, labelLines, options) {
  const { base, dark } = sliceColor(index, count);
  const b = bounds(points);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;

  ctx.save();
  tracePath(ctx, points);
  ctx.clip();
  ctx.fillStyle = base;
  ctx.fillRect(b.minX, b.minY, w, h);
  ctx.fillStyle = dark;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      if ((row + col) % 2 === 1) ctx.fillRect(b.minX + (col * w) / 3, b.minY + (row * h) / 3, w / 3 + 0.5, h / 3 + 0.5);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = Math.max(1, Math.min(w, h) / 250);
  ctx.beginPath();
  ctx.moveTo(b.minX, b.minY);
  ctx.lineTo(b.maxX, b.maxY);
  ctx.moveTo(b.maxX, b.minY);
  ctx.lineTo(b.minX, b.maxY);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(b.minX + w / 2, b.minY + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  tracePath(ctx, points);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, Math.min(w, h) / 200);
  ctx.stroke();
  ctx.fillStyle = '#ff2020';
  const dot = Math.max(3, Math.min(w, h) / 40);
  for (const [x, y] of points) {
    ctx.beginPath();
    ctx.arc(x, y, dot, 0, Math.PI * 2);
    ctx.fill();
  }

  const size = Math.max(9, Math.min(options.fontSize * 0.75, w * 0.14, h * 0.1));
  const [cx, cy] = centroid(points);
  drawLabel(ctx, cx, cy, labelLines, options.font, size);
}

function drawTitle(ctx, width, height, title, options) {
  const lines = [title];
  if (options.showResolution) lines.push(`${width} x ${height}`);
  if (options.showProjectInfo && options.projectInfo) lines.push(options.projectInfo);
  const size = options.fontSize;
  const pad = size * 0.3;
  ctx.textBaseline = 'middle';
  const boxes = lines.map((line, i) => {
    const lineSize = i === 0 ? size * 1.4 : size;
    ctx.font = `${i === 0 ? 'bold ' : ''}${lineSize}px "${options.font}"`;
    return { line, lineSize, w: ctx.measureText(line).width + pad * 2, h: lineSize * 1.25 };
  });
  const right = options.position.endsWith('Right');
  const bottom = options.position.startsWith('Bottom');
  let y = bottom ? height - boxes.reduce((sum, box) => sum + box.h, 0) : 0;
  boxes.forEach((box, i) => {
    const x = right ? width - box.w : 0;
    ctx.fillStyle = i === 0 ? '#ffffff' : '#000000';
    ctx.fillRect(x, y, box.w, box.h);
    ctx.fillStyle = i === 0 ? '#000000' : '#ffffff';
    ctx.font = `${i === 0 ? 'bold ' : ''}${box.lineSize}px "${options.font}"`;
    ctx.textAlign = 'left';
    ctx.fillText(box.line, x + pad, y + box.h / 2);
    y += box.h;
  });
}

function sliceLines(slice, points, screenName, options) {
  const b = bounds(points);
  const w = Math.round(b.maxX - b.minX);
  const h = Math.round(b.maxY - b.minY);
  const lines = [slice.name || slice.id, `${Math.round(b.minX)}, ${Math.round(b.minY)} // ${w} x ${h}`];
  if (options.showAspectRatio) lines.push(gcdRatio(w, h));
  if (options.showScreenName && screenName) lines.push(screenName);
  return lines;
}

function newCanvas(width, height, options) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!options.transparent) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return { canvas, ctx };
}

function sourceTitle(doc) {
  const file = (doc.source.path || doc.name).split(/[\\/]/).pop();
  return file.replace(/\.xml$/i, '');
}

// The composition as Arena sees it: each slice's input area.
export function renderInputMap(doc, options) {
  const { compWidth, compHeight } = doc.source;
  const { canvas, ctx } = newCanvas(compWidth, compHeight, options);
  const screenName = (slice) => doc.screens.find((s) => s.id === slice.screen)?.name;
  doc.slices.forEach((slice, i) => drawSlice(ctx, slice.points, i, doc.slices.length, sliceLines(slice, slice.points, screenName(slice), options), options));
  if (options.showBorder) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  }
  drawTitle(ctx, compWidth, compHeight, sourceTitle(doc), options);
  return canvas;
}

// Each screen's output, side by side, with the slices where Arena sends them.
export function renderOutputMap(doc, options) {
  const gap = 40;
  const screens = doc.screens.map((screen) => {
    const slices = doc.slices.filter((s) => s.screen === screen.id && s.outPoints?.length >= 3);
    const b = slices.length ? bounds(slices.flatMap((s) => s.outPoints)) : { maxX: 1, maxY: 1 };
    return { screen, slices, width: screen.width || Math.ceil(b.maxX), height: screen.height || Math.ceil(b.maxY) };
  });
  const width = screens.reduce((sum, s) => sum + s.width, 0) + gap * Math.max(0, screens.length - 1);
  const height = Math.max(1, ...screens.map((s) => s.height));
  const { canvas, ctx } = newCanvas(width, height, options);
  let x = 0;
  for (const entry of screens) {
    ctx.save();
    ctx.translate(x, 0);
    for (const slice of entry.slices) {
      const index = doc.slices.indexOf(slice);
      drawSlice(ctx, slice.outPoints, index, doc.slices.length, sliceLines(slice, slice.outPoints, entry.screen.name, options), options);
    }
    if (options.showBorder) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, entry.width - 2, entry.height - 2);
    }
    drawTitle(ctx, entry.width, entry.height, options.showScreenName ? entry.screen.name : sourceTitle(doc), options);
    ctx.restore();
    x += entry.width + gap;
  }
  return canvas;
}

// Slices whose outputs sit on top of each other, so the output map cannot show them apart.
export function overlappingOutputs(doc) {
  const groups = new Map();
  for (const slice of doc.slices) {
    if (!slice.outPoints?.length) continue;
    const key = `${slice.screen}:${slice.outPoints.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(';')}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.values()].filter((n) => n > 1).reduce((sum, n) => sum + n, 0);
}

export function canvasToBase64(canvas) {
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}
