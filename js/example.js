// A small chores slot that shows each kind of node and link.

import { addEdge, emptyDoc, goalNode, groupInto, makeNode } from './graph.js';
import { layoutLevel } from './layout.js';

export function exampleDoc() {
  const doc = emptyDoc();
  doc.settings.playerName = 'Chores';
  const add = (kind, data) => { const n = makeNode(kind, 0, 0, data); doc.nodes[n.id] = n; return n; };
  const link = (a, b, cond) => addEdge(doc, a.id, b.id, 'req', cond);

  const kitchen = add('region', { name: 'Kitchen', color: '#e0955c' });
  const laundry = add('region', { name: 'Laundry', color: '#5c8de0' });
  const outdoors = add('region', { name: 'Outdoors', color: '#5ce09a' });
  const keys = add('group', { name: 'Keys', color: '#c05ce0' });

  const coffee = add('item', { name: 'Coffee break', type: 'useful' });
  const star = add('item', { name: 'Gold star', consumable: true, count: 4 });
  const key = add('item', { name: 'Garage key', group: keys.id, count: 2 });
  const movie = add('item', { name: 'Movie night', type: 'useful' });
  add('item', { name: 'Extra chore', type: 'trap' });

  const dishes = add('task', { name: 'Wash dishes', region: kitchen.id, desc: 'Including the pans' });
  const counters = add('task', { name: 'Wipe counters', region: kitchen.id });
  const trash = add('task', { name: 'Take out trash', region: kitchen.id });
  const fridge = add('task', { name: 'Clean the fridge', region: kitchen.id });
  link(dishes, counters);
  link(counters, fridge);
  addEdge(doc, star.id, fridge.id, 'cost', { amount: 2 });

  const load = add('task', { name: 'Laundry load', region: laundry.id, count: 3, sequential: true, desc: 'Wash, dry, put away' });
  const fold = add('task', { name: 'Fold clothes', region: laundry.id });
  link(load, fold);

  link(kitchen, outdoors, { mode: 'pct', n: 50 });
  const plants = add('task', { name: 'Water the plants', region: outdoors.id });
  const mow = add('task', { name: 'Mow the lawn', region: outdoors.id });
  const garage = add('task', { name: 'Clean the garage', region: outdoors.id });
  link(keys, mow, { mode: 'count', n: 1 });
  link(laundry, mow, { mode: 'count', n: 2 });
  link(keys, garage, { mode: 'count', n: 2 });
  link(coffee, plants, { copies: 1 });

  const either = add('gate', { op: 'or' });
  link(movie, either, { copies: 1 });
  link(laundry, either, { mode: 'default' });
  const read = add('task', { name: 'Read a chapter', desc: 'After a movie night, or once laundry is done' });
  link(either, read);

  const goal = goalNode(doc);
  link(garage, goal);
  link(fold, goal);
  link(kitchen, goal, { mode: 'default' });

  doc.nodes[add('note', { text: 'Select a link to change what it needs:\na share of a region, copies of an item,\nor spending currency.' }).id].y = 0;

  const day = groupInto(doc, [load, fold].map(n => n.id), 'Laundry day');
  layoutLevel(doc, day.id);
  layoutLevel(doc, null);
  return doc;
}
