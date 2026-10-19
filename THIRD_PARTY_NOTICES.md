# Third-party notices

Taskipelago Graph bundles the following software. Each license's full text is in `licenses/`
and is also shown in the app under Help → Licenses.

| Component | Where | License | Full text |
|---|---|---|---|
| [Lucide](https://lucide.dev) icons, lucide-static 0.460.0 | `js/icons.js` | ISC, © Lucide Contributors | `licenses/lucide-LICENSE.txt` |
| [Feather](https://feathericons.com) icons, through Lucide (15 icons, listed in the license file) | `js/icons.js` | MIT, © 2013-present Cole Bemis | `licenses/feather-LICENSE.txt` |
| [Taskipelago](https://github.com/barretg/Taskipelago) generator modules and test YAMLs | `vendor/taskipelago/`, `tests/corpus/` | 0BSD-style, © 2026 Barret Glass | `licenses/taskipelago-LICENSE.txt` |
| [js-yaml](https://github.com/nodeca/js-yaml) 4.1.0 | `vendor/taskipelago/vendor/js-yaml.min.js` | MIT, © 2011-2015 Vitaly Puzrin | `licenses/js-yaml-LICENSE.txt` |

Changes to bundled files: the icon SVG markup has its whitespace collapsed, and two raw
control characters in `js-yaml.min.js` string literals are written as `\x07` and `\x1b`
escapes (same behavior). See `vendor/taskipelago/SOURCE.txt` for the Taskipelago commit.
