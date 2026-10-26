// The step sequencer along the bottom of the window.
import {
  addSequence,
  removeSequence,
  setStepCount,
  repeatFill,
  pingPongFill,
  clearSequence,
  copyStep,
  multiCopyStep,
} from './document.mjs';

const RATES = [
  { label: '1/4', beats: 1 },
  { label: '1/8', beats: 0.5 },
  { label: '1/16', beats: 0.25 },
];
const HOLD_FOR_MULTI_MS = 500;

// Drawn icons: the Unicode media symbols turn into colour emoji on some systems.
const icon = (path) => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
const ICONS = {
  previous: icon('M3 3h2v10H3zM14 3v10L6 8z'),
  next: icon('M11 3h2v10h-2zM2 3v10l8-5z'),
  play: icon('M4 2.5v11L13.5 8z'),
  stop: icon('M3.5 3.5h9v9h-9z'),
};

export function createSequencer(root, store) {
  root.innerHTML = `
    <div class="transport">
      <button class="round small" data-act="prev-seq" title="Previous sequence (Up)">${ICONS.previous}</button>
      <button class="round big" data-act="play" title="Play / stop (Enter)">${ICONS.play}</button>
      <button class="round small" data-act="next-seq" title="Next sequence (Down)">${ICONS.next}</button>
      <input class="seq-number" data-field="seq-number" title="Jump to sequence" />
      <div class="seq-name"><input data-field="seq-name" title="Sequence name" /></div>
    </div>
    <div class="count">
      <button class="round small" data-act="add-step" title="Add a step (Alt+Right)">+</button>
      <input data-field="step-count" title="Number of steps (1-1024)" />
      <button class="round small" data-act="remove-step" title="Remove a step (Alt+Left)">&minus;</button>
    </div>
    <div class="fills">
      <button data-act="repeat" title="Repeat the filled steps over the whole sequence">&#x2192;</button>
      <button data-act="pingpong" title="Repeat the filled steps back and forth">&#x2194;</button>
      <button data-act="clear" title="Clear the sequence">&#x2716;</button>
    </div>
    <div class="tempo">
      <label>BPM <input class="num" data-field="bpm" /></label>
      <select data-field="rate">${RATES.map((r, i) => `<option value="${i}">${r.label}</option>`).join('')}</select>
    </div>
    <div class="steps-area">
      <svg class="links" aria-hidden="true"></svg>
      <div class="steps"></div>
    </div>`;

  const $ = (selector) => root.querySelector(selector);
  const stepsEl = $('.steps');
  const linksEl = $('.links');
  let playTimer = null;
  let stepDrag = null;

  const ui = () => store.state.ui;
  const sequence = () => store.currentSequence;

  function selectSequence(index) {
    const count = store.state.doc.sequences.length;
    store.setUi({ sequenceIndex: (index + count) % count, playStep: ui().playing ? 0 : null });
  }

  function changeStepCount(count) {
    const index = ui().sequenceIndex;
    store.edit((doc) => setStepCount(doc.sequences[index], count));
  }

  function editSequence(change) {
    const index = ui().sequenceIndex;
    store.edit((doc) => change(doc.sequences[index]));
  }

  // ---- Playback ----

  function stepSeconds() {
    const prefs = store.state.prefs;
    return (60 / Math.max(1, prefs.bpm || 120)) * RATES[prefs.rate ?? 0].beats;
  }

  function tick() {
    const length = sequence().steps.length;
    const next = ui().playStep === null ? 0 : (ui().playStep + 1) % length;
    store.setUi({ playStep: next });
    playTimer = setTimeout(tick, stepSeconds() * 1000);
  }

  function togglePlay() {
    if (ui().playing) {
      clearTimeout(playTimer);
      store.setUi({ playing: false, playStep: null });
    } else {
      store.setUi({ playing: true, playStep: null });
      tick();
    }
  }

  // ---- Buttons and fields ----

  root.addEventListener('click', (event) => {
    const act = event.target.closest('[data-act]')?.dataset.act;
    switch (act) {
      case 'prev-seq': return selectSequence(ui().sequenceIndex - 1);
      case 'next-seq': return selectSequence(ui().sequenceIndex + 1);
      case 'play': return togglePlay();
      case 'add-step': return changeStepCount(sequence().steps.length + 1);
      case 'remove-step': return changeStepCount(sequence().steps.length - 1);
      case 'repeat': return editSequence(repeatFill);
      case 'pingpong': return editSequence(pingPongFill);
      case 'clear': return editSequence(clearSequence);
    }
  });

  root.addEventListener('change', (event) => {
    const field = event.target.dataset.field;
    const value = event.target.value;
    if (field === 'seq-number') {
      const n = parseInt(value, 10);
      if (n >= 1 && n <= store.state.doc.sequences.length) selectSequence(n - 1);
      render();
    }
    if (field === 'step-count') {
      const n = parseInt(value, 10);
      if (n > 0) changeStepCount(n);
      render();
    }
    if (field === 'bpm') store.savePrefs({ bpm: Math.max(20, Math.min(400, parseFloat(value) || 120)) });
    if (field === 'rate') store.savePrefs({ rate: parseInt(value, 10) });
    if (field === 'seq-name') store.endCoalesce();
  });

  root.addEventListener('input', (event) => {
    if (event.target.dataset.field !== 'seq-name') return;
    const index = ui().sequenceIndex;
    const name = event.target.value;
    store.edit((doc) => (doc.sequences[index].name = name), { coalesce: `rename-seq-${index}` });
  });

  // ---- Steps: select, drag to copy, drag-and-hold to copy every n-th ----

  stepsEl.addEventListener('pointerdown', (event) => {
    const button = event.target.closest('.step');
    if (!button || event.button !== 0) return;
    const index = Number(button.dataset.index);
    stepDrag = { from: index, target: index, multi: false, holdTimer: null };
    store.setUi({ stepIndex: index });
  });

  stepsEl.addEventListener('pointerover', (event) => {
    if (!stepDrag) return;
    const button = event.target.closest('.step');
    if (!button) return;
    clearTimeout(stepDrag.holdTimer);
    stepDrag.target = Number(button.dataset.index);
    stepDrag.multi = false;
    if (stepDrag.target !== stepDrag.from) {
      stepDrag.holdTimer = setTimeout(() => {
        stepDrag.multi = true;
        markDragTargets();
      }, HOLD_FOR_MULTI_MS);
    }
    markDragTargets();
  });

  window.addEventListener('pointerup', () => {
    if (!stepDrag) return;
    clearTimeout(stepDrag.holdTimer);
    const { from, target, multi } = stepDrag;
    stepDrag = null;
    if (target !== from) {
      editSequence((seq) => {
        copyStep(seq, from, target);
        if (multi && target > from) multiCopyStep(seq, from, target - from);
      });
      store.setUi({ stepIndex: target });
    }
    markDragTargets();
  });

  // Steps that receive a copy if the drag ends now.
  function dragTargets() {
    if (!stepDrag || stepDrag.target === stepDrag.from) return [];
    const { from, target, multi } = stepDrag;
    const interval = target - from;
    if (!multi || interval <= 0) return [target];
    const targets = [];
    for (let i = target; i < stepsEl.children.length; i += interval) targets.push(i);
    return targets;
  }

  function markDragTargets() {
    const targets = new Set(dragTargets());
    for (const button of stepsEl.children) {
      const index = Number(button.dataset.index);
      button.classList.toggle('drop-target', stepDrag !== null && index === stepDrag?.target && targets.has(index));
      button.classList.toggle('multi-target', targets.has(index) && index !== stepDrag?.target);
    }
    drawLinks();
  }

  // Right-angled lines from the dragged step up to a rail and down into every step it copies to.
  function drawLinks() {
    const targets = dragTargets();
    if (!targets.length) {
      linksEl.innerHTML = '';
      return;
    }
    const area = linksEl.getBoundingClientRect();
    const anchor = (index) => {
      const rect = stepsEl.children[index].getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2 - area.left) + 0.5, y: Math.round(rect.top - area.top) };
    };
    const source = anchor(stepDrag.from);
    const ends = targets.map(anchor);
    const rail = Math.max(4, source.y - 14);
    const xs = [source.x, ...ends.map((e) => e.x)];
    const path = [`M${source.x},${source.y} V${rail}`, `M${Math.min(...xs)},${rail} H${Math.max(...xs)}`, ...ends.map((e) => `M${e.x},${rail} V${e.y}`)].join(' ');
    const dot = (p) => `<rect x="${p.x - 3.5}" y="${p.y - 3.5}" width="7" height="7" />`;
    linksEl.innerHTML = `<path d="${path}" />${[source, ...ends].map(dot).join('')}`;
  }

  stepsEl.addEventListener('scroll', () => stepDrag && drawLinks());

  // ---- Keyboard ----

  window.addEventListener('keydown', (event) => {
    if (event.target.closest?.('input, select, textarea') || ui().mode !== 'canvas') return;
    const length = sequence().steps.length;
    if (event.key === 'ArrowRight' && event.altKey) changeStepCount(length + 1);
    else if (event.key === 'ArrowLeft' && event.altKey) changeStepCount(length - 1);
    else if (event.key === 'ArrowRight') store.setUi({ stepIndex: (ui().stepIndex + 1) % length });
    else if (event.key === 'ArrowLeft') store.setUi({ stepIndex: (ui().stepIndex - 1 + length) % length });
    else if (event.key === 'ArrowDown' && event.altKey) {
      const index = ui().sequenceIndex;
      let added = index;
      store.edit((doc) => (added = addSequence(doc, index)));
      store.setUi({ sequenceIndex: added });
    } else if (event.key === 'ArrowUp' && event.altKey) {
      const index = ui().sequenceIndex;
      let next = index;
      store.edit((doc) => (next = removeSequence(doc, index)));
      store.setUi({ sequenceIndex: next });
    } else if (event.key === 'ArrowDown') selectSequence(ui().sequenceIndex + 1);
    else if (event.key === 'ArrowUp') selectSequence(ui().sequenceIndex - 1);
    else if (event.key === 'Enter') togglePlay();
    else return;
    event.preventDefault();
  });

  // ---- Rendering ----

  function setField(name, value) {
    const input = $(`[data-field="${name}"]`);
    if (document.activeElement !== input) input.value = value;
  }

  function render() {
    const seq = sequence();
    const { sequenceIndex, stepIndex, playStep, playing } = ui();
    setField('seq-number', sequenceIndex + 1);
    setField('seq-name', seq.name);
    setField('step-count', seq.steps.length);
    setField('bpm', store.state.prefs.bpm ?? 120);
    setField('rate', store.state.prefs.rate ?? 0);
    $('[data-act="play"]').innerHTML = playing ? ICONS.stop : ICONS.play;

    if (stepsEl.children.length !== seq.steps.length) {
      stepsEl.innerHTML = seq.steps.map((_, i) => `<button class="step" data-index="${i}">${i + 1}</button>`).join('');
    }
    seq.steps.forEach((step, i) => {
      const button = stepsEl.children[i];
      button.classList.toggle('beat', i % 4 === 0);
      button.classList.toggle('filled', step.length > 0);
      button.classList.toggle('selected', i === stepIndex);
      button.classList.toggle('playing', i === playStep);
    });
    const focus = stepsEl.children[playStep ?? stepIndex];
    if (focus) {
      const left = focus.offsetLeft - stepsEl.offsetLeft;
      if (left < stepsEl.scrollLeft || left + focus.offsetWidth > stepsEl.scrollLeft + stepsEl.clientWidth) {
        stepsEl.scrollLeft = left - stepsEl.clientWidth / 2;
      }
    }
  }

  return { render, togglePlay };
}
