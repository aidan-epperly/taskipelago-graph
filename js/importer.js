// Taskipelago YAML -> graph. The generator's own importDoc reads the YAML into
// its editor model, then every prereq, cost and goal expression is parsed with
// the generator's parser and turned into edges and gate nodes.

import { defaultModel } from '../vendor/taskipelago/js/generator/model.js';
import { importDoc } from '../vendor/taskipelago/js/generator/yaml_import.js';
import { convertCostIdxToQuote, resolveNameRefs, resolveScopedNameRefs } from '../vendor/taskipelago/js/generator/yaml_export.js';
import { mapScopedText, parseCostExpr, parsePrereq, prereqScopes } from '../vendor/taskipelago/js/shared/prereq_parser.js';
import { loadYaml } from '../vendor/taskipelago/js/shared/yaml11.js';
import { addEdge, defaultSettings, emptyDoc, goalNode, makeNode, normalizeDoc } from './graph.js';
import { layoutLevel } from './layout.js';

const LAYOUT_TAG = '# taskipelago-graph-layout:';

// ---------------------------------------------------------------------------
// Embedded layout: the exported YAML carries the graph in a trailing comment,
// so re-importing an unchanged export restores positions and meta-nodes.
// ---------------------------------------------------------------------------

export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

async function deflate(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function inflate(b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

export async function withEmbeddedLayout(yamlText, doc) {
  if (typeof CompressionStream === 'undefined') return yamlText;
  return `${yamlText}${LAYOUT_TAG} ${fnv1a(yamlText)} ${await deflate(JSON.stringify(doc))}\n`;
}

async function embeddedLayout(text) {
  const at = text.lastIndexOf(LAYOUT_TAG);
  if (at < 0 || typeof DecompressionStream === 'undefined') return null;
  const body = text.slice(0, at);
  const [hash, b64] = text.slice(at + LAYOUT_TAG.length).trim().split(/\s+/);
  if (hash !== fnv1a(body)) return null; // edited since export: rebuild from the YAML
  try {
    return normalizeDoc(JSON.parse(await inflate(b64)));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------

/** Parse YAML text into a graph document. Returns { doc, messages, restored }. */
export async function importYaml(text) {
  const restored = await embeddedLayout(text);
  if (restored) return { doc: restored, messages: [], restored: true };
  const parsed = loadYaml(text);
  const res = importDoc(defaultModel(), parsed);
  const messages = res.messages.map(([level, title, msg]) => ({ level, title, msg }));
  if (!res.ok) return { doc: null, messages };
  const doc = modelToGraph(res.model, messages);
  return { doc, messages, restored: false };
}

const SETTING_KEYS = Object.keys(defaultSettings());

export function modelToGraph(model, messages = []) {
  const doc = emptyDoc();
  const warn = msg => messages.push({ level: 'warning', title: 'Import', msg });
  for (const k of SETTING_KEYS) if (k in model) doc.settings[k] = structuredClone(model[k]);
  doc.settings.deathLink = (model.deathLink || []).map(d => ({ text: d.text, weight: d.weight }));
  const add = n => { doc.nodes[n.id] = n; return n; };

  // Regions and groups.
  const regionId = new Map();
  for (const r of model.regions) {
    const rr = model.regionRandom?.[r.name] || {};
    const n = add(makeNode('region', 0, 0, {
      name: r.name, pct: Number(r.pct ?? 100), color: r.color || '',
      randomOn: !!rr.on, randomPick: rr.pick || '', randomOrder: !!rr.order,
      disabled: !!r.disabled, manual: !!r.manual, distributed: !!r.distributed, offlineRate: r.offlineRate || '',
    }));
    regionId.set(r.name, n.id);
  }
  for (const r of model.regions) if (r.parent) doc.nodes[regionId.get(r.name)].parentRegion = regionId.get(r.parent) || '';
  const groupId = new Map();
  for (const g of model.progGroups) {
    const s = model.groupSettings?.[g] || {};
    const n = add(makeNode('group', 0, 0, {
      name: g, gtype: s.type || 'progressive', color: model.progGroupColors?.[g] || '',
      pick: s.pick || '', pct: s.pct ?? '', early: !!s.early, disabled: !!s.disabled,
    }));
    groupId.set(g, n.id);
  }
  for (const g of model.progGroups) {
    const p = model.groupSettings?.[g]?.parent;
    if (p) doc.nodes[groupId.get(g)].parentGroup = groupId.get(p) || '';
  }
  const groupType = name => doc.nodes[groupId.get(name)]?.gtype || 'progressive';

  // Items. Filler rows become the automatic filler when the slot balances.
  const taskSlots = model.tasks.reduce((a, t) => a + Math.max(1, Number(t.count) || 1), 0);
  const itemSlots = model.items.reduce((a, i) => a + Math.max(1, Number(i.count) || 1), 0);
  const dropFiller = taskSlots === itemSlots;
  doc.settings.autoFiller = dropFiller || !model.items.some(i => i.filler);
  const itemNode = [];
  let fillerNode = null;
  model.items.forEach(it => {
    if (it.filler) {
      if (dropFiller) { itemNode.push(null); return; }
      if (fillerNode) { fillerNode.count += Math.max(1, Number(it.count) || 1); itemNode.push(fillerNode.id); return; }
      fillerNode = add(makeNode('item', 0, 0, { name: 'Filler', filler: true, type: 'junk', count: Math.max(1, Number(it.count) || 1) }));
      itemNode.push(fillerNode.id);
      return;
    }
    const n = add(makeNode('item', 0, 0, {
      name: it.name, type: it.type || 'useful', count: Math.max(1, Number(it.count) || 1),
      consumable: !!it.consumable, early: !!it.early, group: groupId.get(it.progGroup) || '',
      clickerKind: it.clickerKind || 'none', clickerTarget: it.clickerTarget || '*', clickerValue: it.clickerValue || '',
    }));
    itemNode.push(n.id);
  });
  const itemNames = model.items.map(i => i.name);
  const consumableSet = new Set(model.items.filter(i => i.consumable && i.name).map(i => i.name));
  const itemByName = name => {
    const i = model.items.findIndex(x => x.name === name && !x.filler);
    return i >= 0 ? itemNode[i] : null;
  };

  // Tasks. A 'sequential' task with copies stays one node with `sequential` set.
  const taskNames = model.tasks.map(t => t.name);
  const nTasks = taskNames.length;
  const nItems = itemNames.length;
  const regionSet = new Set(model.regions.map(r => r.name));
  const groupSet = new Set(model.progGroups);
  const scopes = prereqScopes(nTasks, nItems, regionSet, groupSet);
  const taskFirst = [];
  const taskLast = [];
  const taskAll = [];

  const parseTaskField = (text, i, home) => {
    if (!text) return null;
    const [resolved] = resolveScopedNameRefs(text, home, taskNames, itemNames);
    return home === 'task'
      ? parsePrereq(resolved, nTasks, i, 'task prereq', groupSet, regionSet, null, null, scopes)
      : parsePrereq(resolved, nItems, i, 'item prereq', groupSet, null, null, null, scopes);
  };

  const hasSeq = ast => Array.isArray(ast) && (ast[0] === 'seq_flag'
    || (['and', 'or', 'scoped_task', 'scoped_item'].includes(ast[0]) && ast[1].some(hasSeq)));
  const stripTopSeq = ast => {
    if (!Array.isArray(ast)) return [ast, false];
    if (ast[0] === 'seq_flag') return [null, true];
    if (ast[0] === 'and' && ast[1].some(k => Array.isArray(k) && k[0] === 'seq_flag')) {
      const rest = ast[1].filter(k => !(Array.isArray(k) && k[0] === 'seq_flag'));
      if (rest.some(hasSeq)) return [ast, false];
      return [rest.length === 1 ? rest[0] : ['and', rest], true];
    }
    return [ast, false];
  };

  const parsed = model.tasks.map((t, i) => {
    const out = { taskAst: null, itemAst: null, seq: false, rawTask: '', rawItem: '' };
    try {
      const ast = parseTaskField(t.prereq, i, 'task');
      const [rest, seq] = stripTopSeq(ast);
      if (hasSeq(rest)) out.rawTask = t.prereq;
      else { out.taskAst = rest; out.seq = seq && Number(t.count) > 1; }
    } catch (e) {
      out.rawTask = t.prereq;
      warn(`Task “${t.name}”: kept its task prereq as text (${e.message})`);
    }
    try {
      out.itemAst = parseTaskField(t.itemPrereq, i, 'item');
    } catch (e) {
      out.rawItem = t.itemPrereq;
      warn(`Task “${t.name}”: kept its item prereq as text (${e.message})`);
    }
    return out;
  });

  model.tasks.forEach((t, i) => {
    const count = Math.max(1, Number(t.count) || 1);
    const p = parsed[i];
    const base = {
      desc: t.desc || '', region: regionId.get(t.region) || '', priority: !!t.priority,
      activations: t.activations || '', manual: !!t.manual, autoComplete: !!t.autoComplete,
      renewable: !!t.renewable, renewableCurrency: itemByName(t.renewableCurrency) || '',
      renewableAmount: t.renewableAmount || '',
      extraPrereq: p.rawTask, extraItemPrereq: p.rawItem,
    };
    const n = add(makeNode('task', 0, 0, { ...base, name: t.name, count, sequential: p.seq }));
    taskFirst.push(n.id); taskLast.push(n.id); taskAll.push([n.id]);
  });

  // AST -> {op, kids} / {src, cond}
  const conv = (ast, dom) => {
    if (ast === null || ast === undefined) return null;
    if (typeof ast === 'number') {
      if (dom === 'item') {
        if (itemNode[ast]) return { src: itemNode[ast], cond: { copies: 1 } };
        warn(`Dropped a requirement on filler item ${ast + 1} (filler gets a random name, so it cannot be referenced).`);
        return null;
      }
      return { src: taskLast[ast], cond: {} };
    }
    const [op, a, b] = ast;
    switch (op) {
      case 'and': case 'or': return { op, kids: a.map(k => conv(k, dom)).filter(Boolean) };
      case 'scoped_task': return conv(a[0], 'task');
      case 'scoped_item': return conv(a[0], 'item');
      case 'item_copies': return itemNode[a] ? { src: itemNode[a], cond: { copies: b } } : conv(a, 'item');
      case 'group_ref': {
        const prog = groupType(a) === 'progressive';
        const cond = b === null ? { mode: prog ? 'next' : 'default', n: 1 } : { mode: prog ? 'position' : 'pct', n: b };
        return { src: groupId.get(a), cond };
      }
      case 'group_count': return { src: groupId.get(a), cond: { mode: 'count', n: b } };
      case 'region_ref': return { src: regionId.get(a), cond: b === null ? { mode: 'default', n: 100 } : { mode: 'pct', n: b } };
      case 'region_abs': return { src: regionId.get(a), cond: { mode: 'count', n: b } };
      default: return null;
    }
  };

  const attach = (tree, target) => {
    if (!tree) return;
    const nodeFor = t => {
      if (!t.op) return t;
      if (t.kids.length === 1) return nodeFor(t.kids[0]);
      const g = add(makeNode('gate', 0, 0, { op: t.op }));
      for (const k of t.kids) link(nodeFor(k), g.id);
      return { src: g.id, cond: {} };
    };
    const link = (leaf, to) => {
      if (!leaf || !leaf.src) return;
      if (Object.values(doc.edges).some(e => e.from === leaf.src && e.to === to && e.kind === 'req')) return;
      addEdge(doc, leaf.src, to, 'req', leaf.cond);
    };
    let t = tree;
    while (t.op && t.kids.length === 1) t = t.kids[0];
    if (t.op) {
      if (t.kids.length === 0) return;
      target.combine = t.op;
      for (const k of t.kids) link(nodeFor(k), target.id);
    } else link(t, target.id);
  };

  const both = (x, y) => (x && y ? { op: 'and', kids: [x, y] } : x || y);
  const flatten = t => {
    if (!t || !t.op) return t;
    const kids = [];
    for (const k of t.kids.map(flatten).filter(Boolean)) {
      if (k.op === t.op) kids.push(...k.kids);
      else kids.push(k);
    }
    return { op: t.op, kids };
  };

  model.tasks.forEach((t, i) => {
    const tree = flatten(both(conv(parsed[i].taskAst, 'task'), conv(parsed[i].itemAst, 'item')));
    attach(tree, doc.nodes[taskFirst[i]]);
    // Costs: a plain AND of currencies becomes cost edges; anything else stays text.
    if (t.cost) {
      const cost = convertCostIdxToQuote(t.cost, itemNames);
      let ast = null;
      try {
        ast = parseCostExpr(cost, consumableSet, itemNames);
      } catch (e) {
        warn(`Task “${t.name}”: kept its cost as text (${e.message})`);
      }
      const parts = !ast ? null : ast[0] === 'cost_group' ? [ast] : ast[0] === 'and' && ast[1].every(k => k[0] === 'cost_group') ? ast[1] : null;
      for (const id of taskAll[i]) {
        if (parts && parts.every(([, name]) => itemByName(name))) {
          for (const [, name, count] of parts) addEdge(doc, itemByName(name), id, 'cost', { amount: count });
        } else doc.nodes[id].extraCost = cost;
      }
    }
  });

  // Region dependencies.
  const regionScopes = {
    task: { n: nTasks, groups: null, regions: regionSet, const: nTasks, label: 'region task prereq' },
    item: { n: nItems, groups: groupSet, regions: null, const: nTasks, label: 'region item prereq' },
  };
  for (const r of model.regions) {
    if (!r.prereq) continue;
    const node = doc.nodes[regionId.get(r.name)];
    try {
      const resolved = mapScopedText(r.prereq, x => resolveNameRefs(x, taskNames)[0], x => resolveNameRefs(x, itemNames)[0]);
      const ast = parsePrereq(resolved, 0, 0, 'region prereq', null, regionSet, `region '${r.name}'`, nTasks, regionScopes);
      attach(flatten(conv(ast, 'region')), node);
    } catch (e) {
      node.extraPrereq = r.prereq;
      warn(`Region ${r.name}: kept its dependency as text (${e.message})`);
    }
  }

  // Goal.
  if (model.goalTasks) {
    try {
      const [resolved] = resolveScopedNameRefs(model.goalTasks, 'task', taskNames, itemNames);
      const ast = parsePrereq(resolved, nTasks, 0, 'goal tasks', null, regionSet, null, null, scopes);
      attach(flatten(conv(ast, 'task')), goalNode(doc));
    } catch (e) {
      doc.settings.extraGoal = model.goalTasks;
      warn(`Kept the goal as text (${e.message})`);
    }
  }

  layoutLevel(doc, null);
  return doc;
}
