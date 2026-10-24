// Modal dialogs and toasts.

import { TASK_REWARD_PREVIEW_LABELS, MAX_PLAYER_NAME_LEN } from '../vendor/taskipelago/js/generator/model.js';
import { app, commit } from './store.js';
import { esc } from './view.js';
import { icon } from './icons.js';

const $ = id => document.getElementById(id);

let toastTimer = null;
export function toast(message, { action = null, onAction = null, ms = 3200 } = {}) {
  const el = $('toast');
  el.innerHTML = esc(message);
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = action;
    b.onclick = () => { el.classList.remove('on'); onAction(); };
    el.append(b);
  }
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), action ? ms + 3000 : ms);
}

let closeHandler = null;
/** Open a modal. `body` is an HTML string or element; buttons: [{label, cls, onclick -> keep open?}] */
export function modal(title, body, buttons = [{ label: 'Close' }], { wide = false, onClose = null } = {}) {
  const m = $('modal');
  m.className = `modal${wide ? ' wide' : ''}`;
  m.innerHTML = `<header>${esc(title)}<span class="spacer"></span><button class="btn icon-btn" data-close aria-label="Close">${icon('x')}</button></header><div class="body"></div><footer></footer>`;
  const b = m.querySelector('.body');
  if (typeof body === 'string') b.innerHTML = body; else b.append(body);
  const foot = m.querySelector('footer');
  for (const btn of buttons) {
    const el = document.createElement('button');
    el.className = `btn ${btn.cls || 'outline'}`;
    el.textContent = btn.label;
    el.onclick = async () => { if (!(await btn.onclick?.(m))) closeModal(); };
    foot.append(el);
  }
  m.querySelector('[data-close]').onclick = closeModal;
  closeHandler = onClose;
  $('modal-back').classList.add('open');
  setTimeout(() => m.querySelector('input, select, textarea, footer .btn.primary')?.focus(), 30);
  return m;
}

export function closeModal() {
  $('modal-back').classList.remove('open');
  const fn = closeHandler;
  closeHandler = null;
  fn?.();
}
export const modalOpen = () => $('modal-back').classList.contains('open');

export function confirmDialog(title, message, okLabel = 'OK', cls = 'primary') {
  return new Promise(resolve => {
    let answered = false;
    modal(title, `<p style="margin:0;white-space:pre-wrap">${esc(message)}</p>`, [
      { label: 'Cancel', onclick: () => { answered = true; resolve(false); } },
      { label: okLabel, cls, onclick: () => { answered = true; resolve(true); } },
    ], { onClose: () => { if (!answered) resolve(false); } });
  });
}

// ------------------------------------------------------------------ settings

export function settingsDialog() {
  const s = app.doc.settings;
  const body = document.createElement('div');
  const set = (k, v, key = null) => commit(d => { d.settings[k] = v; }, { key: key && `settings.${k}`, inspector: true });
  const row = html => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
  const bind = (el, k, parse = v => v, ev = 'input') => {
    el.addEventListener(ev, () => set(k, parse(el.type === 'checkbox' ? el.checked : el.value), ev === 'input' ? k : null));
    return el;
  };
  const input = (k, attrs = '') => bind(row(`<input class="inp" ${attrs} value="${esc(s[k])}">`), k);
  const numIn = (k, min, max) => bind(row(`<input class="inp" type="number" min="${min}" max="${max}" value="${esc(s[k])}">`), k,
    v => Math.min(max, Math.max(min, Number(v) || 0)));
  const checkbox = (k, label, hint = '') => {
    const lab = row(`<label class="check"><input type="checkbox" ${s[k] ? 'checked' : ''}><span>${esc(label)}</span>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`);
    bind(lab.querySelector('input'), k, v => v, 'change');
    return lab;
  };
  const field = (label, el, hint = '') => {
    const f = row(`<label class="field"><span>${esc(label)}</span></label>`);
    f.append(el);
    if (hint) f.append(row(`<div class="hint">${esc(hint)}</div>`));
    return f;
  };
  const h4 = t => row(`<h4>${esc(t)}</h4>`);
  const grid = (...els) => { const g = row('<div class="row2"></div>'); g.append(...els); return g; };

  const acc = row('<select class="inp"><option value="full">Full</option><option value="minimal">Minimal</option></select>');
  acc.value = s.accessibility || 'full';
  bind(acc, 'accessibility', v => v, 'change');
  const prev = row(`<select class="inp">${TASK_REWARD_PREVIEW_LABELS.map((l, i) => `<option value="${i}">${esc(l)}</option>`).join('')}</select>`);
  prev.value = String(s.taskRewardPreviews || 0);
  bind(prev, 'taskRewardPreviews', Number, 'change');

  body.append(
    h4('Player'),
    grid(field('Player name', input('playerName', `maxlength="${MAX_PLAYER_NAME_LEN}" placeholder="Required for export"`)),
      field('Progression balancing', numIn('progressionBalancing', 0, 99))),
    grid(field('Accessibility', acc), field('Task reward previews', prev)),
    checkbox('previewsPurchasableOnly', 'Previews only for tasks with a cost'),
    h4('Client'),
    checkbox('lockPrereqs', 'Lock tasks behind their requirements'),
    checkbox('hideUnreachable', 'Hide unreachable tasks'),
    checkbox('autoFiller', 'Pad the item pool with filler', 'keeps task and item slots balanced'),
  );

  // DeathLink pool.
  const dl = row('<div></div>');
  const renderDl = () => {
    dl.innerHTML = '';
    (s.deathLink || []).forEach((d, i) => {
      const r = row(`<div class="dl-row"><input class="inp" placeholder="e.g. 10 pushups" value="${esc(d.text)}"><input class="inp" type="number" min="0" step="any" value="${esc(d.weight)}" title="Weight"><button class="btn icon-btn" title="Remove">${icon('x')}</button></div>`);
      const [t, w, x] = r.children;
      t.oninput = () => commit(doc => { doc.settings.deathLink[i].text = t.value; }, { key: `dl${i}t` });
      w.oninput = () => commit(doc => { doc.settings.deathLink[i].weight = w.value; }, { key: `dl${i}w` });
      x.onclick = () => { commit(doc => { doc.settings.deathLink.splice(i, 1); }); renderDl(); };
      dl.append(r);
    });
    const add = row('<button class="btn small outline">+ DeathLink task</button>');
    add.onclick = () => { commit(doc => { doc.settings.deathLink = [...(doc.settings.deathLink || []), { text: '', weight: '1' }]; }); renderDl(); };
    dl.append(add);
  };
  renderDl();
  body.append(h4('DeathLink'),
    checkbox('deathLinkEnabled', 'Enable DeathLink'),
    grid(field('Amnesty', numIn('deathLinkAmnesty', 0, 999), 'Ignore this many before one triggers'),
      row('<div></div>')),
    checkbox('deathLinkLockTasks', 'Lock other tasks until DeathLink tasks are done'),
    field('DeathLink tasks', dl));

  body.append(h4('Tasclickpelago (clicker mode)'),
    checkbox('clickerMode', 'Enable clicker mode', 'adds clicker fields to tasks, items and regions'),
    checkbox('clickerDistributeGlobal', 'Split “*” production evenly'),
    checkbox('clickerOffline', 'Offline progress'),
    grid(field('Offline rate', input('clickerOfflineRate')), field('Offline cap (hours)', numIn('clickerOfflineCapHours', 0, 168))));

  modal('Slot settings', body, [{ label: 'Done', cls: 'primary' }]);
}

// ------------------------------------------------------------------ help

export function helpDialog() {
  const k = s => `<span class="kbd">${esc(s)}</span>`;
  modal('Controls', `
    <div class="insp" style="padding:0"><div class="help"><dl>
      <dt>Pan</dt><dd>Two-finger scroll on the trackpad (or the mouse wheel; Shift+wheel for sideways), the arrow keys with nothing selected, or drag empty canvas.</dd>
      <dt>Zoom</dt><dd>Pinch, Ctrl+scroll, or ${k('+')} ${k('−')}. ${k('F')} fits everything, ${k('0')} resets to 100%.</dd>
      <dt>Add a node</dt><dd>Pick a type on the left (${k('T')} task, ${k('I')} item, ${k('R')} region, ${k('P')} item group, ${k('A')} / ${k('O')} gates), then click the canvas.</dd>
      <dt>Next task</dt><dd>${k('N')} adds a task right after the selected node, already linked.</dd>
      <dt>Link</dt><dd>${k('L')}: click each node the selection unlocks. ${k('Shift')}+${k('L')}: click each node the selection requires. ${k('Esc')} or a right-click ends.</dd>
      <dt>Link meaning</dt><dd>Click a link's label to type its number right there (${k('Enter')} saves, ${k('Esc')} cancels), or click the link to set it in the panel: copies of an item, a region's percent or task count, how many items of a group, or spending a currency.</dd>
      <dt>Any / all</dt><dd>A node's panel sets whether it needs all its requirements or any one. Gates nest rules: (A and B) or C.</dd>
      <dt>Move</dt><dd>${k('M')}, glide the pointer, click to drop; or drag a node (dragging any selected node moves the whole selection). Arrow keys nudge selected nodes (${k('Shift')} for bigger steps).</dd>
      <dt>Select</dt><dd>Click. ${k('Shift')}+click adds or removes. ${k('Ctrl')}+${k('A')} selects the whole level.</dd>
      <dt>Meta-nodes</dt><dd>${k('G')} groups the selection. “Open ›”, a double-click or ${k('Enter')} opens one; links into the card go to its Input and links out start at its Output (unwired: every task inside done); ${k('Esc')} or the breadcrumb goes back up. Links leaving a meta-node show as dashed ghost nodes you can click to jump.</dd>
      <dt>Sequences</dt><dd>Give a task several copies and tick “Copies in order”: one node whose copies are done one after another. “Explode as sequence” splits the copies into a chain of step nodes (selecting a chain offers to merge it back); “Explode as copies” splits them into separate parallel tasks, all of which are still needed by what the task unlocked; selecting the copies offers to merge them back.</dd>
      <dt>Ladders</dt><dd>“Make a ladder…” builds two tracks of steps where step <i>k</i> of the second needs step <i>k</i> of the first. Select two tasks to build the ladder from them. Ladders are never offered for merging, since that would drop the rungs.</dd>
      <dt>Random links</dt><dd>“Random meta-node…” on a selection, or “Randomize links…” on a meta-node (or in the panel while inside one), links the tasks inside at random into layers from Input to Output, for deep tasks with many prerequisites. “Reroll” in the message tries another draw.</dd>
      <dt>Costs</dt><dd>“+ Cost” in a task's panel spends an existing currency or creates a new one, with enough copies to pay for every copy of the task.</dd>
      <dt>Find</dt><dd>${k('/')} searches every node, inside meta-nodes too.</dd>
      <dt>Undo</dt><dd>${k('Ctrl')}+${k('Z')}, redo ${k('Ctrl')}+${k('Shift')}+${k('Z')}. ${k('Delete')} removes the selection.</dd>
    </dl>
    <p>Exported YAML goes through Taskipelago's own generator code, so it is checked exactly as the official YAML generator checks it. The file also carries this graph's layout in a comment, so opening it here again restores the canvas.</p>
    <p class="muted">Built by Aidan Epperly with Claude, Anthropic's AI model, which wrote the code and tests to his design. Taskipelago and the other bundled code and icons are by their own authors (see Licenses).</p>
    </div></div>`, [{ label: 'Licenses', onclick: () => { licensesDialog(); return true; } }, { label: 'Close', cls: 'primary' }], { wide: true });
}

// ------------------------------------------------------------------ licenses

const LICENSES = [
  ['Lucide icons', 'https://lucide.dev', 'licenses/lucide-LICENSE.txt'],
  ['Feather icons (through Lucide)', 'https://feathericons.com', 'licenses/feather-LICENSE.txt'],
  ['Taskipelago generator code', 'https://github.com/barretg/Taskipelago', 'licenses/taskipelago-LICENSE.txt'],
  ['js-yaml', 'https://github.com/nodeca/js-yaml', 'licenses/js-yaml-LICENSE.txt'],
];

export async function licensesDialog() {
  const parts = await Promise.all(LICENSES.map(async ([name, url, path]) => {
    let text;
    try {
      const r = await fetch(path);
      text = r.ok ? await r.text() : `See ${path}.`;
    } catch (_) {
      text = `See ${path}.`;
    }
    return `<h4>${esc(name)}</h4><p class="small muted" style="margin:0 0 6px"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p><pre style="white-space:pre-wrap;max-height:none">${esc(text)}</pre>`;
  }));
  modal('Licenses', `<p class="muted" style="margin-top:0">Taskipelago Graph includes this software.</p>${parts.join('')}`,
    [{ label: 'Close', cls: 'primary' }], { wide: true });
}
