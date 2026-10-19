// Generation-time rules the apworld enforces in Python that the generator's
// JS export does not check (custom_worlds/taskipelago/__init__.py). Without
// these, a slot could pass export and still fail when the seed is generated.

import { descendants, nodeTitle, nodesOf } from './graph.js';

/** Requirement sources reaching `id`, looking through gates: [{ node, cond, kind }]. */
export function reqLeaves(doc, id, seen = new Set()) {
  const out = [];
  for (const e of Object.values(doc.edges)) {
    if (e.to !== id || e.kind !== 'req') continue;
    const a = doc.nodes[e.from];
    if (!a) continue;
    if (a.kind === 'gate') {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(...reqLeaves(doc, a.id, seen));
    } else out.push({ node: a, cond: e.cond || {} });
  }
  return out;
}

const title = n => `“${nodeTitle(n)}”`;

export function generationChecks(doc) {
  const problems = [];
  const err = (msg, nodeId) => problems.push({ level: 'error', title: 'Generation rule', msg, nodeId });
  const regions = nodesOf(doc, 'region');
  const tasks = nodesOf(doc, 'task');
  const items = nodesOf(doc, 'item');
  const parentOf = r => doc.nodes[r.parentRegion];
  // Task slots per region; a parent also counts its subregions' tasks.
  const ownSlots = new Map(regions.map(r => [r.id, 0]));
  for (const t of tasks) if (ownSlots.has(t.region)) ownSlots.set(t.region, ownSlots.get(t.region) + Math.max(1, t.count || 1));
  const slots = new Map(regions.map(r => [r.id, ownSlots.get(r.id)]));
  for (const r of regions) if (parentOf(r)) slots.set(r.parentRegion, slots.get(r.parentRegion) + ownSlots.get(r.id));
  const groupSize = new Map(nodesOf(doc, 'group').map(g => [g.id, 0]));
  for (const i of items) {
    if (i.filler || i.consumable || !groupSize.has(i.group)) continue;
    groupSize.set(i.group, groupSize.get(i.group) + Math.max(1, i.count || 1));
    const p = doc.nodes[i.group]?.parentGroup;
    if (groupSize.has(p)) groupSize.set(p, groupSize.get(p) + Math.max(1, i.count || 1));
  }
  const need = (r, cond) => {
    const size = slots.get(r.id) || 0;
    if (cond.mode === 'count') return Number(cond.n) || 0;
    const pct = cond.mode === 'pct' ? Number(cond.n) : Number(r.pct ?? 100);
    return Math.ceil(size * pct / 100);
  };

  const groupModes = new Map();
  const checkLeaves = (target, leaves) => {
    for (const { node: a, cond } of leaves) {
      if (a.kind === 'region') {
        const size = slots.get(a.id) || 0;
        if (!size && !a.disabled) err(`${title(target)} requires region ${title(a)}, which has no tasks.`, target.id);
        if (cond.mode === 'count' && size && (cond.n < 1 || cond.n > size)) {
          err(`${title(target)} requires ${cond.n} tasks of ${title(a)}, which has ${size}.`, target.id);
        }
      }
      if (a.kind === 'group') {
        const size = groupSize.get(a.id) || 0;
        if (!size && !a.disabled) err(`${title(target)} requires item group ${title(a)}, which has no items.`, target.id);
        else if (cond.mode === 'count' && cond.n > size) err(`${title(target)} requires ${cond.n} items of ${title(a)}, which has ${size}.`, target.id);
        if (a.gtype === 'progressive') {
          const mode = cond.mode === 'count' ? 'count' : 'order';
          (groupModes.get(a.id) || groupModes.set(a.id, new Set()).get(a.id)).add(mode);
        }
      }
    }
  };

  for (const t of tasks) {
    const leaves = reqLeaves(doc, t.id);
    checkLeaves(t, leaves);
    const own = doc.nodes[t.region];
    if (!own) continue;
    for (const { node: a, cond } of leaves) {
      if (a.id === own.id) {
        err(`${title(t)} is in region ${title(own)}, so it cannot require that region's progress. Link a specific task instead, or move it to another region.`, t.id);
      } else if (a.kind === 'region' && own.parentRegion === a.id) {
        const outside = (slots.get(a.id) || 0) - (ownSlots.get(own.id) || 0);
        if (need(a, cond) > outside) {
          err(`${title(t)} in subregion ${title(own)} needs ${need(a, cond)} tasks of parent ${title(a)}, which has only ${outside} outside ${title(own)}.`, t.id);
        }
      }
    }
  }

  for (const r of regions) {
    const leaves = reqLeaves(doc, r.id);
    checkLeaves(r, leaves);
    for (const { node: a } of leaves) {
      if (a.kind === 'task' && (a.region === r.id || doc.nodes[a.region]?.parentRegion === r.id)) {
        err(`Region ${title(r)} requires its own task ${title(a)}.`, r.id);
      }
      if (a.kind === 'region' && a.parentRegion === r.id) {
        err(`Region ${title(r)} requires its own subregion ${title(a)}.`, r.id);
      }
    }
  }

  const goal = nodesOf(doc, 'goal')[0];
  if (goal) checkLeaves(goal, reqLeaves(doc, goal.id));

  for (const [gid, modes] of groupModes) {
    if (modes.size > 1) {
      err(`Progressive group ${title(doc.nodes[gid])} is used both as “at least N” and in ordering mode (next / position). Pick one style for the whole group.`, gid);
    }
  }

  if (!problems.length) {
    const { stuck, goalOk } = unreachableTasks(doc, slots, groupSize);
    if (!goalOk && !stuck.length) err('The goal can never be reached, even with every task done and every item received.', nodesOf(doc, 'goal')[0].id);
    for (const t of stuck.slice(0, 8)) {
      err(`${title(t)} can never be unlocked, even with every item received: its requirements go in a circle or ask for more than exists.`, t.id);
    }
    if (stuck.length > 8) err(`…and ${stuck.length - 8} more tasks that can never be unlocked.`, stuck[8].id);
  }
  return problems;
}

/**
 * Tasks that stay locked even if every item is received: start with nothing
 * done and keep completing whatever is available until nothing changes.
 */
export function unreachableTasks(doc, slots, groupSize) {
  const tasks = nodesOf(doc, 'task').filter(t => !isDisabled(doc, t.region));
  const done = new Set();
  const progress = new Map();
  const bump = (rid, c) => progress.set(rid, (progress.get(rid) || 0) + c);
  const regionNeed = (r, cond) => {
    const size = slots.get(r.id) || 0;
    if (cond.mode === 'count') return Number(cond.n) || 0;
    const pct = cond.mode === 'pct' ? Number(cond.n) : Number(r.pct ?? 100);
    return Math.ceil(size * pct / 100);
  };
  const sourceOk = (a, cond, seen) => {
    switch (a.kind) {
      case 'task': return done.has(a.id) || isDisabled(doc, a.region);
      case 'item': return (Number(cond.copies) || 1) <= Math.max(1, a.count || 1);
      case 'group': return cond.mode !== 'count' || (Number(cond.n) || 1) <= (groupSize.get(a.id) || 0) || a.disabled;
      case 'region': return a.disabled || (progress.get(a.id) || 0) >= regionNeed(a, cond);
      case 'gate': return reqOk(a, seen);
      default: return true;
    }
  };
  const reqOk = (n, seen = new Set()) => {
    if (seen.has(n.id)) return false;
    const next = new Set(seen).add(n.id);
    const ins = Object.values(doc.edges).filter(e => e.to === n.id && e.kind === 'req' && doc.nodes[e.from]);
    if (!ins.length && n.role === 'output') {
      return descendants(doc, n.parent).every(t => t.kind !== 'task' || done.has(t.id) || isDisabled(doc, t.region));
    }
    if (!ins.length) return true;
    const ok = e => sourceOk(doc.nodes[e.from], e.cond || {}, next);
    const any = n.kind === 'gate' ? n.op === 'or' : n.combine === 'or';
    return any ? ins.some(ok) : ins.every(ok);
  };
  const unlocked = (rid, depth = 0) => {
    const r = doc.nodes[rid];
    if (!r || r.kind !== 'region' || depth > 4) return true;
    if (!reqOk(r)) return false;
    const p = doc.nodes[r.parentRegion];
    if (!p) return true;
    const parentOwn = tasks.some(t => t.region === p.id);
    if (parentOwn && (progress.get(p.id) || 0) < regionNeed(p, { mode: 'default' })) return false;
    return unlocked(p.id, depth + 1);
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (done.has(t.id) || !unlocked(t.region) || !reqOk(t)) continue;
      done.add(t.id);
      changed = true;
      const c = Math.max(1, t.count || 1);
      const r = doc.nodes[t.region];
      if (r) { bump(r.id, c); if (doc.nodes[r.parentRegion]) bump(r.parentRegion, c); }
    }
  }
  const goal = nodesOf(doc, 'goal')[0];
  return { stuck: tasks.filter(t => !done.has(t.id)), goalOk: !goal || reqOk(goal) };
}

function isDisabled(doc, rid) {
  const r = doc.nodes[rid];
  if (!r || r.kind !== 'region') return false;
  return !!r.disabled || !!doc.nodes[r.parentRegion]?.disabled;
}
