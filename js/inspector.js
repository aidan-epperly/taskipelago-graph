// Side panel: edits the selected node or link, or summarizes a multi-selection.

import { REGION_COLOR_PALETTE, REWARD_TYPE_VALUES, MAX_TASK_DESCRIPTION_LEN } from '../vendor/taskipelago/js/generator/model.js';
import { KIND_LABELS } from '../vendor/taskipelago/js/generator/clicker_fields.js';
import { validateRefName } from '../vendor/taskipelago/js/shared/prereq_parser.js';
import { condLabel, descendants, nodeTitle, nodesOf } from './graph.js';
import { app, commit, selectedNodes } from './store.js';
import { effectiveType } from './view.js';

let cmd = {};
export const initInspector = commands => { cmd = commands; };

// ------------------------------------------------------------------ DOM helpers
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

const field = (label, input, hint = null, err = null) => h('label', { class: 'field' },
  h('span', {}, label), input, hint && h('div', { class: 'hint' }, hint), err && h('div', { class: 'err' }, err));

/** Text input bound to node[key]; typing coalesces into one undo step. */
function text(n, key, { placeholder = '', mono = false, area = false, max = null, after = null, rerender = false } = {}) {
  const el = h(area ? 'textarea' : 'input', {
    class: `inp${mono ? ' mono' : ''}`, value: n[key] ?? '', placeholder, spellcheck: mono ? 'false' : 'true',
    maxLength: max || undefined,
  });
  el.addEventListener('input', () => {
    commit(() => { n[key] = el.value; after?.(el.value); }, { key: `${n.id}.${key}`, inspector: false });
  });
  if (rerender) el.addEventListener('change', () => renderInspector());
  return el;
}

function num(n, key, { min = 0, max = 9999, step = 1, after = null } = {}) {
  const el = h('input', { class: 'inp', type: 'number', min, max, step, value: n[key] ?? '' });
  el.addEventListener('input', () => {
    const v = el.value === '' ? '' : Number(el.value);
    commit(() => { n[key] = v === '' ? v : Math.min(max, Math.max(min, v)); after?.(); }, { key: `${n.id}.${key}`, inspector: false });
  });
  el.addEventListener('blur', () => { if (el.value === '') commit(() => { n[key] = min; }); });
  return el;
}

function check(n, key, label, hint = null, { disabled = false } = {}) {
  const el = h('input', { type: 'checkbox', checked: !!n[key], disabled });
  el.addEventListener('change', () => commit(() => { n[key] = el.checked; }));
  return h('label', { class: 'check', style: disabled ? 'opacity:.5' : '' }, el, h('span', {}, label), hint && h('span', { class: 'hint' }, hint));
}

function select(n, key, options, { disabled = false, after = null } = {}) {
  const el = h('select', { class: 'inp', disabled });
  for (const [value, label] of options) el.append(h('option', { value, selected: String(n[key] ?? '') === String(value) }, label));
  el.addEventListener('change', () => commit(() => { n[key] = el.value; after?.(el.value); }));
  return el;
}

function seg(options, current, onPick) {
  return h('div', { class: 'seg' }, options.map(([v, label]) =>
    h('button', { class: v === current ? 'on' : '', type: 'button', onclick: () => onPick(v) }, label)));
}

function swatches(n, key) {
  const row = h('div', { class: 'swatch-row' });
  row.append(h('button', { class: `swatch none${!n[key] ? ' on' : ''}`, title: 'No color', onclick: () => commit(() => { n[key] = ''; }) }));
  for (const c of REGION_COLOR_PALETTE) {
    row.append(h('button', { class: `swatch${n[key] === c ? ' on' : ''}`, style: `background:${c}`, title: c, onclick: () => commit(() => { n[key] = c; }) }));
  }
  const custom = h('input', { type: 'color', value: n[key] || '#888888', style: 'width:28px;height:24px;border:0;background:none;padding:0;cursor:pointer', title: 'Custom color' });
  custom.addEventListener('change', () => commit(() => { n[key] = custom.value; }));
  row.append(custom);
  return row;
}

const section = (title, ...kids) => h('section', {}, h('div', { class: 'st' }, ...(Array.isArray(title) ? title : [title])), ...kids);
const help = (...kids) => h('div', { class: 'help' }, ...kids);

function dotFor(n) {
  const doc = app.doc;
  let color = 'var(--faint)';
  if (n.kind === 'task') color = doc.nodes[n.region]?.color || 'var(--faint)';
  if (n.kind === 'region' || n.kind === 'group') color = n.color || 'var(--faint)';
  if (n.kind === 'item') color = n.consumable ? 'var(--gold)' : { progression: 'var(--t-prog)', useful: 'var(--t-useful)', trap: 'var(--t-trap)' }[effectiveType(doc, n)] || 'var(--t-junk)';
  if (n.kind === 'goal') color = 'var(--gold)';
  return h('span', { class: 'dot', style: `background:${color}` });
}

/** A clickable row for a related node or link. */
function relRow(n, right = '', onclick = null) {
  return h('div', { class: 'rel', onclick: onclick || (() => cmd.navigateTo(n.id)) },
    dotFor(n), h('span', { class: 'rn' }, nodeTitle(n)), right && h('span', { class: 'rc' }, right));
}

function linksSection(n, dir) {
  const doc = app.doc;
  const edges = Object.values(doc.edges).filter(e => (dir === 'in' ? e.to === n.id : e.from === n.id) && e.kind === 'req');
  const title = dir === 'in' ? (n.kind === 'goal' ? 'Goal needs' : 'Requires') : 'Unlocks';
  const add = h('button', { class: 'btn small outline', onclick: () => cmd.startLink(dir === 'in' ? 'in' : 'out', [n.id]) }, '+ Link');
  const kids = [];
  if (dir === 'in' && n.kind !== 'gate') {
    kids.push(h('div', { style: 'margin-bottom:8px' }, seg([['and', 'All of these'], ['or', 'Any one']], n.combine || 'and',
      v => commit(() => { n.combine = v; }))));
  }
  for (const e of edges) {
    const other = doc.nodes[dir === 'in' ? e.from : e.to];
    if (other) kids.push(relRow(other, condLabel(doc, e) || (dir === 'in' ? (other.kind === 'item' ? 'received' : other.kind === 'task' ? 'done' : '') : ''), () => cmd.selectEdge(e.id)));
  }
  if (!edges.length) {
    kids.push(h('div', { class: 'faint small' }, dir === 'in'
      ? (n.kind === 'goal' ? 'Nothing linked: the goal is completing every task.' : 'Nothing. Available from the start.')
      : 'Nothing yet.'));
  }
  return section([title, add], ...kids);
}

function costSection(n) {
  const doc = app.doc;
  const edges = Object.values(doc.edges).filter(e => e.to === n.id && e.kind === 'cost');
  const kids = edges.map(e => relRow(doc.nodes[e.from], `spend ${e.cond?.amount || 1}`, () => cmd.selectEdge(e.id)));
  if (!edges.length) kids.push(h('div', { class: 'faint small' }, 'Free.'));
  const form = addCostForm(n);
  form.hidden = true;
  const add = h('button', { class: 'btn small outline', onclick: () => {
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('select').focus();
  } }, '+ Cost');
  return section(['Cost', add], ...kids, form);
}

/** Pick a currency (or name a new one) and an amount; a new currency gets amount × copies items. */
function addCostForm(n) {
  const doc = app.doc;
  const currencies = nodesOf(doc, 'item').filter(i => i.consumable && !i.filler);
  const pick = h('select', { class: 'inp' },
    currencies.map(i => h('option', { value: i.id }, nodeTitle(i))),
    h('option', { value: '' }, '+ New currency…'));
  const name = h('input', { class: 'inp', placeholder: 'e.g. Gold', spellcheck: 'false' });
  const amount = h('input', { class: 'inp', type: 'number', min: 1, max: 9999, value: 1 });
  const nameRow = field('New currency name', name);
  const note = h('div', { class: 'hint' });
  const err = h('div', { class: 'err' });
  const copies = Math.max(1, n.count || 1);
  const update = () => {
    const isNew = !pick.value;
    nameRow.hidden = !isNew;
    const amt = Math.max(1, Number(amount.value) || 1);
    note.textContent = isNew
      ? `Creates a currency item with ${amt * copies} ${amt * copies === 1 ? 'copy' : 'copies'}${copies > 1 ? ` (${amt} for each of the ${copies} copies of this task)` : ''}.`
      : '';
    err.textContent = '';
  };
  pick.addEventListener('change', update);
  amount.addEventListener('input', update);
  name.addEventListener('input', update);
  const submit = () => {
    const nm = name.value.trim();
    if (!pick.value) {
      if (!nm) { err.textContent = 'Name the new currency.'; name.focus(); return; }
      if (nm.includes('"')) { err.textContent = 'Names cannot contain quotation marks.'; return; }
      if (nodesOf(doc, 'item').some(i => (i.name || '').trim() === nm && !i.filler)) { err.textContent = 'Another item has this name.'; return; }
    }
    cmd.addCost(n.id, { itemId: pick.value, name: nm, amount: amount.value });
  };
  name.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  update();
  return h('div', { class: 'cost-form', style: 'margin-top:8px' },
    h('div', { class: 'row2' }, field('Currency', pick), field('Spend', amount)),
    nameRow, note, err,
    h('button', { class: 'btn small primary', onclick: submit }, 'Add cost'));
}

function nameError(n) {
  if (n.kind === 'region' || n.kind === 'group') {
    const name = (n.name || '').trim();
    if (!name) return null;
    const why = validateRefName(name);
    if (why) return `Name ${why}.`;
  }
  if (n.kind === 'task' || n.kind === 'item' || n.kind === 'region' || n.kind === 'group') {
    const name = (n.name || '').trim();
    if (name.includes('"')) return 'Names cannot contain quotation marks.';
    if (name && nodesOf(app.doc, n.kind).some(o => o !== n && (o.name || '').trim() === name && !o.filler)) {
      return `Another ${n.kind} has this name.`;
    }
  }
  return null;
}

function nameField(n, label = 'Name') {
  const err = h('div', { class: 'err' }, nameError(n) || '');
  const el = text(n, 'name', {
    placeholder: `Name this ${n.kind}`,
    after: () => {
      err.textContent = nameError(n) || '';
      const h3 = document.querySelector('#inspector h3');
      if (h3?.firstChild) h3.firstChild.textContent = nodeTitle(n);
    },
  });
  el.dataset.focus = 'name';
  return h('label', { class: 'field' }, h('span', {}, label), el, err);
}

const header = (kind, title, extra = null) => h('div', {},
  h('div', { class: 'kind' }, kind), h('h3', {}, title, extra));

// ------------------------------------------------------------------ per kind

function taskPanel(n) {
  const doc = app.doc;
  const regions = nodesOf(doc, 'region');
  const out = [header('Task', nodeTitle(n)), nameField(n)];
  out.push(field('Description', text(n, 'desc', { area: true, max: MAX_TASK_DESCRIPTION_LEN, placeholder: 'Optional, shown under the task name' })));
  out.push(field('Region', select(n, 'region', [['', '— none —'], ...regions.map(r => [r.id, r.name || 'Untitled region'])])));
  const inOrder = check(n, 'sequential', 'Copies in order', 'each copy needs the one before', { disabled: (n.count || 1) < 2 });
  const copies = num(n, 'count', {
    min: 1, max: 999,
    after: () => {
      const off = (n.count || 1) < 2;
      inOrder.querySelector('input').disabled = off;
      inOrder.style.opacity = off ? '.5' : '';
    },
  });
  out.push(h('div', { class: 'row2' },
    field('Copies', copies, n.sequential && n.count > 1 ? 'Done one after another' : 'Interchangeable copies'),
    h('div', { class: 'field' }, h('span', {}, ' '), h('button', { class: 'btn outline', onclick: () => cmd.makeSequence(n.id) }, 'Make a sequence…'))));
  out.push(inOrder);
  out.push(h('button', { class: 'btn outline', style: 'margin-bottom:10px', onclick: () => cmd.makeLadder([n.id]) }, 'Make a ladder…'));
  out.push(check(n, 'priority', 'Priority location', 'more likely to hold progression'));
  out.push(linksSection(n, 'in'));
  out.push(costSection(n));
  out.push(linksSection(n, 'out'));
  if (doc.settings.clickerMode) {
    const consumables = nodesOf(doc, 'item').filter(i => i.consumable);
    out.push(section('Clicker',
      field('Activations', text(n, 'activations', { mono: true, placeholder: '1' }), 'Number or expression over N_TASKS'),
      check(n, 'manual', 'Manual task', 'never clickable'),
      check(n, 'autoComplete', 'Auto-complete'),
      check(n, 'renewable', 'Renewable', 'later completions pay currency'),
      n.renewable && h('div', { class: 'row2' },
        field('Currency', select(n, 'renewableCurrency', [['', '— pick —'], ...consumables.map(i => [i.id, i.name])])),
        field('Per completion', text(n, 'renewableAmount', { placeholder: '1' })))));
  }
  out.push(advanced(
    field('Extra task prereq', text(n, 'extraPrereq', { mono: true, placeholder: 'e.g. Kitchen-50 || "Other task"' }), 'ANDed with the links above. Task numbers, quoted names, region refs, item(...).'),
    field('Extra item prereq', text(n, 'extraItemPrereq', { mono: true, placeholder: 'e.g. keys*2' })),
    field('Extra cost', text(n, 'extraCost', { mono: true, placeholder: 'e.g. "Gold"*5 || "Silver"*10' }), 'For costs with alternatives.')));
  out.push(deleteRow());
  return out;
}

function itemPanel(n) {
  const doc = app.doc;
  const groups = nodesOf(doc, 'group');
  const out = [header('Item', n.filler ? 'Filler' : nodeTitle(n))];
  if (!n.filler) out.push(nameField(n));
  const g = doc.nodes[n.group];
  const typeLocked = n.filler || n.consumable || (g && g.gtype === 'progressive');
  const typeSel = select(n, 'type', REWARD_TYPE_VALUES.map(t => [t, t[0].toUpperCase() + t.slice(1)]), { disabled: typeLocked });
  if (typeLocked) typeSel.value = effectiveType(doc, n);
  out.push(h('div', { class: 'row2' },
    field('Type', typeSel, typeLocked ? (n.consumable ? 'Currency is progression' : n.filler ? 'Filler is junk' : 'Progressive groups are progression') : null),
    field('Copies', num(n, 'count', { min: 1, max: 999 }))));
  if (!n.filler) {
    out.push(field('Item group', select(n, 'group', [['', '— none —'], ...groups.map(x => [x.id, x.name || 'Untitled group'])], { disabled: n.consumable }),
      n.consumable ? 'Currency cannot be in a group' : null));
    out.push(check(n, 'consumable', 'Currency (consumable)', 'spent on task costs'));
  }
  out.push(check(n, 'early', 'Early', 'placed in sphere 1'));
  out.push(check(n, 'filler', 'Filler', 'random flavor name, no effect'));
  out.push(linksSection(n, 'out'));
  if (doc.settings.clickerMode && !n.filler) {
    out.push(section('Clicker',
      field('Grants', select(n, 'clickerKind', Object.entries(KIND_LABELS))),
      n.clickerKind && n.clickerKind !== 'none' && h('div', { class: 'row2' },
        field('Target', text(n, 'clickerTarget', { mono: true, placeholder: '*' }), '"Task", region or *'),
        field('Value', text(n, 'clickerValue', { mono: true, placeholder: '1' })))));
  }
  out.push(deleteRow());
  return out;
}

function regionPanel(n) {
  const doc = app.doc;
  const others = nodesOf(doc, 'region').filter(r => r !== n && !r.parentRegion);
  const members = nodesOf(doc, 'task').filter(t => t.region === n.id);
  const out = [header('Region', nodeTitle(n)), nameField(n)];
  out.push(field('Color', swatches(n, 'color')));
  out.push(h('div', { class: 'row2' },
    field('Default share', num(n, 'pct', { min: 0, max: 100 }), '% of its tasks a bare reference needs'),
    field('Inside region', select(n, 'parentRegion', [['', '— top level —'], ...others.map(r => [r.id, r.name || 'Untitled'])]))));
  out.push(section([`Tasks (${members.length})`, h('button', { class: 'btn small outline', onclick: () => cmd.assignSelectionTo(n.id) }, '+ Add tasks')],
    ...(members.length ? members.slice(0, 40).map(t => relRow(t, t.count > 1 ? `×${t.count}` : ''))
      : [h('div', { class: 'faint small' }, 'Use “+ Add tasks” and click tasks, or set a task’s region in its panel.')]),
    members.length > 40 ? h('div', { class: 'faint small' }, `…and ${members.length - 40} more`) : null));
  out.push(linksSection(n, 'in'));
  out.push(linksSection(n, 'out'));
  out.push(section('Randomize',
    check(n, 'randomOn', 'Keep a random subset of tasks'),
    n.randomOn && field('Keep', text(n, 'randomPick', { placeholder: 'e.g. 3 or 50%' })),
    check(n, 'randomOrder', 'Shuffle task order'),
    check(n, 'disabled', 'Disabled', 'left out of the seed')));
  if (doc.settings.clickerMode) {
    out.push(section('Clicker',
      check(n, 'manual', 'Manual tasks'),
      check(n, 'distributed', 'Split production evenly'),
      field('Offline rate', text(n, 'offlineRate', { mono: true, placeholder: 'inherit' }))));
  }
  out.push(advanced(field('Extra dependency', text(n, 'extraPrereq', { mono: true, placeholder: 'e.g. Kitchen-50 && task(3)' }), 'ANDed with the links above.')));
  out.push(deleteRow());
  return out;
}

function groupPanel(n) {
  const doc = app.doc;
  const members = nodesOf(doc, 'item').filter(i => i.group === n.id && !i.consumable && !i.filler);
  const others = nodesOf(doc, 'group').filter(g => g !== n && !g.parentGroup && g.gtype !== 'random-choice');
  const out = [header('Item group', nodeTitle(n)), nameField(n)];
  out.push(field('Color', swatches(n, 'color')));
  out.push(field('Type', select(n, 'gtype', [['progressive', 'Progressive — interchangeable counter'], ['random-choice', 'Random choice — keep a few'], ['aesthetic', 'Aesthetic — color only']])));
  if (n.gtype === 'random-choice') out.push(field('Keep per seed', text(n, 'pick', { placeholder: 'e.g. 2 or 50%' })));
  out.push(h('div', { class: 'row2' },
    field('Default %', text(n, 'pct', { placeholder: n.gtype === 'progressive' ? 'ordering' : '100' }), 'For bare references'),
    field('Inside group', select(n, 'parentGroup', [['', '— top level —'], ...others.map(g => [g.id, g.name || 'Untitled'])]))));
  out.push(check(n, 'early', 'Early items'));
  out.push(check(n, 'disabled', 'Disabled', 'left out of the seed'));
  out.push(section([`Items (${members.length})`, h('button', { class: 'btn small outline', onclick: () => cmd.assignSelectionTo(n.id) }, '+ Add items')],
    ...(members.length ? members.map(i => relRow(i, i.count > 1 ? `×${i.count}` : ''))
      : [h('div', { class: 'faint small' }, 'Use “+ Add items” and click items, or set an item’s group in its panel.')])));
  out.push(linksSection(n, 'out'));
  out.push(deleteRow());
  return out;
}

function portPanel(n) {
  const meta = app.doc.nodes[n.parent];
  const input = n.role === 'input';
  const ins = Object.values(app.doc.edges).filter(e => e.to === n.id).length;
  return [header(`${meta?.name || 'Meta-node'}`, input ? 'Input' : 'Output'),
    help(input
      ? 'What this meta-node needs from outside. Links into the meta-node card arrive here; link Input to the nodes inside that should wait for them.'
      : 'What this meta-node hands on. Anything that requires the meta-node card requires this. Link the nodes inside that finish the group into Output.'),
    field(input ? 'Passes when' : 'Done when', seg([['and', 'All inputs'], ['or', 'Any input']], n.op, v => commit(() => { n.op = v; }))),
    !input && !ins ? help('Nothing is linked into Output yet, so it means every task inside this meta-node is done.') : null,
    linksSection(n, 'in'), linksSection(n, 'out')];
}

function gatePanel(n) {
  if (n.role) return portPanel(n);
  return [header('Logic gate', n.op.toUpperCase()),
    field('Passes when', seg([['and', 'All inputs (AND)'], ['or', 'Any input (OR)']], n.op, v => commit(() => { n.op = v; }))),
    help('Gates build nested rules, like “(A and B) or C”. Link requirements into the gate, then link the gate to what it unlocks.'),
    linksSection(n, 'in'), linksSection(n, 'out'), deleteRow()];
}

function goalPanel(n) {
  const doc = app.doc;
  const s = doc.settings;
  const extra = h('input', { class: 'inp mono', value: s.extraGoal || '', placeholder: 'e.g. Kitchen-75 || item("Crown")', spellcheck: 'false' });
  extra.addEventListener('input', () => commit(() => { s.extraGoal = extra.value; }, { key: 'settings.extraGoal', inspector: false }));
  return [header('Goal', 'Goal'),
    help('Link tasks, regions, items or gates here. The slot is complete when they are satisfied.'),
    linksSection(n, 'in'),
    advanced(field('Extra goal expression', extra, 'ANDed with the links above.'))];
}

function metaPanel(n) {
  const doc = app.doc;
  const kids = Object.values(doc.nodes).filter(x => x.parent === n.id);
  const all = descendants(doc, n.id);
  const name = text(n, 'name', { placeholder: 'Name this group' });
  name.dataset.focus = 'name';
  return [header('Meta-node', nodeTitle(n)),
    field('Name', name),
    h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
      h('button', { class: 'btn primary', onclick: () => cmd.enter(n.id) }, 'Open'),
      h('button', { class: 'btn outline', onclick: () => cmd.ungroup(n.id) }, 'Ungroup'),
      h('button', { class: 'btn outline', onclick: () => cmd.randomizeDialog({ metaId: n.id }) }, 'Randomize links…')),
    help(h('p', {}, 'Links into this card go to the meta-node’s Input, and links out of it start at its Output; open it to wire them to the nodes inside. An Output with nothing linked into it means every task inside is done.')),
    portLinks(n, 'input'), portLinks(n, 'output'),
    section(`Contents (${all.length})`, ...kids.slice(0, 60).map(k => relRow(k, k.kind))),
    deleteRow('Delete with contents')];
}

/** The meta-node's outside links, through its Input or Output gate. */
function portLinks(meta, which) {
  const doc = app.doc;
  const g = doc.nodes[meta[which]];
  if (!g) return null;
  const input = which === 'input';
  const edges = Object.values(doc.edges).filter(e => (input ? e.to === g.id : e.from === g.id));
  const add = h('button', { class: 'btn small outline', onclick: () => cmd.startLink(input ? 'in' : 'out', [meta.id]) }, '+ Link');
  const rows = edges.map(e => {
    const other = doc.nodes[input ? e.from : e.to];
    return other && relRow(other, condLabel(doc, e), () => cmd.selectEdge(e.id));
  });
  if (!rows.length) rows.push(h('div', { class: 'faint small' }, input ? 'Nothing. The contents are available from the start.' : 'Nothing yet.'));
  return section([input ? 'Requires (Input)' : 'Unlocks (Output)', add],
    input && edges.length > 1 ? h('div', { style: 'margin-bottom:8px' }, seg([['and', 'All of these'], ['or', 'Any one']], g.op, v => commit(() => { g.op = v; }))) : null,
    ...rows);
}

function notePanel(n) {
  return [header('Note', 'Note'), field('Text', text(n, 'text', { area: true, placeholder: 'Anything. Notes are never exported.' })), deleteRow()];
}

// ------------------------------------------------------------------ links

function edgePanel(e) {
  const doc = app.doc;
  const a = doc.nodes[e.from];
  const b = doc.nodes[e.to];
  const c = e.cond ||= {};
  const out = [header('Link', `${nodeTitle(a)} → ${nodeTitle(b)}`)];
  out.push(h('div', { style: 'display:flex;gap:6px;margin-top:8px' },
    h('button', { class: 'btn small outline', onclick: () => cmd.navigateTo(a.id) }, '‹ From'),
    h('button', { class: 'btn small outline', onclick: () => cmd.navigateTo(b.id) }, 'To ›')));
  const setC = (k, v, rerender = true) => commit(() => { c[k] = v; }, { key: rerender ? null : `${e.id}.${k}`, inspector: rerender });
  const numIn = (k, { min = 1, max = 9999 } = {}) => {
    const el = h('input', { class: 'inp', type: 'number', min, max, value: c[k] ?? min, style: 'width:90px' });
    el.addEventListener('input', () => { if (el.value !== '') setC(k, Math.min(max, Math.max(min, Number(el.value))), false); });
    return el;
  };
  const sec = [];
  if (a.kind === 'item' && a.consumable && b.kind === 'task') {
    sec.push(field('This currency is', seg([['req', 'Required (kept)'], ['cost', 'Spent (cost)']], e.kind,
      v => commit(() => { e.kind = v; if (v === 'cost') c.amount ||= 1; }))));
  }
  if (e.kind === 'cost') {
    sec.push(field('Amount to spend', numIn('amount')));
  } else if (a.kind === 'task') {
    sec.push(help(a.count > 1 ? `Unlocks once all ${a.count} copies of “${nodeTitle(a)}” are done.` : `Unlocks once “${nodeTitle(a)}” is done.`));
  } else if (a.kind === 'item') {
    sec.push(field('Copies received', numIn('copies', { max: Math.max(1, a.count || 1) }), (a.count || 1) > 1 ? `Out of ${a.count} in the pool` : 'This item has one copy'));
  } else if (a.kind === 'region') {
    const mode = c.mode || 'default';
    sec.push(field('Region progress', seg([['default', `Default (${a.pct ?? 100}%)`], ['pct', 'Percent'], ['count', 'Tasks']], mode, v => setC('mode', v))));
    if (mode === 'pct') sec.push(field('Percent of its tasks done', numIn('n', { min: 0, max: 100 })));
    if (mode === 'count') sec.push(field('Number of its tasks done', numIn('n')));
  } else if (a.kind === 'group') {
    const prog = a.gtype === 'progressive';
    const opts = prog ? [['count', 'At least N'], ['next', 'Next in order'], ['position', 'Position N']]
      : [['count', 'At least N'], ['pct', 'Percent'], ['default', `Default (${a.pct || 100}%)`]];
    const mode = c.mode || 'count';
    sec.push(field('Items received from the group', seg(opts, mode, v => setC('mode', v))));
    if (mode === 'count') sec.push(field('Items needed', numIn('n')));
    if (mode === 'pct') sec.push(field('Percent of the group', numIn('n', { min: 0, max: 100 })));
    if (mode === 'position') sec.push(field('Position in the order', numIn('n')));
    if (prog && mode !== 'count') sec.push(help('Ordering mode: each task referencing the group gets the next copy. A group cannot mix ordering and “at least N” references, and OR / mixed rules only allow “at least N”.'));
  } else if (a.kind === 'gate') {
    sec.push(help(`Passes when ${a.op === 'and' ? 'all' : 'any'} of the gate’s inputs pass.`));
  }
  out.push(section('Condition', ...sec));
  out.push(h('section', {}, h('button', { class: 'btn danger outline', onclick: () => cmd.deleteSelection() }, 'Delete link')));
  return out;
}

// ------------------------------------------------------------------ selection / empty

function multiPanel(nodes) {
  const doc = app.doc;
  const tasks = nodes.filter(n => n.kind === 'task');
  const items = nodes.filter(n => n.kind === 'item');
  const out = [header('Selection', `${nodes.length} nodes`)];
  out.push(h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px' },
    h('button', { class: 'btn primary', onclick: () => cmd.groupSelection() }, 'Group into meta-node'),
    h('button', { class: 'btn outline', onclick: () => cmd.layoutSelection() }, 'Tidy'),
    tasks.length >= 2 && h('button', { class: 'btn outline', onclick: () => cmd.randomizeDialog({ ids: nodes.map(x => x.id) }) }, 'Random meta-node…'),
    nodes.length === 2 && nodes.every(x => x.kind === 'task') && h('button', { class: 'btn outline', onclick: () => cmd.makeLadder(nodes.map(x => x.id)) }, 'Make a ladder from these…'),
    cmd.chainOf(nodes.map(x => x.id)) && h('button', { class: 'btn outline', onclick: () => cmd.mergeChain(nodes.map(x => x.id)) }, 'Merge into one sequential task'),
    h('button', { class: 'btn danger outline', onclick: () => cmd.deleteSelection() }, 'Delete')));
  if (cmd.chainOf(nodes.map(x => x.id)) && !cmd.mergeIsLossless(nodes.map(x => x.id))) {
    out.push(h('div', { class: 'hint', style: 'margin-top:6px' },
      'These steps have their own links, costs or descriptions (a ladder’s rungs, for example). Merging moves the links to the whole task and drops the rest.'));
  }
  if (tasks.length) {
    const sel = h('select', { class: 'inp' }, h('option', { value: '' }, '— none —'),
      nodesOf(doc, 'region').map(r => h('option', { value: r.id }, r.name || 'Untitled region')),
      h('option', { value: '__new' }, '+ New region from these tasks'));
    const common = tasks.every(t => t.region === tasks[0].region) ? tasks[0].region : null;
    if (common !== null) sel.value = common;
    sel.addEventListener('change', () => cmd.setRegion(tasks.map(t => t.id), sel.value));
    out.push(section(`Tasks (${tasks.length})`, field('Set region', sel)));
  }
  if (items.length) {
    const sel = h('select', { class: 'inp' }, h('option', { value: '' }, '— none —'),
      nodesOf(doc, 'group').map(g => h('option', { value: g.id }, g.name || 'Untitled group')),
      h('option', { value: '__new' }, '+ New group from these items'));
    const common = items.every(t => t.group === items[0].group) ? items[0].group : null;
    if (common !== null) sel.value = common;
    sel.addEventListener('change', () => cmd.setGroup(items.map(t => t.id), sel.value));
    out.push(section(`Items (${items.length})`, field('Set item group', sel)));
  }
  out.push(section('Nodes', ...nodes.slice(0, 50).map(n => relRow(n, n.kind, () => cmd.selectOnly(n.id)))));
  return out;
}

function emptyPanel() {
  const doc = app.doc;
  const count = k => nodesOf(doc, k).length;
  return [header('Overview', doc.settings.playerName || 'Unnamed slot'),
    h('div', { class: 'muted small mt' }, `${count('task')} tasks · ${count('item')} items · ${count('region')} regions · ${count('group')} item groups`),
    section('Building',
      help(h('dl', {},
        h('dt', {}, 'Add'), h('dd', {}, 'Pick a node type on the left, then click the canvas.'),
        h('dt', {}, 'Chain'), h('dd', {}, h('span', { class: 'kbd' }, 'N'), ' on a selected node adds the next task after it.'),
        h('dt', {}, 'Link'), h('dd', {}, h('span', { class: 'kbd' }, 'L'), ' then click what it unlocks. ', h('span', { class: 'kbd' }, 'Shift'), h('span', { class: 'kbd' }, 'L'), ' links what it requires.'),
        h('dt', {}, 'Move'), h('dd', {}, h('span', { class: 'kbd' }, 'M'), ', glide, click to drop, or drag. Arrow keys nudge.'),
        h('dt', {}, 'Select'), h('dd', {}, 'Click; Shift+click adds to the selection.'),
        h('dt', {}, 'Group'), h('dd', {}, h('span', { class: 'kbd' }, 'G'), ' wraps the selection in a meta-node; double-click opens it.'),
        h('dt', {}, 'Pan / zoom'), h('dd', {}, 'Two-finger scroll pans, pinch zooms. ', h('span', { class: 'kbd' }, 'F'), ' fits.'),
      ))),
    section('Slot',
      h('button', { class: 'btn outline', onclick: () => cmd.openSettings() }, 'Slot settings…'))];
}

const deleteRow = (label = 'Delete') => h('section', {},
  h('button', { class: 'btn danger outline', onclick: () => cmd.deleteSelection() }, label));

const advanced = (...kids) => h('section', {}, h('details', { class: 'adv' }, h('summary', {}, 'Advanced: raw expressions'), ...kids));

// ------------------------------------------------------------------ entry

export function renderInspector() {
  const root = document.getElementById('inspector');
  const scroll = root.scrollTop;
  const doc = app.doc;
  let kids;
  const nodes = selectedNodes();
  if (app.sel.edge && doc.edges[app.sel.edge]) kids = edgePanel(doc.edges[app.sel.edge]);
  else if (nodes.length > 1) kids = multiPanel(nodes);
  else if (nodes.length === 1) {
    const n = nodes[0];
    kids = ({ task: taskPanel, item: itemPanel, region: regionPanel, group: groupPanel, gate: gatePanel, goal: goalPanel, meta: metaPanel, note: notePanel })[n.kind](n);
  } else kids = emptyPanel();
  const panel = h('div', { class: 'insp' }, ...kids);
  root.replaceChildren(panel);
  root.scrollTop = scroll;
}

export function focusName() {
  const el = document.querySelector('#inspector [data-focus="name"], #inspector textarea');
  if (el) { el.focus(); el.select?.(); }
}
