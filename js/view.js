// Canvas rendering: nodes as HTML cards, edges as SVG curves, for one level of
// the meta-node tree. Edges that cross into a collapsed meta-node attach to it;
// inside a meta-node, outside endpoints appear as ghost nodes at the edges.

import {
  ancestors, childrenOf, condLabel, descendants, nodeTitle, repAt, WIDTH,
} from './graph.js';
import { app, view } from './store.js';
import { icon } from './icons.js';

const $ = id => document.getElementById(id);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TYPE_COLOR = { progression: 'var(--t-prog)', useful: 'var(--t-useful)', junk: 'var(--t-junk)', trap: 'var(--t-trap)' };

// Geometry of the current frame, for edges, hit tests and the action bar.
export const frame = { boxes: new Map(), ghosts: new Map(), drawn: [] };

function regionColor(doc, id) {
  return doc.nodes[id]?.color || '';
}

function taskSub(doc, n) {
  const parts = [];
  const r = doc.nodes[n.region];
  if (r) parts.push(`<span class="chip"><span class="dot" style="background:${esc(r.color || 'var(--faint)')}"></span>${esc(r.name || 'region')}</span>`);
  const costs = Object.values(doc.edges).filter(e => e.to === n.id && e.kind === 'cost').length;
  if (costs || n.extraCost) parts.push('<span class="chip" style="color:var(--gold)">◈ cost</span>');
  if (n.sequential && n.count > 1) parts.push(`<span class="chip">${n.count} steps in order</span>`);
  if (n.combine === 'or') parts.push('<span class="chip">any of</span>');
  if (n.priority) parts.push('<span class="chip">priority</span>');
  if (n.extraPrereq || n.extraItemPrereq) parts.push('<span class="chip">+ text rule</span>');
  return parts.join('');
}

function itemSub(doc, n) {
  if (n.filler) return '<span>filler</span>';
  const parts = [];
  const g = doc.nodes[n.group];
  parts.push(`<span>${n.consumable ? 'currency' : esc(effectiveType(doc, n))}</span>`);
  if (g && !n.consumable) parts.push(`<span class="chip"><span class="dot" style="background:${esc(g.color || 'var(--t-prog)')}"></span>${esc(g.name || 'group')}</span>`);
  if (n.early) parts.push('<span>early</span>');
  return parts.join('');
}

export function effectiveType(doc, n) {
  if (n.filler) return 'junk';
  if (n.consumable) return 'progression';
  const g = doc.nodes[n.group];
  if (g && g.gtype === 'progressive') return 'progression';
  return n.type || 'useful';
}

function nodeHtml(doc, n, cls = '') {
  const title = esc(nodeTitle(n));
  const emptyCls = (n.kind !== 'gate' && n.kind !== 'goal' && n.kind !== 'note' && !(n.name || '').trim()) ? ' empty' : '';
  const w = WIDTH[n.kind] || 200;
  const style = [`left:${n.x}px`, `top:${n.y}px`, `width:${w}px`];
  let body = '';
  switch (n.kind) {
    case 'task': {
      const rc = regionColor(doc, n.region);
      if (rc) style.push(`--rc:${rc}`);
      const badge = n.count > 1 ? `<span class="n-badge">${n.sequential ? `1→${n.count}` : `×${n.count}`}</span>` : '';
      body = `<div class="n-head"><span class="n-icon">${icon(n.sequential && n.count > 1 ? 'list-ordered' : 'circle-check')}</span><span class="n-title${emptyCls}">${title}</span>${badge}</div>`
        + (n.desc ? `<div class="n-sub" style="padding-bottom:2px">${taskSub(doc, n)}</div><div class="n-desc" style="margin-top:0">${esc(n.desc)}</div>`
          : `<div class="n-sub">${taskSub(doc, n) || '<span class="faint">task</span>'}</div>`);
      break;
    }
    case 'item': {
      const t = effectiveType(doc, n);
      style.push(`--tc:${TYPE_COLOR[t] || TYPE_COLOR.useful}`);
      if (n.consumable) cls += ' consumable';
      if (n.filler) cls += ' filler';
      const badge = n.count > 1 ? `<span class="n-badge">×${n.count}</span>` : '';
      body = `<div class="n-head"><span class="n-icon">${icon(n.consumable ? 'coins' : 'gem')}</span><span class="n-title${emptyCls}">${n.filler ? 'Filler' : title}</span>${badge}</div>`
        + `<div class="n-sub">${itemSub(doc, n)}</div>`;
      break;
    }
    case 'region': {
      if (n.color) style.push(`--rc:${n.color}`);
      const members = Object.values(doc.nodes).filter(t => t.kind === 'task' && t.region === n.id);
      const slots = members.reduce((a, t) => a + (t.count || 1), 0);
      const extra = [];
      if (n.parentRegion && doc.nodes[n.parentRegion]) extra.push(`in ${esc(doc.nodes[n.parentRegion].name)}`);
      if (n.randomOn) extra.push(`pick ${esc(n.randomPick || '?')}`);
      if (n.randomOrder) extra.push('shuffled');
      if (n.disabled) extra.push('<b style="color:var(--danger)">disabled</b>');
      if (n.combine === 'or') extra.push('any of');
      body = `<div class="n-head"><span class="n-icon">${icon('map')}</span><span class="n-title${emptyCls}">${title}</span><span class="n-badge">${n.pct ?? 100}%</span></div>`
        + `<div class="n-sub"><span>${slots} task${slots === 1 ? '' : 's'}</span>${extra.map(x => `<span>${x}</span>`).join('')}</div>`;
      break;
    }
    case 'group': {
      if (n.color) style.push(`--rc:${n.color}`);
      const members = Object.values(doc.nodes).filter(i => i.kind === 'item' && i.group === n.id && !i.consumable && !i.filler);
      const copies = members.reduce((a, i) => a + (i.count || 1), 0);
      const extra = [];
      if (n.gtype === 'random-choice') extra.push(`pick ${esc(n.pick || '?')}`);
      if (n.parentGroup && doc.nodes[n.parentGroup]) extra.push(`in ${esc(doc.nodes[n.parentGroup].name)}`);
      if (n.disabled) extra.push('<b style="color:var(--danger)">disabled</b>');
      body = `<div class="n-head"><span class="n-icon">${icon('layers')}</span><span class="n-title${emptyCls}">${title}</span></div>`
        + `<div class="n-sub"><span>${esc(n.gtype)}</span><span>${copies} item${copies === 1 ? '' : 's'}</span>${extra.map(x => `<span>${x}</span>`).join('')}</div>`;
      break;
    }
    case 'gate':
      cls += ` ${n.op}`;
      if (n.role) {
        // A meta-node's Input / Output: what comes in from outside, what the group hands on.
        cls += ' port';
        style[2] = 'width:170px';
        const ins = Object.values(doc.edges).filter(e => e.to === n.id).length;
        const rule = n.role === 'output' && !ins ? 'every task inside'
          : !ins ? 'nothing yet' : ins === 1 ? '1 link' : `${n.op === 'and' ? 'all' : 'any'} of ${ins}`;
        body = `${icon(n.role === 'input' ? 'log-in' : 'log-out')}<span class="pt">${n.role === 'input' ? 'Input' : 'Output'}</span><span class="pr">${esc(rule)}</span>`;
        break;
      }
      body = `${icon(n.op === 'and' ? 'ampersand' : 'split')}<span>${n.op.toUpperCase()}</span>`;
      break;
    case 'goal': {
      const ins = Object.values(doc.edges).filter(e => e.to === n.id).length;
      const sub = ins ? (n.combine === 'or' ? 'any of its inputs' : 'all of its inputs') : 'complete every task';
      body = `<div class="n-head"><span class="n-icon">${icon('trophy')}</span><span class="n-title">Goal</span></div><div class="n-sub">${sub}${doc.settings.extraGoal ? ' + text rule' : ''}</div>`;
      break;
    }
    case 'meta': {
      const d = descendants(doc, n.id);
      const count = k => d.filter(x => x.kind === k).length;
      const parts = [['task', 'task'], ['item', 'item'], ['region', 'region'], ['group', 'group']]
        .map(([k, label]) => [count(k), label]).filter(([c]) => c).map(([c, l]) => `${c} ${l}${c === 1 ? '' : 's'}`);
      const colors = [...new Set(d.filter(x => x.kind === 'task').map(t => regionColor(doc, t.region)).filter(Boolean))].slice(0, 8);
      body = `<div class="n-head"><span class="n-icon">${icon('folder')}</span><span class="n-title">${title}</span><span class="open">Open ›</span></div>`
        + `<div class="n-sub">${parts.join(' · ') || 'empty'}</div>`
        + (colors.length ? `<div class="swatches">${colors.map(c => `<i style="background:${esc(c)}"></i>`).join('')}</div>` : '');
      break;
    }
    case 'note':
      body = `<div class="n-text">${esc(n.text) || '<span class="faint">Empty note</span>'}</div>`;
      break;
    default:
  }
  return `<div class="node ${n.kind}${cls}" data-id="${esc(n.id)}" style="${style.join(';')}">${body}</div>`;
}

function ghostHtml(doc, g) {
  const n = doc.nodes[g.ext];
  const where = ancestors(doc, g.ext).map(id => doc.nodes[id]?.name).filter(Boolean).reverse().join(' › ') || 'top level';
  return `<div class="node ghost" data-ghost="${esc(g.ext)}" style="left:${g.x}px;top:${g.y}px;width:200px">`
    + `<div class="n-head"><span class="n-icon">${icon(g.side === 'in' ? 'arrow-right' : 'arrow-left')}</span><span class="n-title">${esc(nodeTitle(n))}</span></div><div class="n-sub">${esc(n.kind)} · in ${esc(where)}</div></div>`;
}

/** Full redraw of the current level. */
export function renderCanvas() {
  const { doc, level } = app;
  const kids = childrenOf(doc, level);
  const nodesEl = $('nodes');

  // Edges at this level, aggregated between visible representatives.
  const drawnMap = new Map();
  const ghostMap = new Map();
  for (const e of Object.values(doc.edges)) {
    if (!doc.nodes[e.from] || !doc.nodes[e.to]) continue;
    const ra = repAt(doc, e.from, level);
    const rb = repAt(doc, e.to, level);
    let a = ra;
    let b = rb;
    if (ra && rb) {
      if (ra === rb) continue;
    } else if (ra || rb) {
      const ext = ra ? e.to : e.from;
      const side = ra ? 'out' : 'in';
      const gid = `ghost:${side}:${ext}`;
      if (!ghostMap.has(gid)) ghostMap.set(gid, { id: gid, ext, side, inner: [] });
      ghostMap.get(gid).inner.push(ra || rb);
      if (ra) b = gid; else a = gid;
    } else continue;
    const key = `${a}|${b}|${e.kind}`;
    if (!drawnMap.has(key)) drawnMap.set(key, { a, b, kind: e.kind, edges: [] });
    drawnMap.get(key).edges.push(e);
  }

  // Ghost placement: inputs on the left, outputs on the right.
  const est = n => app.sizes.get(n.id) || { w: WIDTH[n.kind] || 200, h: 60 };
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity;
  for (const n of kids) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x + est(n).w); minY = Math.min(minY, n.y);
  }
  if (!kids.length) { minX = 0; maxX = 400; minY = 0; }
  const byId = new Map(kids.map(n => [n.id, n]));
  const ghosts = [...ghostMap.values()];
  for (const side of ['in', 'out']) {
    const list = ghosts.filter(g => g.side === side);
    for (const g of list) g.sortY = g.inner.reduce((s, id) => s + (byId.get(id)?.y || 0), 0) / g.inner.length;
    list.sort((p, q) => p.sortY - q.sortY);
    let y = minY;
    for (const g of list) {
      g.x = side === 'in' ? minX - 320 : maxX + 140;
      g.y = Math.max(y, Math.round(g.sortY));
      y = g.y + 70;
    }
  }

  const sel = app.sel.nodes;
  const memberOf = sel.size === 1 ? doc.nodes[[...sel][0]] : null;
  const isMember = n => memberOf && ((memberOf.kind === 'region' && n.kind === 'task' && n.region === memberOf.id)
    || (memberOf.kind === 'group' && n.kind === 'item' && n.group === memberOf.id));
  const linking = app.mode.type === 'link';
  let html = '';
  for (const n of kids) {
    let cls = '';
    if (sel.has(n.id)) cls += ' sel';
    if (isMember(n)) cls += ' member';
    if (linking && !sel.has(n.id)) cls += ' linkable';
    html += nodeHtml(doc, n, cls);
  }
  for (const g of ghosts) html += ghostHtml(doc, g);
  nodesEl.innerHTML = html;

  // Measure.
  frame.boxes.clear();
  for (const el of nodesEl.children) {
    if (!el.dataset.id) continue;
    const box = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    app.sizes.set(el.dataset.id, { w: box.w, h: box.h });
    frame.boxes.set(el.dataset.id, box);
  }
  // Ghost elements are rendered in `ghosts` order; key their boxes by ghost id.
  const ghostEls = nodesEl.querySelectorAll('[data-ghost]');
  ghosts.forEach((g, i) => {
    const el = ghostEls[i];
    frame.boxes.set(g.id, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
  });
  frame.ghosts = new Map(ghosts.map(g => [g.id, g]));
  frame.drawn = [...drawnMap.values()];
  drawEdges();
  renderCrumbs();
  applyTransform();
  positionActionBar();
}

/** Restyle for a new selection without rebuilding the nodes (keeps double-clicks working). */
export function updateSelection() {
  const { doc } = app;
  const sel = app.sel.nodes;
  const one = sel.size === 1 ? doc.nodes[[...sel][0]] : null;
  const linking = app.mode.type === 'link';
  for (const el of $('nodes').querySelectorAll('.node[data-id]')) {
    const n = doc.nodes[el.dataset.id];
    if (!n) continue;
    const member = one && ((one.kind === 'region' && n.kind === 'task' && n.region === one.id)
      || (one.kind === 'group' && n.kind === 'item' && n.group === one.id));
    el.classList.toggle('sel', sel.has(n.id));
    el.classList.toggle('member', !!member);
    el.classList.toggle('linkable', linking && !sel.has(n.id));
  }
  drawEdges();
  positionActionBar();
}

/** Redraw edges only (after nodes moved). */
export function drawEdges() {
  const { doc } = app;
  const layer = $('edge-layer');
  const drawn = frame.drawn;
  // Spread anchor points along each side, ordered by the other end's height.
  const ins = new Map();
  const outs = new Map();
  const center = id => { const b = frame.boxes.get(id); return b ? b.y + b.h / 2 : 0; };
  for (const d of drawn) {
    (ins.get(d.b) || ins.set(d.b, []).get(d.b)).push(d);
    (outs.get(d.a) || outs.set(d.a, []).get(d.a)).push(d);
  }
  const anchor = (list, d, id, other) => {
    const b = frame.boxes.get(id);
    if (list.length === 1) return b.y + b.h / 2;
    const sorted = [...list].sort((p, q) => center(p[other]) - center(q[other]));
    const i = sorted.indexOf(d);
    const pad = Math.min(12, b.h / 4);
    return b.y + pad + (b.h - 2 * pad) * (i + 0.5) / list.length;
  };
  const selNode = app.sel.nodes.size === 1 ? [...app.sel.nodes][0] : null;
  const selEdge = app.sel.edge;
  let paths = '';
  let labels = '';
  // Labels slide along their curve to avoid other labels and nodes.
  const placed = [];
  const nodeBoxes = [...frame.boxes.values()];
  const overlaps = (r, b, pad = 2) => r.x < b.x + b.w + pad && r.x + r.w + pad > b.x && r.y < b.y + b.h + pad && r.y + r.h + pad > b.y;
  const bez = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  };
  const placeLabel = (text, x1, y1, x2, y2, dx) => {
    const w = text.length * 6.4 + 16;
    const h = 20;
    let best = null;
    for (const t of [0.5, 0.62, 0.38, 0.74, 0.26, 0.84, 0.16]) {
      const cx = bez(x1, x1 + dx, x2 - dx, x2, t);
      const cy = bez(y1, y1, y2, y2, t);
      const r = { x: cx - w / 2, y: cy - h / 2, w, h };
      best ||= r;
      if (!placed.some(b => overlaps(r, b)) && !nodeBoxes.some(b => overlaps(r, b, 0))) { best = r; break; }
    }
    placed.push(best);
    return { x: best.x + w / 2, y: best.y + h / 2 };
  };
  for (const d of drawn) {
    const A = frame.boxes.get(d.a);
    const B = frame.boxes.get(d.b);
    if (!A || !B) continue;
    const x1 = A.x + A.w;
    const y1 = anchor(outs.get(d.a), d, d.a, 'b');
    const x2 = B.x;
    const y2 = anchor(ins.get(d.b), d, d.b, 'a');
    // Curvature follows the gap; nodes side by side get a nearly straight link.
    const dx = Math.max(8, Math.abs(x2 - x1) * 0.5, Math.min(36, Math.abs(y2 - y1) * 0.4));
    // Only a target that sits clearly behind its source gets the loop-around route.
    const back = x2 < x1 - 20;
    const xm = (x1 + x2) / 2;
    const ym = (y1 + y2) / 2 + (Math.abs(y2 - y1) < 50 ? 70 : 0);
    const path = back
      ? `M${x1},${y1} C${x1 + 70},${y1} ${x1 + 70},${ym} ${xm},${ym} S${x2 - 70},${y2} ${x2},${y2}`
      : `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    const target = doc.nodes[d.edges[0].to];
    const orTarget = target && ((target.kind === 'gate' && target.op === 'or') || target.combine === 'or') && d.kind === 'req';
    const isSel = d.edges.some(e => e.id === selEdge);
    const hi = selNode && (d.a === selNode || d.b === selNode);
    const dim = (selNode && !hi) || (selEdge && !isSel);
    const cls = ['e', d.kind === 'cost' ? 'cost' : '', orTarget ? 'or' : '', hi ? 'hi' : '', isSel ? 'sel' : '', dim ? 'dim' : ''].join(' ');
    const eid = esc(d.edges[0].id);
    paths += `<path class="${cls}" d="${path}"/>`;
    paths += `<path class="arrow${hi || isSel ? ' hi' : ''}" d="M${x2 - 7},${y2 - 4} L${x2},${y2} L${x2 - 7},${y2 + 4} z" style="${dim ? 'opacity:.35' : ''}"/>`;
    paths += `<path class="hit" data-edge="${eid}" d="${path}"/>`;
    const text = d.edges.length > 1 ? `${d.edges.length} links` : condLabel(doc, d.edges[0]);
    if (text) {
      const lc = ['elabel', d.kind === 'cost' ? 'cost' : '', isSel ? 'sel' : '', dim ? 'dim' : ''].join(' ');
      const at = back ? { x: xm, y: ym } : placeLabel(text, x1, y1, x2, y2, dx);
      labels += `<div class="${lc}" data-edge="${eid}" style="left:${at.x}px;top:${at.y}px">${esc(text)}</div>`;
    }
  }
  layer.innerHTML = paths;
  for (const el of $('nodes').querySelectorAll('.elabel')) el.remove();
  $('nodes').insertAdjacentHTML('beforeend', labels);
}

/** Move node elements to their model positions without a full redraw. */
export function syncPositions(ids) {
  for (const id of ids) {
    const n = app.doc.nodes[id];
    const el = $('nodes').querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!n || !el) continue;
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
    const b = frame.boxes.get(id);
    if (b) { b.x = n.x; b.y = n.y; }
  }
  drawEdges();
  positionActionBar();
}

export function applyTransform() {
  const v = view();
  $('world').style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
  const c = $('canvas');
  const s = 22 * v.k;
  c.style.backgroundImage = v.k > 0.35 ? 'radial-gradient(circle, var(--dot) 1.1px, transparent 1.3px)' : 'none';
  c.style.backgroundSize = `${s}px ${s}px`;
  c.style.backgroundPosition = `${v.x}px ${v.y}px`;
  $('z-level').textContent = `${Math.round(v.k * 100)}%`;
  positionActionBar();
}

export function screenToWorld(sx, sy) {
  const v = view();
  const r = $('canvas').getBoundingClientRect();
  return { x: (sx - r.left - v.x) / v.k, y: (sy - r.top - v.y) / v.k };
}

export function zoomAt(sx, sy, factor) {
  const v = view();
  const r = $('canvas').getBoundingClientRect();
  const k = Math.min(2.5, Math.max(0.12, v.k * factor));
  const px = sx - r.left;
  const py = sy - r.top;
  v.x = px - (px - v.x) * (k / v.k);
  v.y = py - (py - v.y) * (k / v.k);
  v.k = k;
  applyTransform();
}

/** Fit the boxes (default: everything at this level) into the canvas. */
export function fitView(ids = null, { maxK = 1.1 } = {}) {
  const boxes = [...frame.boxes.entries()].filter(([id]) => !ids || ids.includes(id)).map(([, b]) => b);
  const r = $('canvas').getBoundingClientRect();
  const v = view();
  if (!boxes.length) { v.x = r.width / 3; v.y = r.height / 3; v.k = 1; applyTransform(); return; }
  const x0 = Math.min(...boxes.map(b => b.x));
  const y0 = Math.min(...boxes.map(b => b.y));
  const x1 = Math.max(...boxes.map(b => b.x + b.w));
  const y1 = Math.max(...boxes.map(b => b.y + b.h));
  const pad = 70;
  const k = Math.min(maxK, (r.width - 2 * pad) / Math.max(1, x1 - x0), (r.height - 2 * pad - 40) / Math.max(1, y1 - y0));
  v.k = Math.max(0.12, k);
  v.x = (r.width - (x1 - x0) * v.k) / 2 - x0 * v.k;
  v.y = (r.height - (y1 - y0) * v.k) / 2 - y0 * v.k + 10;
  applyTransform();
}

export function centerOn(id) {
  const b = frame.boxes.get(id);
  if (!b) return;
  const r = $('canvas').getBoundingClientRect();
  const v = view();
  if (v.k < 0.6) v.k = 0.9;
  v.x = r.width / 2 - (b.x + b.w / 2) * v.k;
  v.y = r.height / 2 - (b.y + b.h / 2) * v.k;
  applyTransform();
}

function renderCrumbs() {
  const { doc, level } = app;
  const chain = level ? [...ancestors(doc, level).reverse(), level] : [];
  const parts = [`<button class="btn${level ? '' : ' here'}" data-level="">Top level</button>`];
  for (const id of chain) {
    parts.push('<span class="sep">›</span>');
    parts.push(`<button class="btn${id === level ? ' here' : ''}" data-level="${esc(id)}">${esc(doc.nodes[id]?.name || 'Group')}</button>`);
  }
  $('crumbs').innerHTML = parts.join('');
}

/** Floating actions above the selection (filled in by app.js). */
export let actionBarContent = () => '';
export const setActionBarContent = fn => { actionBarContent = fn; };

export function positionActionBar() {
  const bar = $('actionbar');
  const ids = [...app.sel.nodes].filter(id => frame.boxes.has(id));
  // Hidden while the pointer is held down, so it appears only once the press ends.
  if (!ids.length || app.mode.type !== 'idle' || app.pressing) { bar.hidden = true; return; }
  const html = actionBarContent(ids);
  if (!html) { bar.hidden = true; return; }
  if (bar.dataset.for !== ids.join(',') + app.doc.nodes[ids[0]]?.kind) {
    bar.innerHTML = html;
    bar.dataset.for = ids.join(',') + app.doc.nodes[ids[0]]?.kind;
  }
  const v = view();
  const bs = ids.map(id => frame.boxes.get(id));
  const x0 = Math.min(...bs.map(b => b.x));
  const x1 = Math.max(...bs.map(b => b.x + b.w));
  const y0 = Math.min(...bs.map(b => b.y));
  bar.hidden = false;
  bar.style.left = `${v.x + ((x0 + x1) / 2) * v.k}px`;
  bar.style.top = `${Math.max(52, v.y + y0 * v.k - 10)}px`;
}

export function flash(id) {
  const el = $('nodes').querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

export function setRubber(from, to) {
  const r = $('rubber');
  if (!from) { r.setAttribute('d', ''); return; }
  const dx = Math.max(36, Math.abs(to.x - from.x) * 0.5);
  r.setAttribute('d', `M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`);
}
