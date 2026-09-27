#!/usr/bin/env python3
"""Generate the two sideload bridge builds from the Store build.

    python3 scripts/build-sideload-bridge.py           # write both builds
    python3 scripts/build-sideload-bridge.py --check   # exit 1 if either is stale

WHY THIS EXISTS. extension/vodou-bridge/ and extension/sideload-only-vodou-bridge/
were hand-kept copies of the Store build. They drifted twice: 39 commits / eleven
days the first time (ported in fa15858, with Poe filing the user's prompt as the
assistant's in the meantime), and by 2026-09-23 they were missing eight whole
files, ~2,800 lines of background.js and ~1,200 of content.js, and
sideload-only's own parser suite was 30/35 red. The packer's drift check only
compared inject.js, so it reported "31 lines" while everything else rotted.

A copy that someone has to remember to update will not be updated. So the
sideload builds are now OUTPUT: the Store build, plus the short list of changes
below, each of which must match EXACTLY ONCE or the build fails — an anchor that
moved is a loud error, never a silently skipped patch.

What the full build adds, and nothing else:
  • manifest  — <all_urls> host access (replaces the 35 named hosts + the
                optional wildcard), and a version_name so chrome://extensions
                says which build is loaded
  • background — channel 'full'; no host allowlist on fetch / cookies_fetch /
                list_tabs; the gateway commands the Store build refuses or lacks
                (extract, act_in_tab, cache_get/set, open_url) and two more
                builtin extractors (sideload-overlay/background.full.js)
  • inject.js — the network body-rewrite block in place of the Store's
                maybeInjectArgs stub (sideload-overlay/inject.network-rewrite.js)
  • sites.js / content.js — ChatGPT's Ctrl+B uses that network path (invisible
                attach on send) instead of the composer

Owned by each sideload folder, never touched here: README.md and test/.
"""
import json
import pathlib
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXT = ROOT / 'extension'
STORE = EXT / 'Store-vodou-bridge'
OVERLAY = EXT / 'sideload-overlay'

TARGETS = {
    'vodou-bridge': 'dev · all_urls',
    'sideload-only-vodou-bridge': 'sideload · all_urls',
}
# Never generated: each sideload folder keeps its own.
OWNED = {'README.md', 'test'}
# Never copied from the Store build: dev/store-only artifacts.
SKIP = {'test', 'store-assets', 'README.md', '.DS_Store'}


class BuildError(Exception):
    pass


def replace_once(text, old, new, where):
    n = text.count(old)
    if n != 1:
        head = old.strip().splitlines()[0][:90]
        raise BuildError(f'{where}: anchor matched {n}x (need exactly 1): {head!r}\n'
                         f'  The Store build changed under this patch — update the anchor '
                         f'in scripts/build-sideload-bridge.py.')
    return text.replace(old, new)


# ── background.js ─────────────────────────────────────────────────────────────
def patch_background(src):
    w = 'background.js'
    src = replace_once(src, "const BRIDGE_CHANNEL = 'store';",
                       "const BRIDGE_CHANNEL = 'full';", w)
    src = replace_once(
        src,
        "  return STORE_HOST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));",
        "  // Full build: <all_urls> — every host is in reach, so none is filtered.\n"
        "  return !!h;", w)
    src = replace_once(
        src,
        "      case 'extract':\n"
        "        return replyError('UNSUPPORTED', STORE_UNSUPPORTED_MSG, { cmd: 'extract', channel: BRIDGE_CHANNEL });\n"
        "      case 'act_in_tab':\n"
        "        return replyError('UNSUPPORTED', STORE_UNSUPPORTED_MSG, { cmd: 'act_in_tab', channel: BRIDGE_CHANNEL });\n",
        "      case 'extract': return await cmdExtract(msg, reply, replyError);\n"
        "      case 'act_in_tab': return await cmdActInTab(msg, reply, replyError);\n"
        "      case 'cache_get': return await cmdCacheGet(msg, reply, replyError);\n"
        "      case 'cache_set': return await cmdCacheSet(msg, reply, replyError);\n"
        "      case 'open_url': return await cmdOpenUrl(msg, reply, replyError);\n", w)
    overlay = (OVERLAY / 'background.full.js').read_text()
    return src.rstrip('\n') + '\n\n' + overlay


# ── inject.js ─────────────────────────────────────────────────────────────────
INJECT_STUB = '  async function maybeInjectArgs(args) { return args; }'


def patch_inject(src):
    block = (OVERLAY / 'inject.network-rewrite.js').read_text().rstrip('\n')
    return replace_once(src, INJECT_STUB, block, 'inject.js')


# ── sites.js ──────────────────────────────────────────────────────────────────
def patch_sites(src):
    w = 'sites.js'
    src = replace_once(
        src,
        "// `mechanism` is how injected context reaches the model. Every entry below is\n"
        "// `composer`: typed into the page's own composer, visible, and editable before\n"
        "// send. This build has no other path — outgoing requests are never modified.\n",
        "// `mechanism` is how injected context reaches the model:\n"
        "//   composer — typed into the page's composer, visible, editable before send\n"
        "//   network  — spliced into the outgoing request body, invisible (full build only)\n", w)
    src = replace_once(
        src,
        "mechanism: 'composer', capture: 'chatgpt' },",
        "mechanism: 'network', capture: 'chatgpt' },", w)
    return src


# ── content.js ────────────────────────────────────────────────────────────────
FENCED_BLOCK = """\
    let lastArmed = { facts: 0, profileLines: 0 };
    function fencedBlock(resp) {
      const facts = (Array.isArray(resp.selected) && resp.selected.length)
        ? resp.selected.map((t) => String(t || '').replace(/^[-•]\\s*/, '').trim()).filter(Boolean)
        : relevantItems(resp.items, 6);
      const prof = String(resp.profile || '').trim();
      const empty = { text: '', facts: 0, profileLines: 0 };
      if (!prof && !facts.length) return empty;
      const lines = [];
      if (resp.open) lines.push(resp.open);
      if (resp.header) lines.push(resp.header);
      if (prof) lines.push(prof);
      for (const t of facts) lines.push('- ' + t);
      if (resp.close) lines.push(resp.close);
      if (lines.length <= 2) return empty;
      const profileLines = prof ? prof.split('\\n').filter((l) => l.trim()).length : 0;
      return { text: lines.join('\\n'), facts: facts.length, profileLines };
    }
"""

NETWORK_BRANCH = """\
        // Full build: a `network` site (ChatGPT) ARMS the fenced block and
        // inject.js splices it into the next send, invisibly. Ctrl+Shift+B, and
        // every other site, inserts visibly into the composer below.
        const mech = forceComposer ? 'composer' : INJECT_SITES[site].mechanism;
        if (mech === 'network') {
          const built = fencedBlock(resp);
          const block = built.text;
          if (!block) { toast('nothing suitable to inject', false); done(); return; }
          window.postMessage({ source: 'vodou-inject', op: 'arm', block }, '*');
          lastArmed = { facts: built.facts, profileLines: built.profileLines };
          done();
          logInjection({
            kind: 'inject', site, mechanism: 'network', status: 'armed', chars: block.length,
            facts: built.facts, profileLines: built.profileLines,
            prefetched: !!prefetched, convId: convRef().convId, at: Date.now(),
          });
        } else {
"""

STATUS_LISTENER = """\
    // Status back-channel from inject.js (network mechanism): disclosure toasts.
    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.source !== 'vodou-inject-status') return;
      if (d.op === 'armed') {
        toast('🧠 context armed — attaches invisibly to your next send', true);
      } else if (d.op === 'injected') {
        toast('🧠 context attached to your message (invisible)', true);
        // One log line per injection that advances armed → sent.
        logInjection({
          kind: 'inject', site: injectSiteKey(), mechanism: 'network', status: 'injected',
          facts: lastArmed.facts, profileLines: lastArmed.profileLines,
          supersedes: 'armed', how: d.how || '', convId: convRef().convId, at: Date.now(),
        });
      }
    });
"""


def patch_content(src):
    w = 'content.js'
    src = replace_once(
        src,
        "    // fencedBlock() removed with the network mechanism — the composer path\n"
        "    // uses composerFraming() (plain prose, no machine fence).\n",
        FENCED_BLOCK, w)
    src = replace_once(
        src,
        "        // Composer insertion is the only mechanism in this build: the text is\n"
        "        // placed in the visible draft for the user to review, edit or delete.\n"
        "        {\n",
        NETWORK_BRANCH, w)
    src = replace_once(
        src,
        "    // (The 'vodou-inject-status' back-channel belonged to the network mechanism\n"
        "    // and is gone with it — composer insertion reports its own result inline.)\n",
        STATUS_LISTENER, w)
    return src


# ── manifest.json ─────────────────────────────────────────────────────────────
def patch_manifest(src, label):
    m = json.loads(src)
    if 'host_permissions' not in m:
        raise BuildError('manifest.json: no host_permissions to widen')
    # Keep the Store's infrastructure hosts (policy server, localhost) named next
    # to <all_urls>: the wildcard covers them, but a named entry is what the
    # policy-host test and a reader both look for. The chat hosts go — they are
    # exactly what <all_urls> replaces.
    chat = {x for cs in m.get('content_scripts', []) for x in cs.get('matches', [])}
    infra = [h for h in m['host_permissions'] if h not in chat]
    out = {}
    for k, v in m.items():
        if k == 'optional_host_permissions':
            continue  # subsumed by <all_urls>
        out[k] = ['<all_urls>'] + infra if k == 'host_permissions' else v
        if k == 'version':
            out['version_name'] = f"{v} ({label})"
    return json.dumps(out, indent=2, ensure_ascii=False) + '\n'


PATCHES = {
    'background.js': patch_background,
    'inject.js': patch_inject,
    'sites.js': patch_sites,
    'content.js': patch_content,
}


def render(dest, label):
    """Write the generated build (everything but OWNED) into `dest`."""
    for p in sorted(STORE.rglob('*')):
        rel = p.relative_to(STORE)
        if rel.parts[0] in SKIP or p.name == '.DS_Store' or p.is_dir():
            continue
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        name = rel.as_posix()
        if name == 'manifest.json':
            out.write_text(patch_manifest(p.read_text(), label))
        elif name in PATCHES:
            out.write_text(PATCHES[name](p.read_text()))
        else:
            shutil.copy2(p, out)


def generated_files(d):
    return {p.relative_to(d).as_posix() for p in d.rglob('*')
            if p.is_file() and p.relative_to(d).parts[0] not in OWNED and p.name != '.DS_Store'}


def main():
    check = '--check' in sys.argv[1:]
    stale = []
    for name, label in TARGETS.items():
        target = EXT / name
        with tempfile.TemporaryDirectory() as tmp:
            fresh = pathlib.Path(tmp)
            try:
                render(fresh, label)
            except BuildError as e:
                print(f'ERROR ({name}): {e}', file=sys.stderr)
                return 2
            want = generated_files(fresh)
            have = generated_files(target) if target.exists() else set()
            diff = sorted(f for f in want | have
                          if f not in want or f not in have
                          or (fresh / f).read_bytes() != (target / f).read_bytes())
            if not diff:
                print(f'✓ extension/{name}/ matches the Store build + overlay')
                continue
            if check:
                stale.append((name, diff))
                continue
            for f in have - want:
                (target / f).unlink()
            for f in want:
                (target / f).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(fresh / f, target / f)
            print(f'wrote extension/{name}/ ({len(diff)} file(s) changed)')
    if stale:
        for name, diff in stale:
            print(f'✗ extension/{name}/ is stale: {", ".join(diff[:8])}'
                  + (f' … +{len(diff) - 8}' if len(diff) > 8 else ''), file=sys.stderr)
        print('  Regenerate: python3 scripts/build-sideload-bridge.py', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
