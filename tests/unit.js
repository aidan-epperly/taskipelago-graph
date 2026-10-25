// Unit checks for the compiler, generation rules and the YAML round trip.

import { addEdge, canMoveInto, emptyDoc, goalNode, groupInto, makeNode, moveInto } from '../js/graph.js';
import { randomizeMeta } from '../js/randomize.js';
import { apworldMisreads, compile, exportYaml } from '../js/compile.js';
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

  await t('a random meta-node is a full-depth DAG with no redundant links', async () => {
    let seed = 7;
    const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (const [n, depth, extra] of [[12, 4, 2], [7, 7, 1], [9, 1, 3], [10, 3, 0]]) {
      const doc = emptyDoc();
      doc.settings.playerName = 'Tester';
      const ids = [];
      for (let i = 0; i < n; i++) { const x = makeNode('task', i * 10, 0, { name: `T${i}` }); doc.nodes[x.id] = x; ids.push(x.id); }
      const outside = makeNode('task', -500, 0, { name: 'Before' });
      doc.nodes[outside.id] = outside;
      const meta = groupInto(doc, ids, 'R');
      addEdge(doc, ids[0], ids[1]); // an old inner link, replaced
      addEdge(doc, outside.id, meta.input);
      const r = randomizeMeta(doc, meta.id, { depth, extra }, rng);
      if (r.layers !== depth) return `layers ${r.layers} != ${depth}`;
      const succ = new Map();
      for (const e of Object.values(doc.edges)) (succ.get(e.from) || succ.set(e.from, []).get(e.from)).push(e.to);
      // The longest Input -> Output path has depth tasks (extra links may skip layers).
      const lens = new Set();
      const walk = (id, k, seen) => {
        if (seen.has(id)) throw new Error('cycle');
        if (id === meta.output) { lens.add(k); return; }
        for (const nx of succ.get(id) || []) walk(nx, k + (doc.nodes[nx].kind === 'task' ? 1 : 0), new Set(seen).add(id));
      };
      walk(meta.input, 0, new Set());
      if (Math.max(...lens) !== depth) return `longest path ${Math.max(...lens)} for depth ${depth}`;
      for (const id of ids) {
        if (!Object.values(doc.edges).some(e => e.to === id) || !(succ.get(id) || []).length) return `${doc.nodes[id].name} is off the Input -> Output paths`;
      }
      // No link p -> u when u is reachable from p some other way.
      const reach = (a, b, skip) => (succ.get(a) || []).some(x => x !== skip && (x === b || reach(x, b, null)));
      for (const e of Object.values(doc.edges)) if (reach(e.from, e.to, e.to)) return `redundant link ${doc.nodes[e.from].name} -> ${doc.nodes[e.to].name}`;
      if (!Object.values(doc.edges).some(e => e.from === outside.id && e.to === meta.input)) return 'outside link was dropped';
      const c = compile(doc);
      if (errorsOf(c).length) return errorsOf(c).join('; ');
    }
    return true;
  });

  await t('moving into a meta-node keeps links and refuses cycles', async () => {
    const doc = emptyDoc();
    const add = name => { const n = makeNode('task', 0, 0, { name }); doc.nodes[n.id] = n; return n; };
    const a = add('A'); const b = add('B'); const c = add('C');
    const outer = groupInto(doc, [a.id], 'Outer');
    const inner = groupInto(doc, [a.id], 'Inner');
    const e = addEdge(doc, b.id, c.id);
    if (canMoveInto(doc, outer.id, inner.id)) return 'a meta-node went into its own child';
    if (canMoveInto(doc, outer.id, outer.id)) return 'a meta-node went into itself';
    if (canMoveInto(doc, goalNode(doc).id, outer.id)) return 'the goal moved';
    if (canMoveInto(doc, outer.input, inner.id)) return 'a port moved';
    const moved = moveInto(doc, [b.id, c.id, outer.id], inner.id);
    if (moved.join() !== [b.id, c.id].join()) return `moved ${moved}`;
    if (b.parent !== inner.id || !doc.edges[e.id]) return 'link or parent lost';
    return true;
  });

  await t('names the apworld would misread are exported as row numbers', async () => {
    const bad = ['Laundry (1/4)', 'Meditate #2', 'Work 4 Hours', '4am run'];
    const good = ['Item7', 'Go On a Hike', 'Kitchen-50'];
    for (const n of bad) if (!apworldMisreads(n)) return `${n} should be flagged`;
    for (const n of good) if (apworldMisreads(n)) return `${n} should not be flagged`;
    const { doc } = build({
      nodes: [['Laundry (1/4)', 'task', {}], ['Laundry (2/4)', 'task', {}], ['Hike', 'task', {}], ['After', 'task', {}]],
      edges: [['Laundry (1/4)', 'Laundry (2/4)'], ['Laundry (2/4)', 'After'], ['Hike', 'After']],
    });
    const r = await exportYaml(doc);
    if (!r.ok) return r.problems.map(p => p.msg).join('; ');
    const T = r.data.Taskipelago;
    const row = n => String(T.tasks.indexOf(n) + 1);
    const pre = n => T.task_prereqs[T.tasks.indexOf(n)];
    if (pre('Laundry (2/4)') !== row('Laundry (1/4)')) return `got ${pre('Laundry (2/4)')}`;
    if (!pre('After').includes(row('Laundry (2/4)')) || !pre('After').includes('"Hike"')) return `got ${pre('After')}`;
    // Reopened without the layout comment, the numbers come back as the same links.
    const back = await importYaml(r.text);
    const names = Object.values(back.doc.edges).map(e => `${back.doc.nodes[e.from]?.name}>${back.doc.nodes[e.to]?.name}`).sort();
    const want = ['Hike>After', 'Laundry (1/4)>Laundry (2/4)', 'Laundry (2/4)>After'];
    return want.every(w => names.includes(w)) || `re-import links ${names}`;
  });

  return results;
}
