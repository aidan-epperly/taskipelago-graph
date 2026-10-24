"""UI smoke test: drives the editor with clicks and keys only (no dragging)."""
from pathlib import Path

SHOTS = Path(__file__).resolve().parent / 'screenshots'


def smoke(browser, url):
    SHOTS.mkdir(exist_ok=True)
    ok = True
    errors = []
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))

    def check(cond, what):
        nonlocal ok
        print(('ok   ' if cond else 'FAIL ') + what)
        ok = ok and cond

    page.goto(url)
    page.wait_for_selector('#es-example')
    page.click('#es-example')
    page.wait_for_function("document.querySelector('#status-pill').textContent.includes('Ready')", timeout=5000)
    check(True, 'example loads and validates: ' + page.inner_text('#status-pill'))
    page.screenshot(path=str(SHOTS / '01-example.png'))

    # Select a task, add the next task with N, name it.
    page.click('.node.task >> text=Wipe counters')
    check(page.locator('#inspector h3').inner_text().startswith('Wipe counters'), 'inspector shows the selected task')
    page.keyboard.press('n')
    page.keyboard.type('Mop the floor')
    page.keyboard.press('Escape')  # blur the name field
    page.wait_for_timeout(100)
    check(page.locator('.node.task >> text=Mop the floor').count() == 1, 'N adds a linked task')
    n_edges = page.evaluate("Object.values(window.__app.doc.edges).filter(e => window.__app.doc.nodes[e.to].name === 'Mop the floor').length")
    check(n_edges == 1, 'new task is linked from the selected one')

    # Link mode: Mop the floor unlocks Read a chapter.
    page.keyboard.press('l')
    check(page.is_visible('#modebar'), 'link mode bar shows')
    page.click('.node.task >> text=Read a chapter')
    page.keyboard.press('Escape')
    linked = page.evaluate("""(() => { const d = window.__app.doc; return Object.values(d.edges).some(e =>
        d.nodes[e.from].name === 'Mop the floor' && d.nodes[e.to].name === 'Read a chapter'); })()""")
    check(linked, 'link mode creates the edge')
    page.click('.node.task >> text=Mop the floor')
    page.keyboard.press('l')
    page.mouse.click(700, 120, button='right')
    check(page.evaluate("window.__app.mode.type") == 'idle' and not page.is_visible('#modebar'), 'right-click ends link mode')

    # Region edge condition: select the Kitchen -> fridge link label and set 75%.
    page.keyboard.press('Escape'); page.click('.elabel >> text=50% >> nth=0', timeout=3000)
    check('link' in page.inner_text('#inspector .kind').lower(), 'clicking a link label selects the link')
    check(page.evaluate("document.activeElement.classList.contains('elabel-edit')"), 'clicking a label opens its number for editing')
    page.keyboard.type('75')
    page.keyboard.press('Enter')
    check(page.locator('.elabel >> text=75%').count() >= 1, 'typing a number and Enter updates the link')
    page.click('.elabel >> text=75% >> nth=0')
    page.screenshot(path=str(SHOTS / '02-link.png'))

    # Open the meta-node and come back.
    page.keyboard.press('Escape')
    page.dblclick('.node.meta')
    page.wait_for_timeout(150)
    check('Laundry day' in page.inner_text('#crumbs'), 'double-click opens the meta-node')
    check(page.locator('.node.ghost').count() >= 1, 'ghost nodes show outside links')
    page.screenshot(path=str(SHOTS / '03-inside-meta.png'))
    page.keyboard.press('Escape')
    page.keyboard.press('Escape')
    page.wait_for_timeout(100)
    check('Laundry day' not in page.inner_text('#crumbs'), 'Esc goes back up')

    # Place mode via palette.
    page.click('[data-place="region"]')
    page.mouse.click(700, 760)
    page.keyboard.type('Bathroom')
    page.keyboard.press('Escape')
    check(page.locator('.node.region >> text=Bathroom').count() == 1, 'palette + click places a region')

    # Assign a task to the region by clicking it.
    page.click('#inspector >> text=+ Add tasks')
    page.click('.node.task >> text=Take out trash')
    page.keyboard.press('Escape')
    region_of = page.evaluate("""(() => { const d = window.__app.doc; const t = Object.values(d.nodes).find(n => n.name === 'Take out trash');
        return d.nodes[t.region]?.name; })()""")
    check(region_of == 'Bathroom', 'assign mode moves a task into the region')

    # Explode a task with copies into a chain of steps.
    page.click('.node.task >> text=Take out trash')
    page.fill('#inspector label.field:has-text("Copies") input', '3')
    page.click('#inspector >> text=Copies in order')
    one = page.evaluate("Object.values(window.__app.doc.nodes).filter(n => /^Take out trash/.test(n.name || '')).map(n => [n.name, n.count, n.sequential])")
    check(one == [['Take out trash', 3, True]], f'copies in order make one sequential node {one}')
    page.click('#inspector >> text=Explode as sequence')
    names = page.evaluate("Object.values(window.__app.doc.nodes).filter(n => /^Take out trash/.test(n.name || '')).map(n => n.name).sort()")
    check(names == ['Take out trash (1/3)', 'Take out trash (2/3)', 'Take out trash (3/3)'], f'separate mode makes chained steps {names}')
    chain = page.evaluate("""(() => { const d = window.__app.doc; const by = n => Object.values(d.nodes).find(x => x.name === n).id;
        return Object.values(d.edges).some(e => e.from === by('Take out trash (2/3)') && e.to === by('Take out trash (3/3)')); })()""")
    check(chain, 'sequence steps are linked')

    # Undo the sequence, then redo it.
    page.keyboard.press('Escape')
    page.keyboard.press('Control+z')
    n_undo = page.evaluate("Object.values(window.__app.doc.nodes).filter(n => /^Take out trash/.test(n.name || '')).length")
    page.keyboard.press('Control+Shift+z')
    n_redo = page.evaluate("Object.values(window.__app.doc.nodes).filter(n => /^Take out trash/.test(n.name || '')).length")
    check(n_undo == 1 and n_redo == 3, f'undo / redo ({n_undo}, {n_redo})')

    # Merge the separate steps back into one node.
    page.keyboard.press('Escape')
    page.click('.node.task >> text=Take out trash (1/3)')
    page.click('.node.task >> text=Take out trash (2/3)', modifiers=['Shift'])
    page.click('.node.task >> text=Take out trash (3/3)', modifiers=['Shift'])
    page.click('#inspector >> text=Merge into one sequential task')
    merged = page.evaluate("Object.values(window.__app.doc.nodes).filter(n => /^Take out trash/.test(n.name || '')).map(n => [n.name, n.count, n.sequential])")
    check(merged == [['Take out trash', 3, True]], f'merge turns a chain into one sequential node {merged}')
    page.keyboard.press('Control+z')

    # Shift-click two nodes and group them.
    page.keyboard.press('Escape')
    metas_before = page.locator('.node.meta').count()
    page.click('.node.item >> text=Coffee break')
    page.click('.node.task >> text=Water the plants', modifiers=['Shift'])
    page.keyboard.press('g')
    page.keyboard.type('Garden')
    page.keyboard.press('Escape')
    check(page.locator('.node.meta').count() == metas_before + 1, 'G groups the selection into a meta-node')

    # Search jumps into a meta-node.
    page.keyboard.press('Escape')
    page.keyboard.press('/')
    page.keyboard.type('Fold')
    page.keyboard.press('Enter')
    page.wait_for_timeout(100)
    check('Laundry day' in page.inner_text('#crumbs'), 'search navigates into the meta-node')
    page.click('#crumbs >> text=Top level')

    # Pan / zoom with wheel (two-finger scroll and pinch).
    before = page.evaluate("JSON.stringify(window.__app.views.root)")
    page.mouse.move(700, 400)
    page.mouse.wheel(120, 80)
    page.wait_for_timeout(50)
    after = page.evaluate("JSON.stringify(window.__app.views.root)")
    check(before != after, 'wheel pans')

    # Pinch zoom glides: one large wheel step changes the zoom by a bounded amount.
    k0 = page.evaluate("window.__app.views.root.k")
    page.keyboard.down('Control')
    page.mouse.wheel(0, 300)
    page.keyboard.up('Control')
    page.wait_for_timeout(600)
    k1 = page.evaluate("window.__app.views.root.k")
    check(0.7 < k1 / k0 < 0.99, f'ctrl+wheel zoom is gentle ({k0:.2f} -> {k1:.2f})')

    # Dragging is optional but works: drag a node to move it, drag empty canvas to pan.
    page.keyboard.press('Escape')
    page.keyboard.press('f')
    page.wait_for_timeout(100)
    box = page.locator('.node.goal').bounding_box()
    goal_x = "Object.values(window.__app.doc.nodes).find(n => n.kind === 'goal').x"
    before = page.evaluate(goal_x)
    page.mouse.move(box['x'] + 30, box['y'] + 10)
    page.mouse.down()
    held = page.evaluate("document.getElementById('actionbar').hidden")
    page.mouse.move(box['x'] + 130, box['y'] + 10, steps=8)
    dragging = page.evaluate("document.getElementById('actionbar').hidden")
    page.mouse.up()
    released = page.evaluate("document.getElementById('actionbar').hidden")
    check(held and dragging and not released, f'action bar waits for the release (held {held}, dragging {dragging}, released {released})')
    after = page.evaluate(goal_x)
    check(after > before + 40, f'dragging a node moves it ({before} -> {after})')
    page.keyboard.press('Control+z')
    back = page.evaluate(goal_x)
    check(back == before, 'undo reverts a drag')
    v0 = page.evaluate("window.__app.views.root.x")
    page.mouse.move(600, 820)
    page.mouse.down()
    page.mouse.move(80, 870, steps=6)
    page.mouse.move(700, 820, steps=6)
    page.mouse.up()
    v1 = page.evaluate("window.__app.views.root.x")
    sel = page.evaluate("getSelection().toString()")
    check(sel == '', f'dragging selects no text ({sel!r})')
    check(abs(v1 - v0 - 100) < 2, f'dragging empty canvas pans ({v0:.0f} -> {v1:.0f})')
    page.click('.node.goal')
    check(page.locator('#inspector h3').inner_text().startswith('Goal'), 'a click still selects after dragging')
    # A plain click on an unselected node: no bar while held, bar after release.
    page.keyboard.press('Escape')
    b2 = page.locator('.node.region >> text=Kitchen').bounding_box()
    page.mouse.move(b2['x'] + 20, b2['y'] + 10)
    page.mouse.down()
    held = page.evaluate("document.getElementById('actionbar').hidden")
    page.mouse.up()
    page.wait_for_timeout(50)
    released = page.evaluate("document.getElementById('actionbar').hidden")
    check(held and not released, f'clicking shows the action bar only on release (held {held}, released {released})')

    # Export.
    page.wait_for_timeout(400)
    page.click('#b-export')
    page.wait_for_selector('#modal pre', timeout=5000)
    yaml = page.inner_text('#modal pre')
    check('Mop the floor' in yaml and 'Taskipelago:' in yaml, 'export shows YAML with the new task')
    page.screenshot(path=str(SHOTS / '04-export.png'))
    page.keyboard.press('Escape')

    # Help -> Licenses shows every bundled license in full.
    page.click('#b-help')
    page.click('#modal footer >> text=Licenses')
    page.wait_for_selector('#modal pre')
    lic = page.inner_text('#modal .body')
    check('ISC License' in lic and 'Lucide Contributors' in lic and 'Barret Glass' in lic and 'Vitaly Puzrin' in lic and 'feathericons.com' in lic,
          'Licenses dialog shows the Lucide, Feather, Taskipelago and js-yaml licenses')
    page.keyboard.press('Escape')

    # Meta-node ports: a link into the card lands on Input, a link out of it starts at Output.
    # Earlier steps leave overlapping nodes behind, so start from a fresh example.
    page.keyboard.press('Escape')
    page.evaluate("""(async () => { const E = await import('./js/example.js'); const S = await import('./js/store.js');
      S.app.level = null; S.replaceDoc(E.exampleDoc()); })()""")
    page.wait_for_timeout(100)
    page.keyboard.press('f')
    page.wait_for_timeout(100)
    page.click('.node.region >> text=Kitchen')
    page.keyboard.press('l')
    page.click('.node.meta >> text=Laundry day')
    page.keyboard.press('Escape')
    page.click('.node.meta >> text=Laundry day')
    page.keyboard.press('l')
    page.click('.node.task >> text=Mow the lawn')
    page.keyboard.press('Escape')
    page.click('.node.meta >> text=Laundry day >> xpath=.. >> .open')
    page.wait_for_timeout(150)
    check('Laundry day' in page.inner_text('#crumbs'), 'clicking “Open ›” on a meta-node opens it')
    check(page.locator('.node.port').count() == 2, 'an opened meta-node shows its Input and Output')
    page.click('.node.port >> text=Input')
    page.keyboard.press('l')
    page.click('.node.task >> text=Laundry load')
    page.keyboard.press('Escape')
    rows = page.evaluate("""(async () => { const { compile } = await import('./js/compile.js');
      const m = compile(window.__app.doc).model; const t = n => m.tasks.find(x => x.name === n);
      return [t('Laundry load').prereq, t('Mow the lawn').prereq]; })()""")
    check('Kitchen' in rows[0], f'Input passes outside requirements to what it links ({rows[0]})')
    check('"Laundry load"' in rows[1] and '"Fold clothes"' in rows[1], f'an unwired Output means every task inside is done ({rows[1]})')
    page.click('#crumbs >> text=Top level')

    # Ladder from two selected tasks: step k of the second track needs step k of the first.
    page.keyboard.press('Escape')
    page.keyboard.press('f')
    page.wait_for_timeout(100)
    page.click('.node.task >> text=Wipe counters')
    page.click('.node.task >> text=Clean the fridge', modifiers=['Shift'])
    page.click('#inspector >> text=Make a ladder from these')
    page.fill('#lad-n', '3')
    page.click('#modal footer >> text=Create ladder')
    lad = page.evaluate("""(() => { const d = window.__app.doc; const id = n => Object.values(d.nodes).find(x => x.name === n)?.id;
      const has = (a, b) => Object.values(d.edges).some(e => e.from === id(a) && e.to === id(b));
      const names = Object.values(d.nodes).filter(n => /^(Wipe counters|Clean the fridge) \(/.test(n.name || '')).length;
      return { names, rung: has('Wipe counters (2/3)', 'Clean the fridge (2/3)'), chainA: has('Wipe counters (1/3)', 'Wipe counters (2/3)'),
        chainB: has('Clean the fridge (2/3)', 'Clean the fridge (3/3)'), direct: has('Wipe counters (3/3)', 'Clean the fridge (1/3)'),
        meta: Object.values(d.nodes).some(n => n.kind === 'meta' && n.name === 'Wipe counters / Clean the fridge') }; })()""")
    check(lad == {'names': 6, 'rung': True, 'chainA': True, 'chainB': True, 'direct': False, 'meta': True}, f'ladder builds both tracks and the rungs {lad}')
    page.wait_for_timeout(500)
    check('Ready' in page.inner_text('#status-pill'), 'the ladder validates: ' + page.inner_text('#status-pill'))
    # Reopening a saved ladder must not offer to merge its tracks (that would drop the rungs).
    page.wait_for_timeout(600)
    page.reload()
    page.wait_for_timeout(1500)
    toasts = page.evaluate("[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')")
    check('separate steps' not in toasts, f'a ladder is not offered as a sequence to merge ({toasts!r})')
    page.click('.node.meta >> text=Wipe counters / Clean the fridge', click_count=2)
    page.click('.node.task >> text=Wipe counters (1/3)')
    for t in ('Wipe counters (2/3)', 'Wipe counters (3/3)'):
        page.click(f'.node.task >> text={t}', modifiers=['Shift'])
    check('drops the rest' in page.inner_text('#inspector'), 'merging one ladder track warns that its rungs move')
    page.click('#crumbs >> text=Top level')
    page.keyboard.press('Escape')

    # Explode as copies: parallel tasks, each needed by what the original unlocked.
    page.evaluate("""(async () => {
      const G = await import('./js/graph.js'); const S = await import('./js/store.js');
      const doc = G.emptyDoc(); doc.settings.playerName = 'Tester';
      const add = (k, x, d, y = 0) => { const n = G.makeNode(k, x, y, d); doc.nodes[n.id] = n; return n; };
      const pre = add('task', 0, { name: 'Shop' }); const t = add('task', 300, { name: 'Cook', count: 3 });
      const all = add('task', 600, { name: 'Eat' }); const any = add('task', 600, { name: 'Nap', combine: 'or' }, 400);
      const other = add('task', 300, { name: 'Read' }, 600);
      G.addEdge(doc, pre.id, t.id); G.addEdge(doc, t.id, all.id); G.addEdge(doc, t.id, any.id); G.addEdge(doc, other.id, any.id);
      S.replaceDoc(doc);
    })()""")
    page.click('.node.task >> text=Cook')
    page.click('#inspector >> text=Explode as copies')
    ex = page.evaluate("""(async () => { const { compile } = await import('./js/compile.js');
      const m = compile(window.__app.doc).model; const t = n => m.tasks.find(x => x.name === n);
      return { names: m.tasks.map(x => x.name).filter(n => n.startsWith('Cook')).sort(), pre: t('Cook #2').prereq,
        eat: t('Eat').prereq, nap: t('Nap').prereq, counts: m.tasks.filter(x => x.name.startsWith('Cook')).map(x => x.count) }; })()""")
    check(ex['names'] == ['Cook #1', 'Cook #2', 'Cook #3'] and ex['counts'] == [1, 1, 1] and ex['pre'] == '"Shop"', f'explode as copies makes parallel copies {ex}')
    check(all(f'"Cook #{i}"' in ex['eat'] for i in (1, 2, 3)) and '||' not in ex['eat'], f'an all-of target needs every copy ({ex["eat"]})')
    check('"Read"' in ex['nap'] and all(f'"Cook #{i}"' in ex['nap'] for i in (1, 2, 3)) and '||' in ex['nap'], f'an any-one target gets an AND gate ({ex["nap"]})')
    # ...and merge them back: the AND gate folds away and the logic is unchanged.
    page.click('#inspector >> text=Merge into one task with copies')
    back = page.evaluate("""(async () => { const { compile } = await import('./js/compile.js'); const d = window.__app.doc;
      const m = compile(d).model; const t = n => m.tasks.find(x => x.name === n);
      return { cook: [t('Cook')?.count, t('Cook')?.prereq], eat: t('Eat').prereq, nap: t('Nap').prereq,
        gates: Object.values(d.nodes).filter(n => n.kind === 'gate' && !n.role).length, tasks: m.tasks.length }; })()""")
    check(back == {'cook': [3, '"Shop"'], 'eat': '"Cook"', 'nap': '"Cook" || "Read"', 'gates': 0, 'tasks': 5}, f'merging copies restores one task with copies {back}')
    page.keyboard.press('Control+z')
    page.keyboard.press('Escape')
    page.keyboard.press('Escape')

    # Cost from the side panel: a new currency gets amount x copies items.
    page.evaluate("""(async () => {
      const G = await import('./js/graph.js'); const S = await import('./js/store.js');
      const doc = G.emptyDoc();
      const t = G.makeNode('task', 300, 0, { name: 'Vacuum', count: 3, sequential: true });
      doc.nodes[t.id] = t; S.replaceDoc(doc);
    })()""")
    page.click('.node.task >> text=Vacuum')
    page.click('#inspector >> text=+ Cost')
    page.fill('#inspector .cost-form input[type=number]', '2')
    page.fill('#inspector .cost-form input[placeholder="e.g. Gold"]', 'Gold')
    check('6 copies' in page.inner_text('#inspector .cost-form'), 'the cost form says how many currency copies it makes')
    page.click('#inspector >> text=Add cost')
    cost = page.evaluate("""(async () => { const { compile } = await import('./js/compile.js');
      const d = window.__app.doc; const gold = Object.values(d.nodes).find(n => n.name === 'Gold');
      const m = compile(d).model;
      return { consumable: !!gold?.consumable, count: gold?.count, cost: m.tasks.find(x => x.name === 'Vacuum').cost }; })()""")
    check(cost == {'consumable': True, 'count': 6, 'cost': '"Gold"*2'}, f'adding a new currency cost from the panel {cost}')
    check('spend 2' in page.inner_text('#inspector'), 'the new cost is listed in the panel')
    page.keyboard.press('Escape')

    # Random meta-node from a selection of unrelated tasks.
    page.evaluate("""(async () => {
      const G = await import('./js/graph.js'); const S = await import('./js/store.js');
      const doc = G.emptyDoc(); doc.settings.playerName = 'Tester';
      for (let i = 0; i < 10; i++) { const t = G.makeNode('task', 0, i * 90, { name: `Chore ${i + 1}` }); doc.nodes[t.id] = t; }
      S.replaceDoc(doc);
    })()""")
    page.keyboard.press('Control+a')
    page.click('#inspector >> text=Random meta-node')
    page.fill('#rnd-depth', '4')
    page.click('#modal footer >> text=Randomize')
    page.wait_for_timeout(500)
    rnd = page.evaluate("""(() => { const d = window.__app.doc; const m = Object.values(d.nodes).find(n => n.kind === 'meta');
      const tasks = Object.values(d.nodes).filter(n => n.kind === 'task');
      return { inside: tasks.every(t => t.parent === m?.id), links: Object.keys(d.edges).length >= 10 }; })()""")
    check(rnd == {'inside': True, 'links': True}, f'Random meta-node groups and links the tasks {rnd}')
    probs = page.evaluate("""(async () => { const { exportYaml } = await import('./js/compile.js'); return (await exportYaml(window.__app.doc)).problems.filter(p => p.level === 'error').map(p => p.msg); })()""")
    check(not probs, f'the random meta-node exports cleanly {probs}')
    check('Reroll' in page.inner_text('#toast'), 'the result offers a reroll')
    page.click('#toast >> text=Reroll')
    page.wait_for_timeout(300)
    check(page.evaluate("Object.values(window.__app.doc.nodes).filter(n => n.kind === 'meta').length") == 1, 'reroll replaces the draw instead of adding a second meta-node')
    page.click('.node.meta >> text=Random tasks', click_count=2)
    page.wait_for_timeout(300)
    page.screenshot(path=str(SHOTS / '06-random-meta.png'))
    # Randomize again from inside, with nothing selected (opening a meta-node clears the selection).
    page.click('#inspector >> text=Randomize links')
    page.click('#modal footer >> text=Randomize')
    page.wait_for_timeout(300)
    inside = page.evaluate("[window.__app.level === Object.values(window.__app.doc.nodes).find(n => n.kind === 'meta').id, Object.values(window.__app.doc.nodes).filter(n => n.kind === 'meta').length]")
    check(inside == [True, 1], f'randomizing from inside a meta-node stays inside {inside}')
    page.click('#crumbs >> text=Top level')
    page.keyboard.press('Escape')

    # Two linked tasks almost touching get a short forward link, not the loop-around route.
    d = page.evaluate("""(async () => {
      const G = await import('./js/graph.js'); const S = await import('./js/store.js');
      const doc = G.emptyDoc();
      const a = G.makeNode('task', 0, 0, { name: 'Do' }); const b = G.makeNode('task', 220, 0, { name: 'Fold' });
      doc.nodes[a.id] = a; doc.nodes[b.id] = b; G.addEdge(doc, a.id, b.id);
      S.replaceDoc(doc);
      return document.querySelector('#edge-layer path.e').getAttribute('d');
    })()""")
    check(' S' not in d, f'adjacent nodes get a forward link ({d})')
    page.keyboard.press('Control+z')

    # Dark mode screenshot.
    page.click('#b-theme')
    page.wait_for_timeout(100)
    page.screenshot(path=str(SHOTS / '05-dark.png'))

    if errors:
        print('Console errors:', *errors, sep='\n  ')
        ok = False
    ctx.close()
    return ok
