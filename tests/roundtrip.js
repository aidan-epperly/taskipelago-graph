// Round-trip check over the Taskipelago YAML corpus:
//   official:  YAML -> importDoc -> buildExport
//   graph:     YAML -> importYaml (graph) -> exportYaml
// The two exports are compared semantically (task order and indices differ by
// design), so every requirement must survive the trip through the graph.

import { defaultModel } from '../vendor/taskipelago/js/generator/model.js';
import { importDoc } from '../vendor/taskipelago/js/generator/yaml_import.js';
import { buildExport, resolveScopedNameRefs, resolveNameRefs, convertCostIdxToQuote } from '../vendor/taskipelago/js/generator/yaml_export.js';
import { loadYaml } from '../vendor/taskipelago/js/shared/yaml11.js';
import { parseCostExpr, parsePrereq, prereqScopes, mapScopedText } from '../vendor/taskipelago/js/shared/prereq_parser.js';
import { importYaml } from '../js/importer.js';
import { exportYaml } from '../js/compile.js';

const SEQ = /^(.*) \((\d+)\/(\d+)\)$/;

function canonAst(ast, dom, names) {
  if (ast === null || ast === undefined) return null;
  if (typeof ast === 'number') return dom === 'item' ? `I:${names.items[ast]}` : `T:${names.task(ast)}`;
  const [op, a, b] = ast;
  switch (op) {
    case 'and': case 'or': {
      const kids = [];
      for (const k of a.map(x => canonAst(x, dom, names)).filter(Boolean)) {
        if (Array.isArray(k) && k[0] === op) kids.push(...k[1]);
        else kids.push(k);
      }
      kids.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
      if (!kids.length) return null;
      return kids.length === 1 ? kids[0] : [op, kids];
    }
    case 'scoped_task': return canonAst(a[0], 'task', names);
    case 'scoped_item': return canonAst(a[0], 'item', names);
    case 'item_copies': return b === 1 ? `I:${names.items[a]}` : `I:${names.items[a]}*${b}`;
    case 'seq_flag': return null;
    default: return `${op}:${a}:${b}`;
  }
}

function canonical(block) {
  const tasks = block.tasks;
  const items = block.items;
  const regions = new Set(block.regions);
  const groups = new Set(block.progressive_groups);
  const scopes = prereqScopes(tasks.length, items.length, regions, groups);
  // A task named "X (n/n)" stands for the sequential task "X".
  const names = {
    items,
    task: i => {
      const m = SEQ.exec(tasks[i]);
      return m && m[2] === m[3] ? m[1] : tasks[i];
    },
  };
  const both = (x, y) => canonAst(['and', [x, y].filter(v => v !== null)], 'task', names);
  const out = { tasks: {}, goal: null, regions: {}, items: [] };
  tasks.forEach((name, i) => {
    const m = SEQ.exec(name);
    if (m && m[2] !== '1') return;
    const key = m ? m[1] : name;
    const R = (t, home) => resolveScopedNameRefs(t, home, tasks, items)[0];
    const tp = block.task_prereqs[i] ? parsePrereq(R(block.task_prereqs[i], 'task'), tasks.length, i, 'task prereq', groups, regions, null, null, scopes) : null;
    const ip = block.item_prereqs[i] ? parsePrereq(R(block.item_prereqs[i], 'item'), items.length, i, 'item prereq', groups, null, null, null, scopes) : null;
    const ipScoped = ip === null ? null : ['scoped_item', [ip]];
    let cost = null;
    if (block.task_cost[i]) {
      const consumables = new Set(items.filter((_, k) => block.item_consumable[k] === 'true'));
      cost = JSON.stringify(canonAst(parseCostExpr(block.task_cost[i], consumables, items), 'item', names));
    }
    out.tasks[key] = {
      prereq: JSON.stringify(both(tp, ipScoped)),
      region: block.task_region[i], desc: block.task_description[i], priority: block.task_priority[i],
      count: m ? 'seq' : block.task_count[i], cost,
    };
  });
  const regionScopes = {
    task: { n: tasks.length, groups: null, regions, const: tasks.length, label: 'region task prereq' },
    item: { n: items.length, groups, regions: null, const: tasks.length, label: 'region item prereq' },
  };
  block.regions.forEach((r, i) => {
    const pr = mapScopedText(block.region_prereqs[i], t => resolveNameRefs(t, tasks)[0], t => resolveNameRefs(t, items)[0]);
    const ast = pr ? parsePrereq(pr, 0, 0, 'region prereq', null, regions, `region '${r}'`, tasks.length, regionScopes) : null;
    out.regions[r] = { prereq: JSON.stringify(canonAst(ast, 'task', names)), pct: String(block.region_default_pcts[i]), color: block.region_colors[i] };
  });
  if (block.goal_tasks.length) {
    out.goal = JSON.stringify(canonAst(parsePrereq(resolveScopedNameRefs(block.goal_tasks[0], 'task', tasks, items)[0], tasks.length, 0, 'goal tasks', null, regions, null, null, scopes), 'task', names));
  }
  out.items = items.map((n, k) => (block.item_fillers[k] ? `filler` : `${n}|${block.item_types[k]}|${block.item_count[k]}|${block.item_consumable[k]}|${block.item_progressive_group[k]}`)).sort();
  out.taskSlots = block.task_count.reduce((a, c) => a + Number(c), 0);
  out.itemSlots = block.item_count.reduce((a, c) => a + Number(c), 0);
  return out;
}

function diff(a, b, path = '') {
  const out = [];
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) out.push(...diff(a[k], b[k], `${path}.${k}`));
  return out;
}

export async function runRoundTrip(files) {
  const results = [];
  for (const f of files) {
    const text = await (await fetch(`corpus/${f}`)).text();
    const r = { file: f };
    try {
      let imp;
    try {
      imp = importDoc(defaultModel(), loadYaml(text));
    } catch (e) { r.skip = `official import threw: ${e.message}`; results.push(r); continue; }
      if (!imp.ok) { r.skip = 'official import failed'; results.push(r); continue; }
      imp.model.playerName ||= 'Tester';
      const official = await buildExport(imp.model, { confirm: async () => true, randomFiller: () => 'F' });
      if (!official.data) { r.skip = `official export failed: ${official.error?.join(': ')}`; results.push(r); continue; }
      const g = await importYaml(text);
      g.doc.settings.playerName ||= 'Tester';
      const mine = await exportYaml(g.doc);
      if (!mine.data) { r.fail = mine.problems.map(p => p.msg).join(' | '); results.push(r); continue; }
      const A = canonical(official.data.Taskipelago);
      const B = canonical(mine.data.Taskipelago);
      // Requirements on filler items are dropped on import (with a warning).
      r.diffs = diff(A, B).filter(d => !(/I:F\b/.test(d) && g.messages.some(m => /filler item/.test(m.msg))));
      r.tasks = Object.keys(A.tasks).length;
      r.nodes = Object.keys(g.doc.nodes).length;
      r.edges = Object.keys(g.doc.edges).length;
      r.importWarnings = g.messages.filter(m => m.level === 'warning').length;
    } catch (e) {
      r.fail = `${e.message}\n${e.stack}`;
    }
    results.push(r);
  }
  return results;
}
