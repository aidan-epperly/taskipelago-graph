// Unit checks for the compiler, generation rules and the YAML round trip.

import { addEdge, emptyDoc, goalNode, makeNode } from '../js/graph.js';
import { compile, exportYaml } from '../js/compile.js';
import { importYaml, withEmbeddedLayout } from '../js/importer.js';
import { exampleDoc } from '../js/example.js';

function build(spec) {
  const doc = emptyDoc();
  doc.settings.playerName = 'Tester';
  const by = {};
  for (const [key, kind, data] of spec.nodes) {
    const n = makeNode(kind, 0, 0, { name: key, ...data });
    doc.nodes[n.id] = n;
    by[key] = n;
  }
  for (const n of Object.values(by)) {
    if (n.kind === 'task' && n.region) n.region = by[n.region].id;
    if (n.kind === 'item' && n.group) n.group = by[n.group].id;
  }
  by.goal = goalNode(doc);
  for (const [a, b, cond, kind] of spec.edges || []) addEdge(doc, by[a].id, by[b].id, kind || 'req', cond);
  return { doc, by };
}

const errorsOf = c => c.problems.filter(p => p.level === 'error').map(p => p.msg);

export async function runUnit() {
  const results = [];
  const t = async (name, fn) => {
    try {
      const r = await fn();
      results.push({ name, ok: r === true, detail: r === true ? '' : String(r) });
    } catch (e) {
      results.push({ name, ok: false, detail: `${e.message}\n${e.stack}` });
    }
  };

  await t('example exports cleanly', async () => {
    const r = await exportYaml(exampleDoc());
    const errs = r.problems.filter(p => p.level === 'error');
    return r.ok && !errs.length ? true : JSON.stringify(r.problems);
  });

  await t('task requiring its own region is an error', () => {
    const { doc } = build({
      nodes: [['R', 'region', {}], ['A', 'task', { region: 'R' }], ['B', 'task', { region: 'R' }]],
      edges: [['R', 'B', { mode: 'pct', n: 50 }]],
    });
    return errorsOf(compile(doc)).some(m => /cannot require that region/.test(m)) || errorsOf(compile(doc));
  });

  await t('circular requirement is caught', () => {
    const { doc, by } = build({ nodes: [['A', 'task', {}], ['B', 'task', {}], ['C', 'task', {}]], edges: [['A', 'B'], ['B', 'C']] });
    addEdge(doc, by.C.id, by.A.id); // bypasses the link-time cycle guard, as an import could
    const errs = errorsOf(compile(doc));
    return errs.filter(m => /can never be unlocked/.test(m)).length === 3 || errs;
  });

  await t('an OR branch breaks a cycle', () => {
    const { doc, by } = build({ nodes: [['A', 'task', { combine: 'or' }], ['B', 'task', {}], ['K', 'item', {}]], edges: [['A', 'B'], ['K', 'A']] });
    addEdge(doc, by.B.id, by.A.id);
    const errs = errorsOf(compile(doc));
    return !errs.length || errs;
  });

  await t('region task count above its size is an error', () => {
    const { doc } = build({ nodes: [['R', 'region', {}], ['A', 'task', { region: 'R' }], ['B', 'task', {}]], edges: [['R', 'B', { mode: 'count', n: 2 }]] });
    return errorsOf(compile(doc)).some(m => /has 1/.test(m)) || errorsOf(compile(doc));
  });

  await t('region needing its own task is an error', () => {
    const { doc } = build({ nodes: [['R', 'region', {}], ['A', 'task', { region: 'R' }], ['B', 'task', {}]], edges: [['A', 'R']] });
    return errorsOf(compile(doc)).some(m => /requires its own task/.test(m)) || errorsOf(compile(doc));
  });

  await t('mixed OR renders with item(...)', () => {
    const { doc } = build({ nodes: [['A', 'task', {}], ['B', 'task', { combine: 'or' }], ['Key', 'item', {}]], edges: [['A', 'B'], ['Key', 'B']] });
    const row = compile(doc).model.tasks.find(x => x.name === 'B');
    return (row.prereq === '"A" || item("Key")' && row.itemPrereq === '') || JSON.stringify(row);
  });

  await t('AND splits task and item fields', () => {
    const { doc } = build({
      nodes: [['A', 'task', {}], ['B', 'task', {}], ['Key', 'item', { count: 3 }], ['G', 'group', {}], ['Gem', 'item', { group: 'G', count: 2 }]],
      edges: [['A', 'B'], ['Key', 'B', { copies: 2 }], ['G', 'B', { mode: 'count', n: 2 }]],
    });
    const row = compile(doc).model.tasks.find(x => x.name === 'B');
    return (row.prereq === '"A"' && /"Key"\*2/.test(row.itemPrereq) && /G\*2/.test(row.itemPrereq)) || JSON.stringify(row);
  });

  await t('nested gate renders with parentheses', () => {
    const { doc } = build({
      nodes: [['A', 'task', {}], ['B', 'task', {}], ['C', 'task', {}], ['D', 'task', {}], ['g', 'gate', { op: 'and' }]],
      edges: [['A', 'g'], ['B', 'g'], ['g', 'D'], ['C', 'D']],
    });
    doc.nodes[Object.values(doc.nodes).find(n => n.name === 'D').id].combine = 'or';
    const row = compile(doc).model.tasks.find(x => x.name === 'D');
    return row.prereq === '("A" && "B") || "C"' || row.prereq;
  });

  await t('region prereq uses task(...) and item(...) scopes', () => {
    const { doc } = build({
      nodes: [['R', 'region', {}], ['S', 'region', {}], ['A', 'task', {}], ['X', 'task', { region: 'R' }], ['Y', 'task', { region: 'S' }], ['Key', 'item', {}]],
      edges: [['A', 'S'], ['R', 'S', { mode: 'pct', n: 50 }], ['Key', 'S']],
    });
    const row = compile(doc).model.regions.find(r => r.name === 'S');
    return row.prereq === 'task("A") && R-50 && item("Key")' || row.prereq;
  });

  await t('a sequential task compiles to the sequential keyword', () => {
    const { doc } = build({ nodes: [['A', 'task', {}], ['B', 'task', { count: 3, sequential: true }]], edges: [['A', 'B']] });
    const row = compile(doc).model.tasks.find(x => x.name === 'B');
    return (row.prereq === 'sequential && "A"' && row.count === 3) || JSON.stringify(row);
  });

  await t('a sequential YAML task imports as one node', async () => {
    const { doc } = build({ nodes: [['A', 'task', {}], ['B', 'task', { count: 4, sequential: true }]], edges: [['A', 'B']] });
    const r = await exportYaml(doc);
    const back = await importYaml(r.text);
    const tasks = Object.values(back.doc.nodes).filter(n => n.kind === 'task');
    const b = tasks.find(n => n.name === 'B');
    return (tasks.length === 2 && b && b.count === 4 && b.sequential) || JSON.stringify(tasks.map(n => [n.name, n.count, n.sequential]));
  });

  await t('cost edges compile to a cost', () => {
    const { doc } = build({ nodes: [['Gold', 'item', { consumable: true, count: 5 }], ['A', 'task', {}]], edges: [['Gold', 'A', { amount: 3 }, 'cost']] });
    const row = compile(doc).model.tasks.find(x => x.name === 'A');
    return row.cost === '"Gold"*3' || row.cost;
  });

  await t('embedded layout restores the exact graph', async () => {
    const doc = exampleDoc();
    const r = await exportYaml(doc);
    const text = await withEmbeddedLayout(r.text, doc);
    const back = await importYaml(text);
    const canon = v => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
    if (!back.restored) return 'not restored';
    return JSON.stringify(canon(back.doc)) === JSON.stringify(canon(doc)) || 'restored graph differs';
  });

  await t('edited YAML ignores the stale layout', async () => {
    const doc = exampleDoc();
    const r = await exportYaml(doc);
    const text = (await withEmbeddedLayout(r.text, doc)).replace('Wash dishes', 'Wash all dishes');
    const back = await importYaml(text);
    return (!back.restored && Object.values(back.doc.nodes).some(n => n.name === 'Wash all dishes')) || 'restored stale layout';
  });

  await t('graph -> YAML -> graph -> YAML is stable', async () => {
    const r1 = await exportYaml(exampleDoc());
    const g = await importYaml(r1.text);
    const r2 = await exportYaml(g.doc);
    const strip = d => {
      const x = structuredClone(d.Taskipelago);
      delete x.items; delete x.item_types; delete x.item_fillers; delete x.item_count; delete x.item_consumable; delete x.item_progressive_group;
      return x;
    };
    // Same tasks with the same fields, though the order may change.
    const A = strip(r1.data);
    const B = strip(r2.data);
    // OR operands may come back in another order (they follow the layout).
    const norm = e => (e || '').split(' || ').sort().join(' || ');
    const rows = x => x.tasks.map((n, i) => [n, x.task_region[i], norm(x.task_prereqs[i]), x.item_prereqs[i], x.task_cost[i]].join('|')).sort().join('\n');
    const normAnd = l => l.map(e => e.split(" && ").sort().join(" && "));
    return (rows(A) === rows(B) && JSON.stringify(normAnd(A.goal_tasks)) === JSON.stringify(normAnd(B.goal_tasks))
      && JSON.stringify(A.region_prereqs) === JSON.stringify(B.region_prereqs))
      || JSON.stringify({ rowsSame: rows(A) === rows(B), goal: [A.goal_tasks, B.goal_tasks], rp: [A.regions, A.region_prereqs, B.regions, B.region_prereqs] });
  });

  return results;
}
