// Graph -> Taskipelago generator model. The model then goes through the
// generator's own buildExport (vendored), so validation and YAML output are
// exactly what the official YAML generator would produce.

import { defaultModel, newItem, newTask } from '../vendor/taskipelago/js/generator/model.js';
import { buildExport, exportText } from '../vendor/taskipelago/js/generator/yaml_export.js';
import { finalCounts } from '../vendor/taskipelago/js/generator/randomize_check.js';
import { descendants, nodesOf, goalNode, nodeTitle } from './graph.js';
import { generationChecks } from './checks.js';

// Leaf domains: R = region reference, T = task, I = item or item group.
const FITS = { task: new Set(['R', 'T']), item: new Set(['I']), region: new Set(['R']) };

const quote = name => `"${name}"`;

/** Expression tree for the source end of a requirement edge. */
function leafFor(doc, e, gateStack) {
  const a = { ...doc.nodes[e.from] };
  a.name = (a.name || '').trim();
  const c = e.cond || {};
  switch (a.kind) {
    case 'task':
      return { dom: 'T', text: quote(a.name) };
    case 'item': {
      const n = Math.max(1, Number(c.copies) || 1);
      return { dom: 'I', text: n > 1 ? `${quote(a.name)}*${n}` : quote(a.name) };
    }
    case 'region':
      if (c.mode === 'pct') return { dom: 'R', text: `${a.name}-${c.n}` };
      if (c.mode === 'count') return { dom: 'R', text: `${a.name}*${c.n}` };
      return { dom: 'R', text: a.name };
    case 'group':
      if (c.mode === 'pct' || c.mode === 'position') return { dom: 'I', text: `${a.name}-${c.n}` };
      if (c.mode === 'next' || c.mode === 'default') return { dom: 'I', text: a.name };
      return { dom: 'I', text: `${a.name}*${Math.max(1, Number(c.n) || 1)}` };
    case 'gate': {
      if (gateStack.has(a.id)) throw new Error('Logic gates form a cycle.');
      gateStack.add(a.id);
      let kids = reqEdges(doc, a.id).map(k => leafFor(doc, k, gateStack)).filter(Boolean);
      // An unwired Output means every task inside its meta-node is done.
      if (!kids.length && a.role === 'output') {
        kids = descendants(doc, a.parent).filter(t => t.kind === 'task' && (t.name || '').trim())
          .map(t => ({ dom: 'T', text: quote(t.name.trim()) }));
      }
      gateStack.delete(a.id);
      return combine(a.op, kids);
    }
    default:
      return null;
  }
}

function combine(op, kids) {
  const flat = [];
  for (const k of kids) {
    if (!k) continue;
    if (k.op === op) flat.push(...k.kids);
    else flat.push(k);
  }
  if (!flat.length) return null;
  if (flat.length === 1) return flat[0];
  return { op, kids: flat };
}

const reqEdges = (doc, id) => Object.values(doc.edges)
  .filter(e => e.to === id && e.kind === 'req' && doc.nodes[e.from])
  .sort((x, y) => (doc.nodes[x.from].y - doc.nodes[y.from].y) || (doc.nodes[x.from].x - doc.nodes[y.from].x));

function domains(t, out = new Set()) {
  if (t.op) t.kids.forEach(k => domains(k, out));
  else out.add(t.dom);
  return out;
}

const subset = (a, b) => [...a].every(x => b.has(x));

/** Render a tree as prereq text for a field whose bare tokens mean `home`. */
export function render(t, home) {
  if (!t) return '';
  const doms = domains(t);
  if (subset(doms, FITS[home])) return bare(t, home);
  if (home !== 'task' && subset(doms, FITS.task)) return `task(${bare(t, 'task')})`;
  if (home !== 'item' && subset(doms, FITS.item)) return `item(${bare(t, 'item')})`;
  return t.kids.map(k => paren(k, render(k, home))).join(t.op === 'and' ? ' && ' : ' || ');
}

function bare(t, home) {
  if (!t.op) return t.text;
  return t.kids.map(k => paren(k, render(k, home))).join(t.op === 'and' ? ' && ' : ' || ');
}

const paren = (t, text) => (t.op ? `(${text})` : text);

const joinAnd = parts => {
  const list = parts.filter(p => p && p.trim());
  if (list.length <= 1) return list[0] || '';
  return list.map(p => (/\|\|/.test(p) ? `(${p})` : p)).join(' && ');
};

/** Requirements of a target as one tree, honoring its all/any setting. */
function targetTree(doc, node) {
  const kids = reqEdges(doc, node.id).map(e => leafFor(doc, e, new Set()));
  return combine(node.combine === 'or' ? 'or' : 'and', kids);
}

/** Split a task's requirement tree into task_prereqs / item_prereqs text. */
function taskFields(t) {
  if (!t) return ['', ''];
  const doms = domains(t);
  if (subset(doms, FITS.task)) return [render(t, 'task'), ''];
  if (subset(doms, FITS.item)) return ['', render(t, 'item')];
  if (t.op === 'and') {
    const taskKids = [];
    const itemKids = [];
    const mixed = [];
    for (const k of t.kids) {
      const d = domains(k);
      if (subset(d, FITS.task)) taskKids.push(k);
      else if (subset(d, FITS.item)) itemKids.push(k);
      else mixed.push(k);
    }
    const tt = combine('and', [...taskKids, ...mixed]);
    const it = combine('and', itemKids);
    return [tt ? render(tt, 'task') : '', it ? render(it, 'item') : ''];
  }
  return [render(t, 'task'), ''];
}

/** Position-based sort key: outer meta-nodes first, then left to right, top to bottom. */
function posKey(doc, n) {
  const chain = [];
  let cur = n;
  while (cur) {
    chain.unshift([Math.round(cur.x / 60), cur.y]);
    cur = cur.parent ? doc.nodes[cur.parent] : null;
  }
  return chain;
}

function cmpKey(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i][0] !== b[i][0]) return a[i][0] - b[i][0];
    if (a[i][1] !== b[i][1]) return a[i][1] - b[i][1];
  }
  return a.length - b.length;
}

/** Tasks in dependency order (prereqs first), ties broken by layout position. */
function orderTasks(doc, tasks) {
  const ids = new Set(tasks.map(t => t.id));
  // Task -> tasks it (transitively through gates) depends on.
  const deps = new Map(tasks.map(t => [t.id, new Set()]));
  const upstreamTasks = (id, seen = new Set()) => {
    const out = [];
    for (const e of Object.values(doc.edges)) {
      if (e.to !== id || seen.has(e.from)) continue;
      seen.add(e.from);
      const a = doc.nodes[e.from];
      if (!a) continue;
      if (ids.has(a.id)) out.push(a.id);
      else if (a.kind === 'gate') out.push(...upstreamTasks(a.id, seen));
    }
    return out;
  };
  for (const t of tasks) for (const d of upstreamTasks(t.id)) deps.get(t.id).add(d);
  const keys = new Map(tasks.map(t => [t.id, posKey(doc, t)]));
  const done = new Set();
  const out = [];
  const remaining = [...tasks].sort((a, b) => cmpKey(keys.get(a.id), keys.get(b.id)));
  while (remaining.length) {
    let i = remaining.findIndex(t => [...deps.get(t.id)].every(d => done.has(d)));
    if (i < 0) i = 0; // cycle: fall back to position order
    const [t] = remaining.splice(i, 1);
    done.add(t.id);
    out.push(t);
  }
  return out;
}

/**
 * Build the generator model. Returns { model, taskIds, itemIds, problems }:
 * taskIds[i] / itemIds[i] is the node behind exported row i, and problems are
 * graph-level issues found before the generator's own validation runs.
 */
export function compile(doc) {
  const s = doc.settings;
  const problems = [];
  const model = defaultModel();
  for (const k of Object.keys(model)) if (k in s) model[k] = structuredClone(s[k]);
  model.deathLink = (s.deathLink || []).map(d => ({ text: d.text || '', weight: String(d.weight ?? '1') }));

  const name = id => (doc.nodes[id]?.name || '').trim();
  const named = list => list.filter(n => {
    if ((n.name || '').trim()) return true;
    problems.push({ level: 'error', msg: `A ${n.kind} has no name.`, nodeId: n.id });
    return false;
  });

  // Regions and groups, in layout order.
  const byPos = list => [...list].sort((a, b) => cmpKey(posKey(doc, a), posKey(doc, b)));
  const regions = byPos(named(nodesOf(doc, 'region')));
  model.regions = regions.map(r => ({
    name: r.name.trim(), pct: r.pct, color: r.color || '', prereq: '', parent: name(r.parentRegion),
    distributed: !!r.distributed, offlineRate: r.offlineRate || '', manual: !!r.manual, disabled: !!r.disabled,
  }));
  model.regionRandom = Object.fromEntries(regions
    .filter(r => r.randomOn || r.randomOrder)
    .map(r => [r.name.trim(), { on: !!r.randomOn, pick: r.randomPick || '', order: !!r.randomOrder }]));
  const groups = byPos(named(nodesOf(doc, 'group')));
  model.progGroups = groups.map(g => g.name.trim());
  model.progGroupColors = Object.fromEntries(groups.map(g => [g.name.trim(), g.color || '']));
  model.groupSettings = Object.fromEntries(groups.map(g => [g.name.trim(), {
    type: g.gtype, pick: g.pick || '', pct: g.pct ?? '', early: !!g.early, disabled: !!g.disabled,
    parent: name(g.parentGroup),
  }]));

  const exprOf = node => {
    try {
      return targetTree(doc, node);
    } catch (e) {
      problems.push({ level: 'error', msg: e.message, nodeId: node.id });
      return null;
    }
  };

  for (const r of regions) {
    const row = model.regions.find(x => x.name === r.name.trim());
    row.prereq = joinAnd([render(exprOf(r), 'region'), r.extraPrereq]);
  }

  // Tasks.
  const tasks = orderTasks(doc, named(nodesOf(doc, 'task')));
  model.tasks = tasks.map(t => {
    const [prereq, itemPrereq] = taskFields(exprOf(t));
    const costs = Object.values(doc.edges)
      .filter(e => e.to === t.id && e.kind === 'cost' && doc.nodes[e.from])
      .map(e => `${quote(name(e.from))}*${Math.max(1, Number(e.cond?.amount) || 1)}`);
    return {
      ...newTask(),
      name: t.name.trim(), desc: t.desc || '', region: name(t.region), count: t.count || 1, priority: !!t.priority,
      // 'sequential' chains the copies: each one after the first needs the copy before it.
      prereq: joinAnd([t.sequential && t.count > 1 ? 'sequential' : '', prereq, t.extraPrereq]),
      itemPrereq: joinAnd([itemPrereq, t.extraItemPrereq]),
      cost: joinAnd([...costs, t.extraCost]),
      activations: t.activations || '', manual: !!t.manual, autoComplete: !!t.autoComplete,
      renewable: !!t.renewable, renewableCurrency: name(t.renewableCurrency), renewableAmount: t.renewableAmount || '',
    };
  });

  // Items. Item rules follow the generator's row locks: consumables and
  // progressive-group items are progression; filler is junk with no group.
  const items = byPos(nodesOf(doc, 'item').filter(i => i.filler || (i.name || '').trim() || named([i]).length));
  const gtype = id => doc.nodes[id]?.gtype || 'progressive';
  model.items = items.map(i => {
    const it = newItem();
    const group = i.filler || i.consumable ? '' : name(i.group);
    let type = i.type || 'useful';
    if (i.consumable || (group && gtype(i.group) === 'progressive')) type = 'progression';
    if (i.filler) type = 'junk';
    Object.assign(it, {
      name: i.filler ? '' : (i.name || '').trim(), filler: !!i.filler, type, progGroup: group,
      consumable: !i.filler && !!i.consumable, count: i.count || 1, early: !!i.early,
      clickerKind: i.clickerKind || 'none', clickerTarget: i.clickerTarget || '*', clickerValue: i.clickerValue || '',
    });
    return it;
  });
  const itemIds = items.map(i => i.id);

  // Slot balance after random picks and disabled content, as the generator counts it.
  const { tasks: taskSlots, items: itemSlots } = finalCounts(model,
    model.tasks.map(t => ({ count: Math.max(1, t.count), region: t.region })),
    model.items.map(i => ({ count: Math.max(1, i.count), group: i.progGroup, filler: i.filler })));
  if (s.autoFiller && taskSlots > itemSlots) {
    model.items.push({ ...newItem(), name: '', filler: true, type: 'junk', count: taskSlots - itemSlots });
    itemIds.push(null);
  }

  const goal = goalNode(doc);
  model.goalTasks = joinAnd([goal ? render(exprOf(goal), 'task') : '', s.extraGoal]);

  problems.push(...generationChecks(doc));
  return { model, taskIds: tasks.map(t => t.id), itemIds, problems, taskSlots, itemSlots };
}

/**
 * Run the generator's export. Resolves to
 *   { ok, text, problems, prompts }
 * where prompts are the confirm dialogs the generator would have shown
 * (unbalanced counts, no goal, ...). With `answer` false, any prompt cancels.
 */
export async function exportYaml(doc, { answer = true } = {}) {
  const c = compile(doc);
  const prompts = [];
  const confirm = async (title, message) => {
    prompts.push({ title, message });
    return answer;
  };
  const problems = [...c.problems];
  let result;
  try {
    result = await buildExport(c.model, { confirm });
  } catch (e) {
    problems.push({ level: 'error', msg: `Export failed: ${e.message}` });
    return { ok: false, problems, prompts, compiled: c };
  }
  if (result.error) {
    const [title, message] = result.error;
    problems.push({ level: 'error', title, msg: message });
  }
  for (const p of prompts) problems.push({ level: 'warning', title: p.title, msg: p.message });
  if (result.data) numberDigitNames(result.data.Taskipelago);
  const ok = !!result.data && !problems.some(p => p.level === 'error');
  return { ok, data: result.data, text: result.data ? exportText(result.data) : '', problems, prompts, compiled: c };
}

/**
 * Whether the apworld would misread a quoted name. When it expands task copies it
 * renumbers prereq text with a tokenizer that does not skip quoted names, so a
 * number standing on its own inside one ("Laundry (1/4)", "Meditate #2", "Work 4
 * Hours") is taken for a row number. Mirrors _translate_prereq_indices.
 */
export function apworldMisreads(name) {
  const text = `"${name}"`;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (/[A-Za-z_]/.test(c)) {
      while (i < text.length && !/[\s(),]/.test(text[i]) && !['&&', '||'].includes(text.slice(i, i + 2))) i++;
    } else if (/\d/.test(c)) return true;
    else i++;
  }
  return false;
}

/**
 * Refer to misread task and item names by row number instead, in the fields the
 * apworld renumbers before resolving names: task_prereqs, item_prereqs and the
 * task(...) / item(...) scopes of region_prereqs. Row numbers are what that step
 * expects, so they come through intact. goal_tasks resolves names first and is left alone.
 */
function numberDigitNames(T) {
  const taskRow = new Map(T.tasks.map((n, i) => [n, i + 1]));
  const itemRow = new Map();
  T.items.forEach((n, i) => { if (!T.item_fillers[i] && !itemRow.has(n)) itemRow.set(n, i + 1); });
  const rewrite = (text, home) => {
    if (!text || !text.includes('"')) return text;
    let out = '';
    const scopes = [home];
    for (let i = 0; i < text.length;) {
      const m = /^(task|item)\s*\(/.exec(text.slice(i));
      if (m && !/[A-Za-z0-9_\-]/.test(text[i - 1] || '')) { scopes.push(m[1]); out += m[0]; i += m[0].length; continue; }
      const c = text[i];
      if (c === '(') { scopes.push(scopes[scopes.length - 1]); out += c; i++; continue; }
      if (c === ')') { if (scopes.length > 1) scopes.pop(); out += c; i++; continue; }
      if (c === '"') {
        const j = text.indexOf('"', i + 1);
        if (j < 0) { out += text.slice(i); break; }
        const name = text.slice(i + 1, j);
        const scope = scopes[scopes.length - 1];
        const copies = text[j + 1] === '*';           // "item"*N is resolved before renumbering
        const row = scope === 'task' ? taskRow.get(name) : scope === 'item' ? itemRow.get(name) : null;
        out += row && !copies && apworldMisreads(name) ? String(row) : text.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  };
  T.task_prereqs = T.task_prereqs.map(t => rewrite(t, 'task'));
  T.item_prereqs = T.item_prereqs.map(t => rewrite(t, 'item'));
  T.region_prereqs = T.region_prereqs.map(t => rewrite(t, 'region'));
}

/** Swap "Task 3" / "task 3" / "item 2" in generator messages for node names. */
export function linkMessage(doc, msg, compiled) {
  const parts = [];
  const re = /\b([Tt]ask|[Ii]tem) (\d+)\b/g;
  let last = 0;
  let m;
  while ((m = re.exec(msg))) {
    const list = m[1].toLowerCase() === 'task' ? compiled.taskIds : compiled.itemIds;
    const id = list[Number(m[2]) - 1];
    if (!id || !doc.nodes[id]) continue;
    parts.push(msg.slice(last, m.index));
    parts.push({ id, text: `${m[1]} “${nodeTitle(doc.nodes[id])}”` });
    last = m.index + m[0].length;
  }
  parts.push(msg.slice(last));
  return parts;
}
