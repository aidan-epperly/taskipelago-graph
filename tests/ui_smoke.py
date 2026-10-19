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

    # Sequence builder.
    page.click('.node.task >> text=Take out trash')
    page.click('#inspector >> text=Make a sequence')
    page.fill('#seq-n', '3')
    page.click('#modal footer >> text=Create')
    one = page.evaluate("Object.values(window.__app.doc.nodes).filter(n => /^Take out trash/.test(n.name || '')).map(n => [n.name, n.count, n.sequential])")
    check(one == [['Take out trash', 3, True]], f'sequence builder makes one sequential node by default {one}')
    page.click('#inspector >> text=Make a sequence')
    page.click('#seq-mode >> text=Separate nodes')
    page.click('#modal footer >> text=Create')
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
    page.keyboard.press('Escape')
    page.keyboard.press('Control+z')

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
