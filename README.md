# Taskipelago Graph

A browser editor for [Taskipelago](https://github.com/barretg/Taskipelago) slots where
tasks, items, regions and item groups are nodes in a DAG and the links say what unlocks
what. It exports the same YAML the official generator makes, and opens existing YAMLs.

## Run it

Use it online at **https://aidan-epperly.github.io/taskipelago-graph/**, or run it locally:

```
python serve.py          # or double-click run.bat; python3 on Mac and Linux
```

This serves the folder on `http://127.0.0.1:8765/` and opens it. A server is needed
because browsers block ES-module imports from `file://` pages. Nothing is installed and
nothing leaves the machine. Work autosaves in the browser's local storage.

## How it works

| Node | Meaning |
|---|---|
| Task | One task row. *Copies* > 1 makes interchangeable copies. |
| Item | One item row: type, copies, currency (consumable), early, filler, item group. |
| Region | A region. Tasks join it through their *Region* field. |
| Item group | Progressive / random-choice / aesthetic group. Items join through *Item group*. |
| AND / OR gate | Nested rules such as (A and B) or C. |
| Goal | Its inputs become `goal_tasks`; with none, the goal is every task. |
| Meta-node | Container with an **Input** and an **Output** gate inside. A link into the card goes to its Input; a link out of it starts at its Output. |
| Note | Free text. Never exported. |

A link's meaning depends on its source; select it to change it. Clicking the number on a
link's label edits it in place (`Enter` saves, `Esc` cancels).

- **task**: done (all copies, if it has several)
- **item**: at least N copies received
- **region**: its default share, a percent of its tasks, or a number of its tasks
- **item group**: at least N items; for progressive groups also *next in order* or
  *position N*; for other groups a percent
- **currency → task**: required, or **spent** (a task cost). *+ Cost* in a task's panel
  can also create a new currency with enough copies for every copy of the task.

Each task, region and the goal can need **all** of their requirements or **any one**.

**Sequences** are one task node with several copies and *Copies in order* ticked (the
YAML's `sequential` keyword): each copy needs the one before, and what the task unlocks
waits for all of them. A YAML task using `sequential` opens as that one node. *Explode
as sequence* in a task's panel splits it into separate nodes, `X (1/n)` … `X (n/n)`, when
the steps need their own descriptions or links. *Explode as copies* splits a task's copies
into parallel nodes `X #1` … `X #n`, each with the original's requirements and costs; what
the task unlocked still needs all of them. Selecting the copies offers *Merge into one task
with copies*. Selecting such a chain
offers *Merge into one sequential task*, and opening a graph that has split chains
offers to merge them all.

**Ladders** are two tracks of *n* steps where step *k* of the second track needs step *k*
of the first (and the step before it on its own track). *Make a ladder…* in a task's panel
builds one from that task, and with two tasks selected *Make a ladder from these…* uses both.
The steps are separate nodes, since a single YAML row cannot tie copy *k* to copy *k*, and
the ladder is wrapped in a meta-node by default to keep the canvas tidy.

To add nodes to an existing **meta-node**, pick *+ Add nodes* in its panel and click them,
or use *Move into* in any node's panel (or a selection's). *Move into → Top level* moves
nodes back out. Links are kept.

**Random meta-nodes** make deep tasks with many prerequisites. Select some tasks and pick
*Random meta-node…*, or pick *Randomize links…* on a meta-node (or in the side panel while inside one). The tasks inside are shuffled
into layers. Each one needs a task from the layer before (the first layer hangs off Input),
leads into the next layer, and can get extra prerequisites from earlier layers. The last
layer feeds Output. *Reroll* draws again.

### Controls (trackpad first; dragging works but is never needed)

| | |
|---|---|
| Pan | two-finger scroll; arrow keys with nothing selected; or drag empty canvas |
| Zoom | pinch or Ctrl+scroll (eased); `+` `−`; `F` fit; `0` 100% |
| Add | palette on the left (`T` `I` `R` `P` `A` `O`), then click the canvas; or double-click empty canvas for a task |
| Next task | `N`: adds a task after the selected node, already linked |
| Link | `L`, then click each node the selection unlocks; `Shift+L` for what it requires; `Esc` or right-click ends |
| Move | `M`, glide, click to drop; or drag a node (drags the whole selection); arrow keys nudge (`Shift` for larger steps) |
| Select | click; `Shift`+click adds; `Ctrl+A` selects the level |
| Meta-nodes | `G` groups the selection; double-click or `Enter` opens; `Esc` or the breadcrumb goes up |
| Find | `/` searches every node, including inside meta-nodes |
| Undo | `Ctrl+Z`, redo `Ctrl+Shift+Z`; `Delete` removes the selection |

Inside a meta-node, links to and from the outside appear as dashed ghost nodes; click one
to jump to it. Each meta-node has an Input and an Output gate. Link Input to the nodes
inside that should wait for the meta-node's outside requirements, and link the nodes that
finish the group into Output; an Output with nothing linked into it means every task
inside is done. Click *Open ›* on a card (or double-click it) to go inside. The left toolbar can also tidy the current level and wrap each region's
tasks (and items that only feed it) into a meta-node.

### Checking and export

The status pill runs the export continuously. Export goes through Taskipelago's own
generator code (vendored in `vendor/taskipelago`), so it gets the same validation and
byte-for-byte output format as the official YAML generator. On top of that,
`js/checks.js` adds rules the apworld only enforces in Python at generation time: a task
requiring its own region, references to empty regions or groups, counts larger than a
region or group, a region requiring its own tasks or subregion, mixing count and ordering
references to one progressive group, and tasks that can never unlock (cycles).

Exported YAML ends with a comment holding the graph (compressed). Opening that file here
again restores the layout and meta-nodes, unless the YAML was edited elsewhere, in which
case the graph is rebuilt from the YAML. *Save graph* writes the same data as JSON.

Not covered: Taskipelabingo (bingo mode has no dependency graph) and the style colors
editor (style colors in an opened YAML are kept). A requirement on a filler item is
dropped on import, since filler gets a random name.

## Layout

```
index.html, css/app.css
js/graph.js       document model, meta-node tree, undo
js/compile.js     graph -> generator model -> YAML (via the vendored buildExport)
js/importer.js    YAML -> graph (via the vendored importDoc and parser)
js/checks.js      generation-time rules
js/layout.js      layered auto-layout
js/view.js        canvas rendering
js/inspector.js   side panel
js/app.js         input, modes, commands, files
vendor/taskipelago  generator modules from Taskipelago (see SOURCE.txt, LICENSE.txt)
```

## Credits

- Aidan Epperly <aidan.epperly@gmail.com>: design, direction and testing.

Taskipelago itself is by Barret Glass (https://github.com/barretg/Taskipelago); this editor
reuses its YAML generator code.

## AI acknowledgement

Taskipelago Graph was built with Claude, Anthropic's AI model, working in Claude Code.
Aidan Epperly set the goals and the design (trackpad-first controls, sequential and ladder
tasks, meta-nodes with inputs and outputs, editable link labels, and more), tried each
version and said what needed to change. Claude wrote the code, the tests and this
documentation in response, and checked the third-party licenses.

The bundled third-party code is not AI-written: Taskipelago's generator modules and sample
YAMLs, js-yaml, and the Lucide and Feather icons are the work of their authors (see
`THIRD_PARTY_NOTICES.md`) and are included unchanged apart from the small edits listed there.

The automated tests cover export validation, a YAML round trip over Taskipelago's sample
files and the main editor interactions. Like any software it can still have bugs, so check
an exported YAML in Archipelago before relying on it, and please report problems as issues.

## Licenses

Taskipelago Graph's own code is under the MIT license (`LICENSE`). The bundled
third-party files keep their own licenses:

Bundled third-party code (Lucide icons, some derived from Feather; Taskipelago's generator
modules; js-yaml) is listed in
`THIRD_PARTY_NOTICES.md`, with each full license text in `licenses/`. The app shows them
under Help → Licenses. Keep `licenses/` next to `index.html` when copying or publishing.

## Tests

```
pip install playwright        # uses the installed Chrome or Edge
python tests/run_tests.py
```

Runs unit checks, a round trip over Taskipelago's YAML corpus (every requirement must
survive YAML → graph → YAML), and a UI smoke test driven by clicks and keys only.
Screenshots land in `tests/screenshots/`.

To update the vendored generator, copy the same files from a newer Taskipelago checkout
(`web-client/js/shared`, the five `web-client/js/generator` files listed in `vendor/`,
and `vendor/js-yaml.min.js`) and rerun the tests.
