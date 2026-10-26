// A reorderable, renamable list used for sequences, views and envelopes.
// Drag by the handle to move; hold Alt while dropping to copy instead.
// Rename with a double-click on the name, the ✎ button or F2.

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Renders into `container`, which should stay the same element between calls.
 * @param {{items: {name:string, flag?:string}[], selected:number, fixedFirst?:boolean,
 *          onSelect(i), onRename(i,name), onMove(from,to,copy), onRemove(i), onAdd(altKey), addTitle:string}} options
 */
export function renderList(container, options) {
  if (!container.listState) attach(container);
  const state = container.listState;
  state.options = options;
  // When only the selection changed, move the highlight instead of rebuilding the rows:
  // a row rebuilt between the two clicks of a double-click would swallow the double-click.
  const signature = JSON.stringify([options.items.map((item) => [item.name, item.flag ?? null]), Boolean(options.fixedFirst), options.addTitle]);
  if (state.signature === signature && !state.renaming) {
    for (const li of container.querySelectorAll('.list li')) li.classList.toggle('selected', Number(li.dataset.index) === options.selected);
    return;
  }
  if (state.renaming) return;
  state.signature = signature;
  const fixed = (i) => options.fixedFirst && i === 0;
  container.innerHTML = `
    <ul class="list">${options.items
      .map(
        (item, i) => `
      <li data-index="${i}" class="${i === options.selected ? 'selected' : ''}">
        <span class="handle" title="Drag to reorder, Alt-drag to copy">${fixed(i) ? '' : '&#x2630;'}</span>
        <span class="name" title="Double-click to rename">${escapeHtml(item.name)}</span>
        ${item.flag ? `<span class="flag" title="${escapeHtml(item.flag)}">&#x26A0;</span>` : ''}
        ${fixed(i) ? '' : '<button class="rename" title="Rename (F2)">&#x270E;</button><button class="remove" title="Delete">&#x2716;</button>'}
      </li>`,
      )
      .join('')}</ul>
    <div class="add-row"><button class="add" title="${escapeHtml(options.addTitle)}">+</button></div>`;
}

// Event handling lives on the container, so it survives every redraw of the rows.
function attach(container) {
  const state = { options: null, signature: null, renaming: false, drag: null };
  container.listState = state;
  container.tabIndex = -1;
  const opts = () => state.options;
  const fixed = (i) => opts().fixedFirst && i === 0;

  function startRename(index) {
    if (fixed(index)) return;
    const nameEl = container.querySelector(`li[data-index="${index}"] .name`);
    if (!nameEl || nameEl.querySelector('input')) return;
    const original = opts().items[index].name;
    const input = document.createElement('input');
    input.value = original;
    nameEl.replaceChildren(input);
    state.renaming = true;
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      state.renaming = false;
      const name = input.value.trim();
      nameEl.textContent = commit && name ? name : original;
      if (commit && name && name !== original) opts().onRename(index, name);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  container.addEventListener('click', (event) => {
    if (event.target.closest('.add')) return opts().onAdd(event.altKey);
    const li = event.target.closest('.list li');
    if (!li || event.target.closest('input')) return;
    const index = Number(li.dataset.index);
    if (event.target.closest('.remove')) opts().onRemove(index);
    else if (event.target.closest('.rename')) startRename(index);
    else if (index !== opts().selected) opts().onSelect(index);
  });

  container.addEventListener('dblclick', (event) => {
    const li = event.target.closest('.list li');
    if (li && event.target.closest('.name')) startRename(Number(li.dataset.index));
  });

  container.addEventListener('keydown', (event) => {
    if (event.key === 'F2') startRename(opts().selected);
  });

  container.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('.handle');
    if (!handle || !handle.textContent) return;
    state.drag = { from: Number(handle.closest('li').dataset.index), to: null };
    container.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  container.addEventListener('pointermove', (event) => {
    if (!state.drag) return;
    const li = document.elementFromPoint(event.clientX, event.clientY)?.closest('.list li');
    for (const el of container.querySelectorAll('.list li')) el.classList.remove('drop-before', 'drop-after');
    if (!li || !container.contains(li)) return;
    const index = Number(li.dataset.index);
    const after = event.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
    let to = after ? index + 1 : index;
    if (opts().fixedFirst) to = Math.max(1, to);
    state.drag.to = to;
    li.classList.add(after ? 'drop-after' : 'drop-before');
  });
  container.addEventListener('pointerup', (event) => {
    if (!state.drag) return;
    const { from, to } = state.drag;
    state.drag = null;
    for (const el of container.querySelectorAll('.list li')) el.classList.remove('drop-before', 'drop-after');
    if (to === null) return;
    if (event.altKey) opts().onMove(from, to, true);
    else if (to !== from && to !== from + 1) opts().onMove(from, to > from ? to - 1 : to, false);
  });
}
