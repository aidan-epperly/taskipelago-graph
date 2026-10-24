// Editor controller: input handling, commands, validation, files.

import {
  addEdge, ancestors, childrenOf, edgeProblem, emptyDoc, groupInto, makeNode, newId, nextRegionColor, portFor, repAt,
  nodeTitle, normalizeDoc, nodesOf, deleteNodes, ungroup, SOURCE_KINDS, WIDTH,
} from './graph.js';
import { exportYaml, linkMessage } from './compile.js';
import { importYaml, withEmbeddedLayout } from './importer.js';
import { layoutLevel } from './layout.js';
import { exampleDoc } from './example.js';
import { fillIcons, icon } from './icons.js';
import { app, commit, redo, replaceDoc, select, selectedNodes, setHooks, undo, view } from './store.js';
import {
  applyTransform, centerOn, drawEdges, esc, fitView, flash, frame, positionActionBar, renderCanvas,
  screenToWorld, setActionBarContent, setRubber, syncPositions, updateSelection, zoomAt,
} from './view.js';
import { focusName, initInspector, renderInspector } from './inspector.js';
import { closeModal, confirmDialog, helpDialog, modal, modalOpen, settingsDialog, toast } from './dialogs.js';

const $ = id => document.getElementById(id);
const STORE_KEY = 'taskipelago-graph.doc';
const UI_KEY = 'taskipelago-graph.ui';
const canvas = $('canvas');

// ------------------------------------------------------------------ persistence

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(app.doc));
      localStorage.setItem(UI_KEY, JSON.stringify({ views: app.views, level: app.level, theme: document.documentElement.dataset.theme || '' }));
    } catch (_) { /* storage full or blocked: the session still works */ }
  }, 400);
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const ui = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
    if (ui.theme) document.documentElement.dataset.theme = ui.theme;
    if (!raw) return false;
    app.doc = normalizeDoc(JSON.parse(raw));
    app.views = ui.views || {};
    app.level = ui.level && app.doc.nodes[ui.level] ? ui.level : null;
    return true;
  } catch (_) {
    return false;
  }
}

// ------------------------------------------------------------------ validation

let validateTimer = null;
let validateSeq = 0;
function scheduleValidate() {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(runValidate, 300);
}

async function runValidate() {
  const seq = ++validateSeq;
  const res = await exportYaml(app.doc);
  if (seq !== validateSeq) return;
  app.validation = res;
  renderStatus();
}

function renderStatus() {
  const res = app.validation;
  if (!res) return;
  const errors = res.problems.filter(p => p.level === 'error');
  const warnings = res.problems.filter(p => p.level === 'warning');
  const pill = $('status-pill');
  if (errors.length) {
    pill.className = 'pill err';
    pill.innerHTML = `${icon('circle-x')} ${errors.length} problem${errors.length === 1 ? '' : 's'}${warnings.length ? ` · ${warnings.length} note${warnings.length === 1 ? '' : 's'}` : ''}`;
  } else if (warnings.length) {
    pill.className = 'pill warn';
    pill.innerHTML = `${icon('triangle-alert')} Ready · ${warnings.length} note${warnings.length === 1 ? '' : 's'}`;
  } else {
    pill.className = 'pill ok';
    pill.innerHTML = `${icon('circle-check')} Ready to export`;
  }
  const c = res.compiled;
  const filler = c.model.items.filter(i => i.filler).reduce((a, i) => a + i.count, 0);
  const autoFill = app.doc.settings.autoFiller && c.itemIds[c.itemIds.length - 1] === null ? filler : 0;
  const items = c.itemSlots + autoFill;
  $('slots').innerHTML = `Tasks <b>${c.taskSlots}</b> · Items <b>${items}</b>${autoFill ? ` <span class="faint">(${autoFill} filler)</span>` : ''}`
    + (c.taskSlots !== items ? ' <b style="color:var(--danger)">unbalanced</b>' : '');
  if ($('problems').classList.contains('open')) renderProblems();
}

function renderProblems() {
  const res = app.validation;
  const el = $('problems');
  if (!res) return;
  const list = res.problems;
  const rows = list.map(p => {
    const parts = linkMessage(app.doc, p.msg, res.compiled)
      .map(x => (typeof x === 'string' ? esc(x) : `<a data-goto="${esc(x.id)}">${esc(x.text)}</a>`)).join('');
    const show = p.nodeId ? ` <a data-goto="${esc(p.nodeId)}">Show</a>` : '';
    return `<div class="prob ${p.level}"><span class="ic">${icon(p.level === 'error' ? 'circle-x' : 'triangle-alert')}</span><div>`
      + `${p.title ? `<div class="pt">${esc(p.title)}</div>` : ''}<div class="pm">${parts}${show}</div></div></div>`;
  }).join('');
  el.innerHTML = `<header>${list.length ? 'Problems and notes' : 'No problems'}<span class="spacer"></span><button class="btn icon-btn" data-close-problems aria-label="Close">${icon('x')}</button></header>`
    + (rows || `<div class="prob"><span class="ic" style="color:var(--ok)">${icon('circle-check')}</span><div class="pm">The generator accepts this slot.</div></div>`);
}

// ------------------------------------------------------------------ hooks

function render() {
  renderCanvas();
  const onlyGoal = Object.values(app.doc.nodes).every(n => n.kind === 'goal');
  $('empty-state').hidden = !onlyGoal || app.emptyDismissed;
}

setHooks({
  render,
  selection: updateSelection,
  inspector: renderInspector,
  changed: () => { scheduleSave(); scheduleValidate(); updateUndo(); },
});

function updateUndo() {
  $('b-undo').disabled = !app.history.past.length;
  $('b-redo').disabled = !app.history.future.length;
}

// ------------------------------------------------------------------ commands

function freeSpot(level, x, y, w = 210, h = 70) {
  const boxes = childrenOf(app.doc, level).map(n => ({ x: n.x, y: n.y, ...(app.sizes.get(n.id) || { w: WIDTH[n.kind] || 200, h: 64 }) }));
  const hit = yy => boxes.some(b => x < b.x + b.w + 20 && x + w + 20 > b.x && yy < b.y + b.h + 16 && yy + h + 16 > b.y);
  let yy = y;
  for (let i = 0; i < 40 && hit(yy); i++) yy += 40;
  return yy;
}

function placeNode(kind, x, y) {
  const data = {};
  if (kind === 'gate-and') { kind = 'gate'; data.op = 'and'; }
  if (kind === 'gate-or') { kind = 'gate'; data.op = 'or'; }
  if (kind === 'region' || kind === 'group') data.color = nextRegionColor(app.doc);
  const w = WIDTH[kind] || 200;
  const n = makeNode(kind, Math.round((x - w / 2) / 10) * 10, Math.round((y - 25) / 10) * 10, data);
  n.parent = app.level;
  commit(doc => { doc.nodes[n.id] = n; }, { inspector: false });
  select([n.id]);
  focusName();
  return n;
}

function nextTask() {
  const nodes = selectedNodes();
  if (nodes.length !== 1) return;
  const src = nodes[0];
  if (!['task', 'item', 'region', 'group', 'gate'].includes(src.kind)) return;
  const size = app.sizes.get(src.id) || { w: WIDTH[src.kind], h: 64 };
  const x = src.x + size.w + 90;
  const y = freeSpot(app.level, x, src.y);
  const t = makeNode('task', x, y, { region: src.kind === 'task' ? src.region : src.kind === 'region' ? src.id : '' });
  t.parent = app.level;
  commit(doc => {
    doc.nodes[t.id] = t;
    if (src.kind !== 'region') addEdge(doc, src.id, t.id);
  }, { inspector: false });
  select([t.id]);
  focusName();
}

function deleteSelection() {
  if (app.sel.edge) {
    const id = app.sel.edge;
    commit(doc => { delete doc.edges[id]; });
    return;
  }
  const ids = [...app.sel.nodes].filter(id => app.doc.nodes[id]?.kind !== 'goal' && !app.doc.nodes[id]?.role);
  if (!ids.length) {
    if (selectedNodes().some(n => n.role)) toast('A meta-node’s Input and Output stay as long as the meta-node does.');
    return;
  }
  commit(doc => deleteNodes(doc, ids));
  toast(`Deleted ${ids.length} node${ids.length === 1 ? '' : 's'}`, { action: 'Undo', onAction: undo });
}

function groupSelection() {
  const ids = [...app.sel.nodes].filter(id => app.doc.nodes[id] && app.doc.nodes[id].kind !== 'goal');
  if (!ids.length) return;
  const meta = commit(doc => groupInto(doc, ids, 'New group'), { inspector: false });
  if (meta) { select([meta.id]); focusName(); }
}

function enter(metaId) {
  app.level = metaId;
  app.sel.nodes.clear();
  app.sel.edge = null;
  const fresh = !app.views[metaId];
  render();
  if (fresh) fitView();
  renderInspector();
  scheduleSave();
}

function goUp() {
  if (!app.level) return;
  const was = app.level;
  app.level = app.doc.nodes[was]?.parent || null;
  render();
  select([was]);
  scheduleSave();
}

function navigateTo(id) {
  const n = app.doc.nodes[id];
  if (!n) return;
  const level = n.parent || null;
  if (level !== app.level) { app.level = level; render(); }
  select([id]);
  centerOn(id);
  flash(id);
  scheduleSave();
}

function selectEdge(id) {
  const e = app.doc.edges[id];
  if (!e) return;
  select([], { edge: id });
}

function doUngroup(metaId) {
  const kids = commit(doc => ungroup(doc, metaId), { inspector: false });
  select(kids);
}

function makeSequence(id) {
  const t = app.doc.nodes[id];
  const base = (t.name || 'Step').replace(/\s*\(\d+\/\d+\)$/, '');
  let mode = 'one';
  const body = document.createElement('div');
  body.innerHTML = `<div class="field"><span>Show the steps as</span><div class="seg" id="seq-mode">
      <button type="button" data-m="one" class="on">One node</button><button type="button" data-m="many">Separate nodes</button></div></div>
    <div class="row2"><label class="field"><span>Steps</span><input class="inp" type="number" min="2" max="100" value="${Math.max(2, t.count || 3)}" id="seq-n"></label>
    <label class="field"><span>Name</span><input class="inp" value="${esc(base)}" id="seq-name"></label></div>
    <p class="hint" id="seq-prev" style="margin:0"></p>`;
  const n = body.querySelector('#seq-n');
  const name = body.querySelector('#seq-name');
  const prev = body.querySelector('#seq-prev');
  const upd = () => {
    const k = Math.max(2, Number(n.value) || 2);
    prev.textContent = mode === 'one'
      ? `One task node, “${name.value}”, with ${k} copies done in order (the YAML's sequential keyword). What it unlocks waits for all ${k}.`
      : `${k} task nodes: ${name.value} (1/${k}), ${name.value} (2/${k}), … ${name.value} (${k}/${k}), each requiring the one before. Each step can then have its own description and links. What it unlocks moves to the last step.`;
  };
  body.querySelector('#seq-mode').addEventListener('click', e => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    mode = b.dataset.m;
    for (const x of body.querySelectorAll('[data-m]')) x.classList.toggle('on', x === b);
    upd();
  });
  n.oninput = upd; name.oninput = upd; upd();
  modal('Make a sequence', body, [{ label: 'Cancel' }, {
    label: 'Create', cls: 'primary', onclick: () => {
      const k = Math.min(100, Math.max(2, Number(n.value) || 2));
      const nm = name.value.trim() || base;
      if (mode === 'one') {
        commit(doc => { Object.assign(doc.nodes[id], { name: nm, count: k, sequential: true }); });
        select([id]);
      } else {
        select(commit(doc => sequence(doc, id, k, nm), { inspector: false }));
      }
      return false;
    },
  }]);
}

function sequence(doc, id, k, base) {
  const t = doc.nodes[id];
  const w = (app.sizes.get(id)?.w || WIDTH.task) + 70;
  const outs = Object.values(doc.edges).filter(e => e.from === id && e.kind === 'req');
  const costs = Object.values(doc.edges).filter(e => e.to === id && e.kind === 'cost');
  t.name = `${base} (1/${k})`;
  t.count = 1;
  t.sequential = false;
  const ids = [t.id];
  let prev = t;
  for (let i = 2; i <= k; i++) {
    const c = { ...structuredClone(t), id: newId('t'), name: `${base} (${i}/${k})`, x: t.x + w * (i - 1), combine: 'and' };
    doc.nodes[c.id] = c;
    addEdge(doc, prev.id, c.id);
    for (const e of costs) addEdge(doc, e.from, c.id, 'cost', { ...e.cond });
    ids.push(c.id);
    prev = c;
  }
  for (const e of outs) e.from = prev.id;
  return ids;
}

/**
 * A ladder: two chains of n steps where step k of the second also needs step k of the first.
 * `ids` is one task (the second track is created) or two tasks (A first, or whichever B requires).
 */
function makeLadder(ids) {
  const doc = app.doc;
  let [a, b] = ids.map(id => doc.nodes[id]);
  if (b && Object.values(doc.edges).some(e => e.from === b.id && e.to === a.id)) [a, b] = [b, a];
  else if (b && !Object.values(doc.edges).some(e => e.from === a.id && e.to === b.id) && (b.x < a.x || (b.x === a.x && b.y < a.y))) [a, b] = [b, a];
  const strip = s => (s || '').replace(/\s*\(\d+\/\d+\)$/, '');
  const nameA = strip(a.name) || 'First step';
  const nameB = b ? strip(b.name) : '';
  const n0 = Math.max(2, a.sequential ? a.count : 0, b?.sequential ? b.count : 0, 3);
  const body = document.createElement('div');
  body.innerHTML = `<p class="muted" style="margin-top:0">Two chains of steps. Step <i>k</i> of the second track needs step <i>k</i> of the first, plus the step before it.</p>
    <div class="row2"><label class="field"><span>First track</span><input class="inp" id="lad-a" value="${esc(nameA)}"></label>
    <label class="field"><span>Second track</span><input class="inp" id="lad-b" value="${esc(nameB)}" placeholder="e.g. Fold the laundry"></label></div>
    <div class="row2"><label class="field"><span>Steps</span><input class="inp" type="number" min="2" max="50" id="lad-n" value="${n0}"></label>
    <label class="check" style="align-self:end;margin-bottom:12px"><input type="checkbox" id="lad-g" checked><span>Wrap in a meta-node</span></label></div>
    <p class="hint" id="lad-prev" style="margin:0;white-space:pre-line"></p>`;
  const $b = sel => body.querySelector(sel);
  const upd = () => {
    const k = Math.min(50, Math.max(2, Number($b('#lad-n').value) || 2));
    const A = $b('#lad-a').value || 'First'; const B = $b('#lad-b').value || 'Second';
    $b('#lad-prev').textContent = `${A} (1/${k}) → ${A} (2/${k}) → … → ${A} (${k}/${k})\n${B} (1/${k}) → ${B} (2/${k}) → … → ${B} (${k}/${k})\n${B} (k/${k}) also needs ${A} (k/${k}).`;
  };
  for (const id of ['#lad-a', '#lad-b', '#lad-n']) $b(id).oninput = upd;
  upd();
  modal('Make a ladder', body, [{ label: 'Cancel' }, {
    label: 'Create ladder', cls: 'primary', onclick: () => {
      const k = Math.min(50, Math.max(2, Number($b('#lad-n').value) || 2));
      const A = $b('#lad-a').value.trim() || nameA;
      const B = $b('#lad-b').value.trim() || `${A} follow-up`;
      const all = commit(d => ladder(d, a.id, b?.id || null, k, A, B, $b('#lad-g').checked), { inspector: false });
      select(all);
      return false;
    },
  }]);
}

function ladder(doc, aId, bId, k, nameA, nameB, wrap) {
  const a = doc.nodes[aId];
  const h = app.sizes.get(aId)?.h || 64;
  let b = bId && doc.nodes[bId];
  if (!b) {
    b = makeNode('task', a.x, a.y, { region: a.region });
    b.parent = a.parent;
    doc.nodes[b.id] = b;
  }
  // The rungs replace any direct link between the two tasks.
  for (const [eid, e] of Object.entries(doc.edges)) if (e.kind === 'req' && e.from === a.id && e.to === b.id) delete doc.edges[eid];
  // The second track sits one step to the right, so every rung slants forward.
  b.x = a.x + (app.sizes.get(aId)?.w || WIDTH.task) + 70;
  b.y = a.y + h + 60;
  const top = sequence(doc, a.id, k, nameA);
  const bottom = sequence(doc, b.id, k, nameB);
  top.forEach((id, i) => addEdge(doc, id, bottom[i]));
  const all = [...top, ...bottom];
  if (!wrap) return all;
  const m = groupInto(doc, all, `${nameA} / ${nameB}`);
  return [m.id];
}

/** The selected tasks in chain order if each one requires the one before, else null. */
function chainOf(ids) {
  const doc = app.doc;
  const set = new Set(ids);
  const nodes = ids.map(id => doc.nodes[id]);
  if (nodes.length < 2 || nodes.some(n => !n || n.kind !== 'task')) return null;
  if (nodes.some(n => n.region !== nodes[0].region)) return null;
  const inner = Object.values(doc.edges).filter(e => e.kind === 'req' && set.has(e.from) && set.has(e.to));
  if (inner.length !== nodes.length - 1) return null;
  const next = new Map(inner.map(e => [e.from, e.to]));
  const hasPrev = new Set(inner.map(e => e.to));
  const starts = ids.filter(id => !hasPrev.has(id));
  if (starts.length !== 1 || next.size !== inner.length) return null;
  const order = [starts[0]];
  while (next.has(order[order.length - 1])) order.push(next.get(order[order.length - 1]));
  return order.length === nodes.length ? order : null;
}

/** Chains named "X (1/n)" … "X (n/n)", each requiring the one before (how older imports split sequences). */
function expandedSequences(doc) {
  const groups = new Map();
  for (const n of nodesOf(doc, 'task')) {
    const m = /^(.*) \((\d+)\/(\d+)\)$/.exec(n.name || '');
    if (!m) continue;
    const key = `${m[1]}|${m[3]}|${n.parent || ''}`;
    (groups.get(key) || groups.set(key, []).get(key)).push([Number(m[2]), n.id]);
  }
  const out = [];
  for (const [key, list] of groups) {
    const total = Number(key.split('|')[1]);
    if (list.length !== total || total < 2) continue;
    const order = list.sort((a, b) => a[0] - b[0]).map(x => x[1]);
    const chain = chainOf(order);
    if (chain && chain.join() === order.join() && mergeIsLossless(doc, order)) out.push(order);
  }
  return out;
}

/**
 * Whether merging a chain into one sequential task keeps everything: no links
 * into a middle step or out of an early step (ladder rungs are both), the same
 * costs on every step, and no per-step descriptions that would be dropped.
 */
function mergeIsLossless(doc, order) {
  const set = new Set(order);
  const first = order[0];
  const last = order[order.length - 1];
  for (const e of Object.values(doc.edges)) {
    if (e.kind !== 'req' || (set.has(e.from) && set.has(e.to))) continue;
    if (set.has(e.to) && e.to !== first) return false;
    if (set.has(e.from) && e.from !== last) return false;
  }
  const costKey = id => Object.values(doc.edges).filter(e => e.to === id && e.kind === 'cost')
    .map(e => `${e.from}*${e.cond?.amount || 1}`).sort().join();
  const descs = new Set(order.map(id => (doc.nodes[id].desc || '').trim()));
  return order.every(id => costKey(id) === costKey(first)) && descs.size === 1;
}

function offerSequenceMerge() {
  const found = expandedSequences(app.doc);
  if (!found.length) return;
  toast(`Found ${found.length} sequence${found.length === 1 ? '' : 's'} split into separate steps. Show each as one node?`, {
    action: 'Merge',
    onAction: () => {
      for (const ids of expandedSequences(app.doc)) mergeChain(ids, { quiet: true });
      toast(`Merged ${found.length} sequence${found.length === 1 ? '' : 's'}.`, { action: 'Undo', onAction: undo });
    },
    ms: 8000,
  });
}

function mergeChain(ids, { quiet = false } = {}) {
  const order = chainOf(ids);
  if (!order) return;
  const doc = app.doc;
  const first = doc.nodes[order[0]];
  const last = order[order.length - 1];
  const set = new Set(order);
  const base = (first.name || 'Step').replace(/\s*(\(\d+\/\d+\)|#?\d+)$/, '').trim() || first.name;
  // Links that touch a middle step can only attach to the whole sequence.
  const approx = Object.values(doc.edges).some(e => e.kind === 'req'
    && ((set.has(e.to) && e.to !== first.id && !set.has(e.from)) || (set.has(e.from) && e.from !== last && !set.has(e.to))));
  commit(d => {
    const f = d.nodes[first.id];
    f.name = base;
    f.count = order.reduce((a, id) => a + Math.max(1, d.nodes[id].count || 1), 0);
    f.sequential = true;
    for (const [eid, e] of Object.entries(d.edges)) {
      if (set.has(e.from) && set.has(e.to)) { delete d.edges[eid]; continue; }
      if (set.has(e.from)) e.from = f.id;
      if (set.has(e.to)) {
        if (e.to !== f.id && e.kind === 'cost') { delete d.edges[eid]; continue; }
        e.to = f.id;
      }
    }
    // Drop duplicate links created by the redirect.
    const seen = new Set();
    for (const [eid, e] of Object.entries(d.edges)) {
      const key = `${e.from}|${e.to}|${e.kind}`;
      if (seen.has(key)) delete d.edges[eid]; else seen.add(key);
    }
    for (const id of order.slice(1)) delete d.nodes[id];
  });
  select([first.id]);
  if (!quiet) toast(approx
    ? `Merged into “${base}” with ${order.length} steps in order. Links on middle steps now apply to the whole sequence.`
    : `Merged into “${base}” with ${order.length} steps in order.`, { action: 'Undo', onAction: undo });
}

/**
 * Add a cost to a task from its side panel. `itemId` spends an existing
 * currency; otherwise a new currency item called `name` is created beside the
 * task with enough copies to pay for every copy of the task.
 */
function addCost(taskId, { itemId = '', name = '', amount = 1 } = {}) {
  const amt = Math.min(9999, Math.max(1, Math.round(Number(amount) || 1)));
  commit(doc => {
    const t = doc.nodes[taskId];
    let id = itemId;
    if (!id) {
      const copies = Math.max(1, t.count || 1);
      const near = Object.values(doc.edges).filter(e => e.to === t.id && e.kind === 'cost').length;
      const it = makeNode('item', t.x - WIDTH.item - 90, t.y + near * 80,
        { name: name.trim(), consumable: true, type: 'progression', count: Math.min(999, amt * copies) });
      it.parent = t.parent;
      doc.nodes[it.id] = it;
      id = it.id;
    }
    const old = Object.values(doc.edges).find(e => e.from === id && e.to === t.id && e.kind === 'cost');
    if (old) old.cond = { ...old.cond, amount: amt };
    else addEdge(doc, id, t.id, 'cost', { amount: amt });
  });
}

function setRegion(ids, value) {
  if (value === '__new') {
    const nodes = ids.map(id => app.doc.nodes[id]);
    const r = makeNode('region', Math.min(...nodes.map(n => n.x)) - 300, Math.min(...nodes.map(n => n.y)), { name: 'NewRegion', color: nextRegionColor(app.doc) });
    r.parent = app.level;
    commit(doc => { doc.nodes[r.id] = r; for (const id of ids) doc.nodes[id].region = r.id; }, { inspector: false });
    select([r.id]);
    focusName();
    return;
  }
  commit(doc => { for (const id of ids) doc.nodes[id].region = value; });
}

function setGroup(ids, value) {
  if (value === '__new') {
    const nodes = ids.map(id => app.doc.nodes[id]);
    const g = makeNode('group', Math.min(...nodes.map(n => n.x)) - 300, Math.min(...nodes.map(n => n.y)), { name: 'NewGroup', color: nextRegionColor(app.doc) });
    g.parent = app.level;
    commit(doc => { doc.nodes[g.id] = g; for (const id of ids) { doc.nodes[id].group = g.id; doc.nodes[id].consumable = false; } }, { inspector: false });
    select([g.id]);
    focusName();
    return;
  }
  commit(doc => { for (const id of ids) doc.nodes[id].group = value; });
}

function layoutSelection() {
  const ids = [...app.sel.nodes];
  const nodes = ids.map(id => app.doc.nodes[id]);
  const x0 = Math.min(...nodes.map(n => n.x));
  const y0 = Math.min(...nodes.map(n => n.y));
  commit(doc => {
    layoutLevel(doc, app.level, app.sizes, new Set(ids));
    const nx = Math.min(...nodes.map(n => n.x));
    const ny = Math.min(...nodes.map(n => n.y));
    for (const n of nodes) { n.x += x0 - nx; n.y += y0 - ny; }
  });
}

function tidyLevel() {
  commit(doc => layoutLevel(doc, app.level, app.sizes));
  fitView();
}

function groupByRegion() {
  const level = app.level;
  const regions = childrenOf(app.doc, level).filter(n => n.kind === 'region');
  const plan = regions.map(r => ({ r, tasks: childrenOf(app.doc, level).filter(t => t.kind === 'task' && t.region === r.id) }))
    .filter(p => p.tasks.length);
  if (!plan.length) { toast('No region here has tasks at this level to group.'); return; }
  commit(doc => {
    const metas = plan.map(({ r, tasks }) => groupInto(doc, [r.id, ...tasks.map(t => t.id)], r.name || 'Region'));
    // Items and gates that only feed one region go inside it too.
    const metaIds = new Set(metas.map(m => m.id));
    for (const n of childrenOf(doc, level)) {
      if (n.kind !== 'item' && n.kind !== 'gate') continue;
      const reps = new Set(Object.values(doc.edges).filter(e => e.from === n.id).map(e => repAt(doc, e.to, level)));
      const ins = Object.values(doc.edges).filter(e => e.to === n.id).map(e => repAt(doc, e.from, level));
      const [only] = reps;
      if (reps.size === 1 && metaIds.has(only) && ins.every(x => x === only)) n.parent = only;
    }
    for (const m of metas) layoutLevel(doc, m.id, app.sizes);
    layoutLevel(doc, level, app.sizes);
  });
  fitView();
  toast(`Made ${plan.length} meta-node${plan.length === 1 ? '' : 's'}, one per region`, { action: 'Undo', onAction: undo });
}

// ------------------------------------------------------------------ modes

function setMode(mode) {
  if (app.mode.type === 'move' && mode.type !== 'move') app.history.close();
  app.mode = mode;
  canvas.style.cursor = mode.type === 'place' ? 'crosshair' : mode.type === 'move' ? 'move' : mode.type === 'link' || mode.type === 'assign' ? 'alias' : '';
  for (const b of document.querySelectorAll('[data-place]')) b.classList.toggle('active', mode.type === 'place' && mode.kind === b.dataset.place);
  const bar = $('modebar');
  const text = {
    place: () => `Click the canvas to place the ${mode.kind.startsWith('gate') ? `${mode.kind.slice(5).toUpperCase()} gate` : mode.kind === 'group' ? 'item group' : mode.kind}`,
    link: () => (mode.dir === 'out' ? `Click each node that ${linkSubject()} unlocks` : `Click each node that ${linkSubject()} requires`),
    move: () => 'Glide to the new spot, then click to drop',
    assign: () => `Click ${app.doc.nodes[mode.target]?.kind === 'region' ? 'tasks' : 'items'} to add to or remove from ${nodeTitle(app.doc.nodes[mode.target])}`,
  }[mode.type];
  bar.classList.toggle('on', !!text);
  $('modebar-text').textContent = text ? text() : '';
  if (mode.type !== 'link') setRubber(null);
  render();
}

const linkSubject = () => {
  const ids = app.mode.ids || [];
  return ids.length === 1 ? `“${nodeTitle(app.doc.nodes[ids[0]])}”` : `the ${ids.length} selected nodes`;
};

function startLink(dir, ids = [...app.sel.nodes]) {
  ids = ids.filter(id => app.doc.nodes[id]);
  if (!ids.length) { toast('Select a node first.'); return; }
  if (dir === 'out' && !ids.some(id => SOURCE_KINDS.has(app.doc.nodes[portFor(app.doc, id, 'output')].kind))) { toast('That node cannot unlock anything.'); return; }
  select(ids);
  setMode({ type: 'link', dir, ids });
}

function linkTo(id) {
  const doc = app.doc;
  const made = [];
  const errs = new Set();
  commit(d => {
    for (const s of app.mode.ids) {
      const [end, start] = app.mode.dir === 'out' ? [id, s] : [s, id];
      // A link to a meta-node goes to its Input; a link from one starts at its Output.
      const from = portFor(d, start, 'output');
      const to = portFor(d, end, 'input');
      const a = d.nodes[from];
      const b = d.nodes[to];
      const asCost = a?.kind === 'item' && a.consumable && b?.kind === 'task';
      const why = edgeProblem(d, a, b, asCost ? 'cost' : 'req');
      if (why) { errs.add(why); continue; }
      made.push(addEdge(d, from, to, asCost ? 'cost' : 'req'));
    }
  }, { inspector: false });
  if (!made.length) app.history.past.pop();
  if (errs.size) toast([...errs].join(' '));
  else if (made.some(e => e.kind === 'cost')) toast('Linked as a cost (spend 1). Select the link to change it.');
  renderInspector();
  flash(doc.nodes[id] ? id : '');
}

function startMove(ids = [...app.sel.nodes]) {
  ids = ids.filter(id => app.doc.nodes[id] && frame.boxes.has(id));
  if (!ids.length) return;
  app.history.record(app.doc, `move${Date.now()}`);
  const orig = new Map(ids.map(id => [id, { x: app.doc.nodes[id].x, y: app.doc.nodes[id].y }]));
  setMode({ type: 'move', ids, start: { ...app.pointer }, orig });
  for (const id of ids) $('nodes').querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('moving');
}

function finishMove(cancel = false) {
  const m = app.mode;
  if (cancel) for (const [id, p] of m.orig) Object.assign(app.doc.nodes[id], p);
  if (cancel) app.history.past.pop();
  setMode({ type: 'idle' });
  scheduleSave();
  scheduleValidate();
  updateUndo();
}

function startAssign(target) {
  setMode({ type: 'assign', target });
}

function toggleAssign(id) {
  const t = app.doc.nodes[app.mode.target];
  const n = app.doc.nodes[id];
  if (!t || !n) return;
  if (t.kind === 'region' && n.kind === 'task') commit(() => { n.region = n.region === t.id ? '' : t.id; }, { inspector: false });
  else if (t.kind === 'group' && n.kind === 'item') commit(() => { n.group = n.group === t.id ? '' : t.id; if (n.group) n.consumable = false; }, { inspector: false });
  else toast(t.kind === 'region' ? 'Only tasks join regions.' : 'Only items join item groups.');
}

function cancelMode() {
  if (app.mode.type === 'move') finishMove(true);
  else setMode({ type: 'idle' });
  renderInspector();
}

// ------------------------------------------------------------------ action bar

const ACT_ICON = { 'link-out': 'arrow-right', 'link-in': 'arrow-left', next: 'list-plus', move: 'move', delete: 'trash-2', enter: 'folder-open', ungroup: 'ungroup', group: 'group' };
const btn = (act, label, kbd = '', tip = '') => `<button class="btn" data-act="${act}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${icon(ACT_ICON[act])}${label ? `<span>${label}</span>` : ''}${kbd ? ` <kbd>${kbd}</kbd>` : ''}</button>`;
setActionBarContent(ids => {
  const nodes = ids.map(id => app.doc.nodes[id]).filter(Boolean);
  if (!nodes.length) return '';
  if (nodes.length > 1) {
    return btn('link-out', 'Unlocks…', 'L') + btn('link-in', 'Requires…', '⇧L') + btn('group', 'Group', 'G') + btn('move', 'Move', 'M') + btn('delete', '', '', 'Delete');
  }
  const n = nodes[0];
  switch (n.kind) {
    case 'meta': return btn('link-out', 'Unlocks…', 'L') + btn('link-in', 'Requires…', '⇧L') + btn('enter', 'Open', '↵') + btn('move', 'Move', 'M') + btn('ungroup', 'Ungroup') + btn('delete', '', '', 'Delete with contents');
    case 'gate': if (n.role) return btn('link-out', 'Unlocks…', 'L') + btn('link-in', 'Requires…', '⇧L') + btn('move', 'Move', 'M');
      return btn('link-out', 'Unlocks…', 'L') + btn('link-in', 'Requires…', '⇧L') + btn('next', 'Next', 'N') + btn('move', 'Move', 'M') + btn('delete', '', '', 'Delete');
    case 'goal': return btn('link-in', 'Requires…', '⇧L') + btn('move', 'Move', 'M');
    case 'note': return btn('move', 'Move', 'M') + btn('delete', '', '', 'Delete');
    case 'item': return btn('link-out', 'Unlocks…', 'L') + btn('next', 'Next task', 'N') + btn('move', 'Move', 'M') + btn('delete', '', '', 'Delete');
    default: return btn('link-out', 'Unlocks…', 'L') + btn('link-in', 'Requires…', '⇧L') + btn('next', 'Next', 'N') + btn('move', 'Move', 'M') + btn('delete', '', '', 'Delete');
  }
});

$('actionbar').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  e.stopPropagation();
  const id = [...app.sel.nodes][0];
  ({
    'link-out': () => startLink('out'), 'link-in': () => startLink('in'), group: groupSelection,
    move: () => startMove(), delete: deleteSelection, enter: () => enter(id), ungroup: () => doUngroup(id), next: nextTask,
  })[b.dataset.act]?.();
});

// ------------------------------------------------------------------ canvas input

// Zoom eases toward a target level, so pinches and wheel notches glide instead of jumping.
const ZOOM_MIN = 0.12;
const ZOOM_MAX = 2.5;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let zoomTarget = null;
let zoomFrame = 0;
// Fit, jump-to-node and level changes set the view directly; a pending glide then stops.
const zoomStale = () => zoomTarget && (zoomTarget.view !== view() || Math.abs(view().k - zoomTarget.lastK) > 1e-9);
function smoothZoom(sx, sy, factor) {
  if (zoomStale()) zoomTarget = null;
  const v = view();
  const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (zoomTarget ? zoomTarget.k : v.k) * factor));
  if (reducedMotion.matches) { zoomAt(sx, sy, k / v.k); scheduleSave(); return; }
  zoomTarget = { k, sx, sy, view: v, lastK: v.k };
  if (!zoomFrame) zoomFrame = requestAnimationFrame(zoomStep);
}
function zoomStep() {
  zoomFrame = 0;
  if (zoomStale()) zoomTarget = null;
  const t = zoomTarget;
  if (!t) return;
  const v = view();
  const next = v.k + (t.k - v.k) * 0.3;
  const done = Math.abs(t.k - next) < 0.002;
  zoomAt(t.sx, t.sy, (done ? t.k : next) / v.k);
  t.lastK = v.k;
  if (done) { zoomTarget = null; scheduleSave(); } else zoomFrame = requestAnimationFrame(zoomStep);
}
const zoomCenter = factor => {
  const r = canvas.getBoundingClientRect();
  smoothZoom(r.left + r.width / 2, r.top + r.height / 2, factor);
};

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  if (e.ctrlKey || e.metaKey) {
    // A trackpad pinch sends many small deltas; a mouse notch one big one. Cap each event.
    const d = Math.max(-40, Math.min(40, e.deltaY * scale));
    smoothZoom(e.clientX, e.clientY, Math.exp(-d * 0.004));
  } else {
    const v = view();
    v.x -= e.deltaX * scale;
    v.y -= e.deltaY * scale;
    applyTransform();
  }
  scheduleSave();
}, { passive: false });

// Safari pinch.
let gestureK = 1;
canvas.addEventListener('gesturestart', e => { e.preventDefault(); gestureK = 1; });
canvas.addEventListener('gesturechange', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.scale / gestureK); gestureK = e.scale; });

canvas.addEventListener('pointermove', e => {
  app.pointer = screenToWorld(e.clientX, e.clientY);
  const m = app.mode;
  if (m.type === 'move') {
    const dx = app.pointer.x - m.start.x;
    const dy = app.pointer.y - m.start.y;
    for (const [id, p] of m.orig) {
      const n = app.doc.nodes[id];
      n.x = Math.round((p.x + dx) / 10) * 10;
      n.y = Math.round((p.y + dy) / 10) * 10;
    }
    syncPositions(m.orig.keys());
  } else if (m.type === 'link') {
    const b = frame.boxes.get(m.ids[0]);
    if (b) setRubber(m.dir === 'out' ? { x: b.x + b.w, y: b.y + b.h / 2 } : app.pointer, m.dir === 'out' ? app.pointer : { x: b.x, y: b.y + b.h / 2 });
  }
});

// Optional dragging: drag a node (or the selection it belongs to) to move it, or drag
// empty canvas to pan. A press that barely moves is still a click.
const DRAG_START = 5;
let press = null;
let suppressClick = false;

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || app.mode.type !== 'idle') return;
  const t = targetOf(e);
  if (t.ui || t.edge || t.ghost) return;
  press = { id: e.pointerId, sx: e.clientX, sy: e.clientY, node: t.node || null, shift: e.shiftKey, dragging: false };
  // Keep the press from starting a text selection; blur any field so typing stops there.
  e.preventDefault();
  document.activeElement?.blur?.();
  app.pressing = true;
  $('actionbar').hidden = true;
});

canvas.addEventListener('pointermove', e => {
  if (!press || e.pointerId !== press.id) return;
  const dx = e.clientX - press.sx;
  const dy = e.clientY - press.sy;
  if (!press.dragging) {
    if (Math.hypot(dx, dy) < DRAG_START) return;
    press.dragging = true;
    canvas.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    getSelection()?.removeAllRanges();
    if (press.node) {
      if (!app.sel.nodes.has(press.node)) select([press.node], { add: press.shift });
      const ids = [...app.sel.nodes].filter(id => frame.boxes.has(id));
      app.history.record(app.doc, `drag${Date.now()}`);
      press.orig = new Map(ids.map(id => [id, { x: app.doc.nodes[id].x, y: app.doc.nodes[id].y }]));
      for (const id of ids) $('nodes').querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('moving');
    } else {
      const v = view();
      press.view = { x: v.x, y: v.y };
      canvas.style.cursor = 'grabbing';
    }
  }
  if (press.orig) {
    const k = view().k;
    for (const [id, p] of press.orig) {
      const n = app.doc.nodes[id];
      n.x = Math.round((p.x + dx / k) / 10) * 10;
      n.y = Math.round((p.y + dy / k) / 10) * 10;
    }
    syncPositions(press.orig.keys());
  } else {
    const v = view();
    v.x = press.view.x + dx;
    v.y = press.view.y + dy;
    applyTransform();
  }
});

function endPress(e) {
  if (!press || e.pointerId !== press.id) return;
  app.pressing = false;
  if (press.dragging) {
    suppressClick = true;
    document.body.classList.remove('dragging');
    canvas.style.cursor = '';
    if (press.orig) {
      for (const id of press.orig.keys()) $('nodes').querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.remove('moving');
      app.history.close();
      updateUndo();
      scheduleValidate();
      positionActionBar();
    }
    scheduleSave();
  }
  press = null;
  positionActionBar();
}
window.addEventListener('pointerup', endPress);
window.addEventListener('pointercancel', endPress);

function targetOf(e) {
  const nodeEl = e.target.closest('.node');
  if (nodeEl) return nodeEl.dataset.id ? { node: nodeEl.dataset.id } : { ghost: nodeEl.dataset.ghost };
  const edgeEl = e.target.closest('[data-edge]');
  if (edgeEl) return { edge: edgeEl.dataset.edge };
  if (e.target.closest('.crumbs, .zoombar, .statusbar, .problems, .actionbar, .modebar, .empty-card')) return { ui: true };
  return {};
}

canvas.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }
  const t = targetOf(e);
  if (t.ui) return;
  const m = app.mode;
  if (m.type === 'move') { finishMove(); return; }
  if (m.type === 'place') {
    const p = screenToWorld(e.clientX, e.clientY);
    setMode({ type: 'idle' });
    placeNode(m.kind, p.x, p.y);
    return;
  }
  if (m.type === 'link') {
    const id = t.node || t.ghost;
    if (id) linkTo(id);
    else cancelMode();
    return;
  }
  if (m.type === 'assign') {
    if (t.node) toggleAssign(t.node);
    else cancelMode();
    return;
  }
  if (t.node && e.target.closest('.node.meta .open')) { enter(t.node); return; }
  if (t.node) select([t.node], { add: e.shiftKey });
  else if (t.ghost) navigateTo(t.ghost);
  else if (t.edge) {
    selectEdge(t.edge);
    const label = e.target.closest('.elabel');
    if (label && label.textContent && !/links$/.test(label.textContent)) editLabel(t.edge, label);
  }
  else if (!e.shiftKey) select([]);
});

/** The number a link's label shows, as an editable field: { value, min, max, set(v) }, or null. */
function edgeNumber(doc, e) {
  const a = doc.nodes[e.from];
  const c = e.cond || {};
  if (!a) return null;
  if (e.kind === 'cost') return { value: c.amount || 1, min: 1, max: 9999, set: v => { c.amount = v; } };
  if (a.kind === 'item') return { value: c.copies || 1, min: 1, max: Math.max(1, a.count || 1), set: v => { c.copies = v; } };
  if (a.kind === 'region') {
    if (c.mode === 'count') return { value: c.n, min: 1, max: 9999, set: v => { c.n = v; } };
    // A default share that is edited becomes an explicit percent.
    const value = c.mode === 'pct' ? c.n : a.pct ?? 100;
    return { value, min: 0, max: 100, set: v => { if (c.mode === 'pct' || v !== value) { c.mode = 'pct'; c.n = v; } } };
  }
  if (a.kind === 'group' && c.mode !== 'next' && c.mode !== 'default') {
    return { value: c.n || 1, min: c.mode === 'pct' ? 0 : 1, max: c.mode === 'pct' ? 100 : 9999, set: v => { c.n = v; } };
  }
  return null;
}

/** Turn a link label into a number field in place: Enter or clicking away saves, Esc cancels. */
function editLabel(edgeId, label) {
  const e = app.doc.edges[edgeId];
  const num = e && edgeNumber(app.doc, e);
  if (!num) return;
  const fresh = $('nodes').querySelector(`.elabel[data-edge="${CSS.escape(edgeId)}"]`) || label;
  const input = Object.assign(document.createElement('input'), {
    type: 'number', className: 'elabel-edit', value: num.value, min: num.min, max: num.max,
  });
  input.style.left = fresh.style.left;
  input.style.top = fresh.style.top;
  fresh.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    const v = Math.round(Number(input.value));
    if (save && input.value !== '' && Number.isFinite(v) && v !== num.value) {
      commit(d => { const de = d.edges[edgeId]; if (de) edgeNumber(d, de).set(Math.min(num.max, Math.max(num.min, v))); });
    } else render();
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// Right-click ends a click mode (linking, placing, moving, adding members), like Esc.
document.addEventListener('contextmenu', e => {
  if (app.mode.type === 'idle') return;
  e.preventDefault();
  cancelMode();
});

canvas.addEventListener('dblclick', e => {
  if (app.mode.type !== 'idle') return;
  const t = targetOf(e);
  if (t.ui) return;
  if (t.node) {
    const n = app.doc.nodes[t.node];
    if (n?.kind === 'meta') enter(n.id);
    else focusName();
  } else if (!t.edge && !t.ghost) {
    const p = screenToWorld(e.clientX, e.clientY);
    placeNode('task', p.x, p.y);
  }
});

$('crumbs').addEventListener('click', e => {
  const b = e.target.closest('[data-level]');
  if (!b || b.classList.contains('here')) return;
  const target = b.dataset.level || null;
  const from = app.level;
  app.level = target;
  render();
  // Select the meta-node we came out of, at the level we went to.
  const chain = [from, ...ancestors(app.doc, from)];
  const here = chain.find(id => (app.doc.nodes[id]?.parent || null) === target);
  select(here ? [here] : []);
  scheduleSave();
});

$('modebar-done').addEventListener('click', e => { e.stopPropagation(); cancelMode(); });

for (const b of document.querySelectorAll('[data-place]')) {
  b.addEventListener('click', () => {
    if (app.mode.type === 'place' && app.mode.kind === b.dataset.place) setMode({ type: 'idle' });
    else setMode({ type: 'place', kind: b.dataset.place });
  });
}

// ------------------------------------------------------------------ keyboard

const PLACE_KEYS = { t: 'task', i: 'item', r: 'region', p: 'group', a: 'gate-and', o: 'gate-or' };

document.addEventListener('keydown', e => {
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    if (modalOpen()) { closeModal(); return; }
    if (typing) { e.target.blur(); return; }
    if ($('problems').classList.contains('open')) { $('problems').classList.remove('open'); return; }
    if (app.mode.type !== 'idle') { cancelMode(); return; }
    if (app.sel.nodes.size || app.sel.edge) { select([]); return; }
    goUp();
    return;
  }
  if (modalOpen()) return;
  if (mod && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveGraphFile(); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); select(childrenOf(app.doc, app.level).map(n => n.id)); return; }
  if (mod) return;
  const k = e.key;
  if (k === '/') { e.preventDefault(); $('search').focus(); return; }
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
  if (k === 'Enter') {
    e.preventDefault();
    const n = selectedNodes()[0];
    if (n?.kind === 'meta') enter(n.id); else if (n) focusName();
    return;
  }
  if (k.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 100 : 20;
    const [dx, dy] = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k];
    const ids = [...app.sel.nodes];
    if (ids.length) {
      commit(doc => { for (const id of ids) { doc.nodes[id].x += dx * step; doc.nodes[id].y += dy * step; } }, { key: 'nudge', inspector: false, render: false });
      syncPositions(ids);
    } else {
      const v = view();
      v.x -= dx * step * 3;
      v.y -= dy * step * 3;
      applyTransform();
    }
    return;
  }
  const lk = k.toLowerCase();
  // Shortcuts may move focus into the inspector; keep the key out of that field.
  if ('lnmgf0+=-_'.includes(lk) || PLACE_KEYS[lk]) e.preventDefault();
  if (lk === 'l') { startLink(e.shiftKey ? 'in' : 'out'); return; }
  if (lk === 'n') { nextTask(); return; }
  if (lk === 'm') { startMove(); return; }
  if (lk === 'g') { groupSelection(); return; }
  if (lk === 'f') { fitView(); return; }
  if (k === '0') { zoomCenter(1 / (zoomTarget ? zoomTarget.k : view().k)); return; }
  if (k === '+' || k === '=') { zoomCenter(1.2); return; }
  if (k === '-' || k === '_') { zoomCenter(1 / 1.2); return; }
  if (PLACE_KEYS[lk]) { setMode({ type: 'place', kind: PLACE_KEYS[lk] }); }
});

// ------------------------------------------------------------------ search

const sr = $('search-results');
let srActive = 0;
let srList = [];
function runSearch() {
  const q = $('search').value.trim().toLowerCase();
  if (!q) { sr.classList.remove('open'); return; }
  srList = Object.values(app.doc.nodes)
    .map(n => ({ n, t: nodeTitle(n).toLowerCase() }))
    .filter(x => x.t.includes(q) || (x.n.desc || '').toLowerCase().includes(q))
    .sort((a, b) => (b.t.startsWith(q) - a.t.startsWith(q)) || a.t.localeCompare(b.t))
    .slice(0, 9).map(x => x.n);
  srActive = 0;
  sr.innerHTML = srList.length ? srList.map((n, i) => {
    const where = ancestors(app.doc, n.id).map(id => app.doc.nodes[id]?.name).reverse().join(' › ');
    return `<div class="sr-item${i === 0 ? ' active' : ''}" data-i="${i}"><span class="faint small">${esc(n.kind)}</span>${esc(nodeTitle(n))}<span class="sr-where">${esc(where)}</span></div>`;
  }).join('') : '<div class="sr-item faint">No matches</div>';
  sr.classList.add('open');
}
$('search').addEventListener('input', runSearch);
$('search').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    srActive = (srActive + (e.key === 'ArrowDown' ? 1 : -1) + srList.length) % Math.max(1, srList.length);
    sr.querySelectorAll('.sr-item').forEach((el, i) => el.classList.toggle('active', i === srActive));
  } else if (e.key === 'Enter' && srList[srActive]) {
    navigateTo(srList[srActive].id);
    $('search').blur();
  }
});
$('search').addEventListener('blur', () => setTimeout(() => sr.classList.remove('open'), 150));
sr.addEventListener('mousedown', e => {
  const it = e.target.closest('[data-i]');
  if (it) { navigateTo(srList[Number(it.dataset.i)].id); $('search').blur(); }
});

// ------------------------------------------------------------------ files

async function download(name, text, type = 'text/yaml') {
  // Hosted on claude.ai, the page saves through the viewer's downloads capability,
  // which does not accept .yaml: the file is offered as .yaml.txt instead.
  if (window.claude?.use) {
    const dl = await window.claude.use('downloads').catch(() => null);
    if (dl) {
      const yaml = name.endsWith('.yaml');
      try {
        await dl.save({ filename: yaml ? `${name}.txt` : name, data: text });
        if (yaml) toast(`Saved as ${name}.txt. Rename it to ${name} for Archipelago.`, { ms: 6000 });
      } catch (e) {
        if (e?.code !== 'declined') toast('This view cannot save files. Use Copy YAML instead.');
      }
      return;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeName = s => (s || 'taskipelago').replace(/[^\w\-. ]+/g, '_').trim() || 'taskipelago';

function saveGraphFile() {
  download(`${safeName(app.doc.settings.playerName)}.graph.json`, JSON.stringify(app.doc, null, 1), 'application/json');
  toast('Saved the graph file. Open it here later to keep editing.');
}

async function openFile(file) {
  const text = await file.text();
  let doc = null;
  let messages = [];
  let restored = false;
  try {
    if (/^\s*\{/.test(text)) {
      doc = normalizeDoc(JSON.parse(text));
      restored = true;
    } else {
      ({ doc, messages, restored } = await importYaml(text));
    }
  } catch (e) {
    modal('Could not open the file', `<p style="white-space:pre-wrap">${esc(e.message)}</p>`);
    return;
  }
  if (!doc) {
    modal('Could not open the file', messages.map(m => `<p style="white-space:pre-wrap">${esc(m.msg)}</p>`).join(''));
    return;
  }
  app.emptyDismissed = true;
  app.views = {};
  app.level = null;
  replaceDoc(doc);
  fitView();
  const notes = messages.filter(m => m.level === 'warning');
  const tasks = nodesOf(doc, 'task').length;
  const msg = `Opened ${file.name}: ${tasks} task${tasks === 1 ? '' : 's'}${restored ? ', layout restored' : ''}.`;
  if (notes.length) {
    toast(`${msg} ${notes.length} import note${notes.length === 1 ? '' : 's'}.`, {
      action: 'Show',
      onAction: () => modal('Import notes', notes.map(m => `<p style="white-space:pre-wrap">${esc(m.msg)}</p>`).join('')),
    });
  } else if (!restored && nodesOf(doc, 'region').length > 1 && tasks > 30) {
    toast(msg, { action: 'Group by region', onAction: groupByRegion });
  } else toast(`${msg} Undo returns to the previous graph.`);
  if (restored) setTimeout(offerSequenceMerge, 3500);
}

$('file-input').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) openFile(f);
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

async function exportFlow() {
  const res = await exportYaml(app.doc);
  app.validation = res;
  renderStatus();
  if (!res.ok) {
    renderProblems();
    $('problems').classList.add('open');
    toast('Fix the problems listed first.');
    return;
  }
  const text = await withEmbeddedLayout(res.text, app.doc);
  const notes = res.problems.filter(p => p.level === 'warning');
  const body = document.createElement('div');
  body.innerHTML = (notes.length ? `<div style="margin-bottom:12px">${notes.map(p =>
    `<div class="prob warning" style="border:1px solid var(--line);border-radius:8px;margin-bottom:6px"><span class="ic">${icon('triangle-alert')}</span><div><div class="pt">${esc(p.title || 'Note')}</div><div class="pm">${esc(p.msg)}</div></div></div>`).join('')}</div>` : '')
    + `<pre>${esc(res.text)}</pre><p class="hint faint" style="margin:8px 0 0">The download also carries this graph's layout in a trailing comment; Taskipelago ignores it.</p>`;
  const name = `${safeName(app.doc.settings.playerName)}.yaml`;
  modal(`Export ${name}`, body, [
    {
      label: 'Copy YAML',
      onclick: async m => {
        try {
          await navigator.clipboard.writeText(res.text);
          toast('Copied.');
        } catch (_) {
          getSelection().selectAllChildren(m.querySelector('pre'));
          toast('Copying is blocked here. The YAML is selected: press Ctrl+C.');
        }
        return true;
      },
    },
    { label: 'Download', cls: 'primary', onclick: () => { download(name, text); } },
  ], { wide: true });
}

// ------------------------------------------------------------------ toolbar

$('b-undo').onclick = undo;
$('b-redo').onclick = redo;
$('b-open').onclick = () => $('file-input').click();
$('b-save').onclick = saveGraphFile;
$('b-export').onclick = exportFlow;
$('b-settings').onclick = settingsDialog;
$('b-help').onclick = helpDialog;
$('b-layout').onclick = tidyLevel;
$('b-byregion').onclick = groupByRegion;
$('b-new').onclick = async () => {
  if (!(await confirmDialog('New graph', 'Start over with an empty graph? Undo can bring this one back.', 'Start over'))) return;
  app.views = {};
  app.level = null;
  app.emptyDismissed = false;
  replaceDoc(emptyDoc());
};
$('b-theme').onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  scheduleSave();
};
$('z-in').onclick = () => zoomCenter(1.2);
$('z-out').onclick = () => zoomCenter(1 / 1.2);
$('z-level').onclick = () => zoomCenter(1 / (zoomTarget ? zoomTarget.k : view().k));
$('z-fit').onclick = () => fitView();
$('status-pill').onclick = () => { renderProblems(); $('problems').classList.toggle('open'); };
$('problems').addEventListener('click', e => {
  if (e.target.closest('[data-close-problems]')) { $('problems').classList.remove('open'); return; }
  const a = e.target.closest('[data-goto]');
  if (a) navigateTo(a.dataset.goto);
});
$('es-example').onclick = () => { app.emptyDismissed = true; app.views = {}; replaceDoc(exampleDoc()); fitView(); };
$('es-open').onclick = () => $('file-input').click();
$('es-blank').onclick = () => { app.emptyDismissed = true; render(); };
window.addEventListener('resize', () => positionActionBar());

initInspector({
  navigateTo, selectEdge, startLink, makeSequence, enter, ungroup: doUngroup, deleteSelection, groupSelection,
  layoutSelection, setRegion, setGroup, openSettings: settingsDialog,
  selectOnly: id => select([id]), assignSelectionTo: startAssign, chainOf, mergeChain, makeLadder,
  mergeIsLossless: ids => { const order = chainOf(ids); return !!order && mergeIsLossless(app.doc, order); },
  addCost,
});

// ------------------------------------------------------------------ boot

fillIcons();

const had = loadSaved();
app.emptyDismissed = had;
render();
renderInspector();
if (!app.views[app.level || 'root']) fitView();
else applyTransform();
updateUndo();
scheduleValidate();
window.__app = app; // for tests and the console
drawEdges();
if (had) setTimeout(offerSequenceMerge, 600);
