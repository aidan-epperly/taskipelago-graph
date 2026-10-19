"""Browser test runner (needs `pip install playwright` and an installed Chrome or Edge).

    python tests/run_tests.py            # corpus round trip + UI smoke test
"""
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = 8799


def launch(p):
    for channel in ('chrome', 'msedge', None):
        try:
            return p.chromium.launch(channel=channel) if channel else p.chromium.launch()
        except Exception:
            continue
    raise SystemExit('No Chromium-based browser found.')


def roundtrip(page):
    files = sorted(f.name for f in (ROOT / 'tests' / 'corpus').glob('*.yaml'))
    page.goto(f'http://127.0.0.1:{PORT}/tests/roundtrip.html?files={",".join(files)}')
    page.wait_for_function('window.__results', timeout=60000)
    results = page.evaluate('window.__results')
    if isinstance(results, dict):
        print(results['error'])
        return False
    ok = True
    for r in results:
        if 'skip' in r:
            print(f"SKIP {r['file']}: {r['skip']}")
        elif 'fail' in r:
            ok = False
            print(f"FAIL {r['file']}: {r['fail']}")
        elif r['diffs']:
            ok = False
            print(f"DIFF {r['file']}:")
            for d in r['diffs'][:12]:
                print('   ', d)
        else:
            print(f"ok   {r['file']}: {r['tasks']} tasks -> {r['nodes']} nodes, {r['edges']} edges"
                  f"{', %d import notes' % r['importWarnings'] if r['importWarnings'] else ''}")
    return ok


def unit(page):
    page.goto(f'http://127.0.0.1:{PORT}/tests/unit.html')
    page.wait_for_function('window.__results', timeout=60000)
    results = page.evaluate('window.__results')
    if isinstance(results, dict):
        print(results['error'])
        return False
    for r in results:
        print(('ok   ' if r['ok'] else 'FAIL ') + r['name'])
        if not r['ok']:
            print('     ' + r['detail'])
    return all(r['ok'] for r in results)


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    server = subprocess.Popen([sys.executable, str(ROOT / 'serve.py'), str(PORT), '--no-browser'])
    time.sleep(0.8)
    try:
        with sync_playwright() as p:
            browser = launch(p)
            page = browser.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            ok = unit(page)
            ok = roundtrip(page) and ok
            if 'roundtrip' not in sys.argv:
                from ui_smoke import smoke
                ok = smoke(browser, f'http://127.0.0.1:{PORT}/') and ok
            if errors:
                print('Page errors:', *errors, sep='\n  ')
                ok = False
            browser.close()
    finally:
        server.terminate()
    print('PASS' if ok else 'FAILED')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).parent))
    main()
