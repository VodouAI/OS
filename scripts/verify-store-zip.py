"""Verify the EXTRACTED store zip — what Chrome actually receives, not the source dir."""
import json, pathlib, re, subprocess, sys, os

os.chdir(sys.argv[1])
ok, fail = [], []
def chk(cond, msg):
    (ok if cond else fail).append(msg)

m = json.load(open('manifest.json'))
chk(m['manifest_version'] == 3, 'manifest_version 3')
chk(len(m['description']) <= 132, f"description {len(m['description'])}/132 chars")
chk('default_popup' not in m.get('action', {}), 'no default_popup (toolbar icon opens the panel)')
chk(bool(m.get('side_panel', {}).get('default_path')), 'side_panel declared')
chk('<all_urls>' not in json.dumps(m), 'no <all_urls>')
chk(m.get('minimum_chrome_version') == '116', f"minimum_chrome_version {m.get('minimum_chrome_version')} (sidePanel needs 116)")

refs = set()
for cs in m.get('content_scripts', []):
    refs.update(cs.get('js', []))
refs.add(m['background']['service_worker'])
refs.add(m['side_panel']['default_path'])
refs.update(m.get('icons', {}).values())
refs.update(m.get('action', {}).get('default_icon', {}).values())
missing = [r for r in refs if not pathlib.Path(r).exists()]
chk(not missing, f"all {len(refs)} manifest-referenced files present" + (f" MISSING={missing}" if missing else ''))

js_files = sorted(pathlib.Path('.').glob('*.js'))
src = ''.join(f.read_text() for f in js_files)
# Most permissions expose a `chrome.<name>` namespace, so absence from the source
# really does mean unused. IMPLICIT permissions do not have one — they grant a
# capability with no API of their own — so the namespace grep reports a false
# failure on a permission that is used on every invocation.
#
# `activeTab` is the case that exposed this (v0.5.97.73, 2026-08-12): there is no
# `chrome.activeTab`. Chrome grants host access to the CURRENT tab when the user
# performs a gesture, and the code then calls `chrome.scripting.executeScript`.
# Verifying it by the namespace can only ever fail; verifying it by its real
# shape — a gesture entry point AND an executeScript — is both correct and
# STRICTER, because it asserts the gesture gate that makes the permission
# legitimate rather than merely that a string appears somewhere.
IMPLICIT = {
    'activeTab': (
        lambda s: 'chrome.scripting.executeScript' in s
        and ('chrome.contextMenus.onClicked' in s or 'chrome.commands.onCommand' in s),
        'no gesture-gated executeScript (contextMenus.onClicked / commands.onCommand)',
    ),
}
unused = []
for p in m['permissions']:
    if p in IMPLICIT:
        predicate, why = IMPLICIT[p]
        if not predicate(src):
            unused.append(f'{p} — {why}')
    elif f'chrome.{p}' not in src:
        unused.append(p)
chk(not unused, f"all {len(m['permissions'])} declared permissions used" + (f" UNUSED={unused}" if unused else ''))

for pat, label in [
    (r'\bnew Function\b', 'no new Function'),
    (r'\brunUserScript\b', 'no runUserScript'),
    (r'__vodouNetCapParsers', 'no page-visible parser globals'),
    (r'vodouInPagePicker', 'no retired in-page picker flag'),
    (r'extension/vodou-bridge', 'no path to an off-store build'),
    (r'\bsideload\b', 'no "sideload" wording in shipped code'),
]:
    chk(not re.search(pat, src), label)

# the store build must never write an outgoing request body
chk(not re.search(r'init\.body\s*=(?!=)|args\[1\]\.body\s*=(?!=)|\.body\s*=(?!=)\s*JSON', src), 'no writes to outgoing request bodies (reads are fine)')

for junk in ['README.md', '.DS_Store', 'test', 'store-assets', 'build-icons.mjs', 'popup.html', 'popup.js']:
    chk(not pathlib.Path(junk).exists(), f'no {junk}')
chk(pathlib.Path('LICENSE').exists() and pathlib.Path('NOTICE').exists(), 'LICENSE + NOTICE present')

for f in js_files:
    r = subprocess.run(['node', '--check', str(f)], capture_output=True)
    chk(r.returncode == 0, f'{f.name} parses')

print(f'\nPASS ({len(ok)})')
for o in ok:
    print('  ✓', o)
if fail:
    print(f'\nFAIL ({len(fail)})')
    for x in fail:
        print('  ✗', x)
sys.exit(1 if fail else 0)
