// Random wiring inside a meta-node: its tasks (and nested meta-nodes) become a
// layered DAG running from the meta-node's Input to its Output.

import { addEdge, ensurePorts, portFor, repAt } from './graph.js';

/** The nodes a random wiring links: tasks and nested meta-nodes directly inside `metaId`. */
export const randomUnits = (doc, metaId) => Object.values(doc.nodes)
  .filter(n => n.parent === metaId && (n.kind === 'task' || n.kind === 'meta'));

/** A depth that gives a reasonably deep, not purely linear, structure. */
export const defaultDepth = n => Math.max(1, Math.min(n, Math.round(1.5 * Math.sqrt(n))));

/**
 * Rewire the meta-node `metaId` at random, replacing the requirement links between
 * the nodes inside (links to and from outside stay).
 *   depth     number of layers (1..units)
 *   extra     maximum extra prerequisites per node, beyond the one from the layer before
 * Every node in a layer requires one in the layer before (the first layer hangs off
 * Input), every node feeds one in the next layer, and the last layer feeds Output, so
 * every path runs the full depth. Extra links never repeat an existing dependency.
 * Returns { layers, links } or null when there is nothing to link.
 */
export function randomizeMeta(doc, metaId, { depth, extra = 1 } = {}, rng = Math.random) {
  const meta = doc.nodes[metaId];
  if (!meta || meta.kind !== 'meta') return null;
  ensurePorts(doc, meta);
  const units = randomUnits(doc, metaId);
  if (!units.length) return null;
  const inside = new Set([...units.map(u => u.id), meta.input, meta.output]);
  for (const [eid, e] of Object.entries(doc.edges)) {
    if (e.kind !== 'req') continue;
    const a = repAt(doc, e.from, metaId);
    const b = repAt(doc, e.to, metaId);
    if (a && b && a !== b && inside.has(a) && inside.has(b)) delete doc.edges[eid];
  }

  const pick = list => list[Math.floor(rng() * list.length)];
  const order = units.map(u => u.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const L = Math.max(1, Math.min(order.length, Math.round(depth) || defaultDepth(order.length)));
  const layers = Array.from({ length: L }, (_, k) =>
    order.slice(Math.round(k * order.length / L), Math.round((k + 1) * order.length / L)));

  const prereqs = new Map(order.map(id => [id, new Set()]));
  const anc = new Map();
  const link = (from, to) => prereqs.get(to).add(from);
  for (let k = 1; k < L; k++) {
    const prev = layers[k - 1];
    const fed = new Set();
    // One prerequisite each from the layer before, preferring nodes that feed nothing yet.
    for (const u of layers[k]) {
      const free = prev.filter(x => !fed.has(x));
      const p = pick(free.length ? free : prev);
      link(p, u);
      fed.add(p);
    }
    for (const p of prev) if (!fed.has(p)) link(p, pick(layers[k]));
    // Earlier layers are final now, so ancestor sets are exact and extras stay non-redundant.
    for (const id of prev) anc.set(id, new Set([...prereqs.get(id)].flatMap(p => [p, ...anc.get(p)])));
    const earlier = layers.slice(0, k).flat();
    for (const u of layers[k]) {
      const n = Math.floor(rng() * (extra + 1));
      for (let r = 0; r < n; r++) {
        const have = new Set([...prereqs.get(u)].flatMap(p => [p, ...anc.get(p)]));
        const options = earlier.filter(x => !have.has(x));
        if (!options.length) break;
        link(pick(options), u);
      }
      // A later pick can imply an earlier one; drop those. The link from the layer
      // before is never dropped: nothing at or before its layer descends from it.
      const mine = prereqs.get(u);
      for (const p of [...mine]) if ([...mine].some(q => q !== p && anc.get(q).has(p))) mine.delete(p);
    }
  }

  let links = 0;
  const add = (from, to) => {
    const a = portFor(doc, from, 'output');
    const b = portFor(doc, to, 'input');
    if (Object.values(doc.edges).some(e => e.from === a && e.to === b && e.kind === 'req')) return;
    addEdge(doc, a, b);
    links++;
  };
  for (const u of layers[0]) add(meta.input, u);
  for (const u of order) for (const p of prereqs.get(u)) add(p, u);
  for (const u of layers[L - 1]) add(u, meta.output);
  for (const u of units) if (u.kind === 'task') u.combine = 'and';
  return { layers: L, links };
}
