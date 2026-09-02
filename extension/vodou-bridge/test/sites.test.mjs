// sites.js audit — the shared site registry vs the manifest, the capture
// adapters and the panel, for EVERY build.
//
// Why this file exists. A host migration has to be applied in three separate
// places: the manifest's content_script matches, the capture adapter's `match`,
// and sites.js (the shared registry behind Ctrl+B and per-site capture). Nothing
// cross-checked the third one, and it has silently broken three times:
//
//   • NotebookLM moved to notebook.google.com — manifest and adapter fixed,
//     the registry missed. Ctrl+B did nothing there. (0f97fe37, 2026-07-27)
//   • Qwen moved off the chat. subdomain — same shape, same commit.
//   • The sideload manifest never got either fix, so on bare qwen.ai the
//     content script did not even load: capture AND inject dead. (2026-07-29)
//
// The failure is invisible by design: injectSiteKey() returns null on an
// unsupported host and the keydown handler deliberately leaves the hotkey to
// the page — no toast, no console line, no error. Only capture is exercised by
// the canary runs, so as 0f97fe37 put it, "an inject gap can sit unnoticed
// indefinitely." This is that check, automated, in both directions.
//
// Deliberately audits all three builds from one file: the builds' registries
// are separate lineages (the store build strips outgoing-request rewriting, so
// its chatgpt entry is 'composer' where sideload keeps 'network'), and a guard
// living inside one build cannot see the others drift.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const BUILDS = [
  { dir: 'vodou-bridge', chatgpt: 'network' },
  { dir: 'sideload-only-vodou-bridge', chatgpt: 'network' },
  // Store build removed outgoing-request rewriting wholesale (9bdbbc8) — it
  // reads only, so ChatGPT has to go through the composer like everything else.
  { dir: 'Store-vodou-bridge', chatgpt: 'composer' },
];

// "https://*.manus.im/*" → "x.manus.im"; "https://huggingface.co/chat*" →
// "huggingface.co". A concrete hostname is what INJECT_SITES regexes test
// against at runtime (location.hostname), so the audit must compare like for
// like rather than pattern-to-pattern.
function hostOf(match) {
  const m = /^https?:\/\/([^/]+)/.exec(match);
  if (!m) return null;
  return m[1].replace(/^\*\./, 'x.');
}

function manifestHosts(dir) {
  const mf = JSON.parse(readFileSync(join(EXT, dir, 'manifest.json'), 'utf8'));
  const hosts = new Set();
  for (const cs of mf.content_scripts || []) {
    for (const match of cs.matches || []) {
      const h = hostOf(match);
      if (h) hosts.add(h);
    }
  }
  return [...hosts];
}

// Parse sites.js — the single list, loaded both as the first content
// script and by sidepanel.html. Reading the source beats importing it: the file
// assigns to globalThis and its siblings expect a browser, so it is not an
// ES module.
// The settings surface is the PANEL (the popup retired 2026-07-30), and its
// behaviour lives in TWO files: sidepanel.js and controls.js (the shared
// renderers). Assertions about "the settings surface" must read both, or they
// pass vacuously the moment code moves.
function settingsSource(dir) {
  let out = readFileSync(join(EXT, dir, 'sidepanel.js'), 'utf8');
  const shared = join(EXT, dir, 'controls.js');
  if (existsSync(shared)) out += '\n' + readFileSync(shared, 'utf8');
  return out;
}

function siteRegistry(dir) {
  const src = readFileSync(join(EXT, dir, 'sites.js'), 'utf8');
  const entries = [];
  // Trailing fields are TOLERATED on purpose. The first version required the entry to
  // end at `capture: '…' }`, so adding `fullImport` to two sites made them invisible to
  // every assertion below — the audit went quiet exactly when the registry grew. Parse
  // the fields we need and ignore the rest.
  const re = /\{\s*key:\s*'(\w+)',\s*label:\s*'([^']+)',\s*host:\s*\/(.+?)\/\s*,\s*mechanism:\s*'(\w+)',\s*capture:\s*'(\w+)'([^}]*)\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    entries.push({
      key: m[1], label: m[2], host: new RegExp(m[3]), mechanism: m[4], capture: m[5],
      fullImport: /fullImport:\s*true/.test(m[6] || ''),
    });
  }
  assert.ok(entries.length > 0, `${dir}: sites.js parsed to zero entries`);
  return entries;
}

for (const build of BUILDS) {
  if (!existsSync(join(EXT, build.dir, 'manifest.json'))) continue;

  test(`${build.dir}: every manifest host has a sites.js entry`, () => {
    const sites = siteRegistry(build.dir);
    const orphans = manifestHosts(build.dir).filter((h) => !sites.some((s) => s.host.test(h)));
    assert.deepStrictEqual(
      orphans, [],
      `Ctrl+B is silently dead on these hosts — the content script loads, but ` +
      `injectSiteKey() returns null and the hotkey falls through to the page ` +
      `with no toast and no log. Add them to ` +
      `${build.dir}/sites.js:\n  ${orphans.join('\n  ')}`,
    );
  });

  test(`${build.dir}: every sites.js entry has a manifest host`, () => {
    const hosts = manifestHosts(build.dir);
    const dead = siteRegistry(build.dir)
      .filter((s) => !hosts.some((h) => s.host.test(h)))
      .map((s) => s.key);
    assert.deepStrictEqual(
      dead, [],
      `These sites.js entries can never fire — no manifest content_script ` +
      `match loads content.js on them, usually because the host migrated and ` +
      `the manifest was updated but this list kept the old pattern (or vice ` +
      `versa). In ${build.dir}/sites.js:\n  ${dead.join('\n  ')}`,
    );
  });

  // The list is only single-source if everything that needs it actually loads
  // it. A build that quietly kept its own copy would pass every test above.
  test(`${build.dir}: the manifest loads sites.js before content.js`, () => {
    const mf = JSON.parse(readFileSync(join(EXT, build.dir, 'manifest.json'), 'utf8'));
    const withContent = (mf.content_scripts || []).filter((cs) => (cs.js || []).includes('content.js'));
    assert.ok(withContent.length > 0, `${build.dir}: no content_script registers content.js`);
    for (const cs of withContent) {
      assert.ok(
        cs.js.indexOf('sites.js') !== -1 && cs.js.indexOf('sites.js') < cs.js.indexOf('content.js'),
        `${build.dir}: sites.js must load BEFORE content.js — content scripts share ` +
        `one isolated world and run in array order, so listing it after (or not at all) ` +
        `leaves globalThis.VODOU_SITES undefined and every site unroutable.`,
      );
    }
  });

  // PLAN-BRIDGE-SIDE-PANEL P0 — the panel is a THIRD consumer of the registry.
  // Skipped on builds that have no panel yet (the spike landed in sideload first).
  test(`${build.dir}: the side panel loads sites.js before its own script`, () => {
    const panel = join(EXT, build.dir, 'sidepanel.html');
    if (!existsSync(panel)) return;
    const html = readFileSync(panel, 'utf8');
    // Parse actual <script src> order. A raw indexOf is not enough: the word
    // "sites.js" also appears in the explanatory comment above the tags, which
    // always precedes them — so an indexOf check passes even with the scripts in
    // the wrong order. (Found by trying to make this very assertion fail.)
    const order = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
    const iSites = order.indexOf('sites.js');
    const iPanel = order.indexOf('sidepanel.js');
    assert.ok(iSites !== -1, `${build.dir}: sidepanel.html loads no sites.js script tag`);
    assert.ok(
      iPanel !== -1 && iSites < iPanel,
      `${build.dir}: sidepanel.html must load sites.js BEFORE sidepanel.js — script order is ` +
      `[${order.join(', ')}]. Loaded after, globalThis.VODOU_SITES is undefined when the panel ` +
      `runs and it silently reports "not a supported site" on all 22.`,
    );
    const js = readFileSync(join(EXT, build.dir, 'sidepanel.js'), 'utf8');
    assert.match(
      js, /globalThis\.VODOU_SITES/,
      `${build.dir}: sidepanel.js must resolve the site from the shared registry, not its own ` +
      `list. Two consumers read it (content, panel); a third private copy is how ` +
      `this class of bug started.`,
    );
  });

  test(`${build.dir}: the settings surface hard-codes no site list of its own`, () => {
    const settings = settingsSource(build.dir);
    assert.ok(
      /globalThis\.VODOU_SITES/.test(settings),
      `${build.dir}: the panel should render its toggles from globalThis.VODOU_SITES`,
    );
    // getElementById('inject-<site>') is the old shape: one fixed element per
    // site, which is how ChatGPT and Claude became the only two a user could
    // turn off while the hotkey was live on 22.
    const hardcoded = [...settings.matchAll(/getElementById\('inject-(\w+)'\)/g)]
      .map((m) => m[1])
      .filter((id) => id !== 'master' && id !== 'sites');
    assert.deepStrictEqual(
      hardcoded, [],
      `${build.dir}: the panel looks up per-site elements by fixed id ` +
      `(${hardcoded.join(', ')}). Toggles must be generated from the shared list ` +
      `so a site can never exist in one place and not the other.`,
    );
  });

  // The capture lane names the same surfaces differently — `characterai` vs
  // `character`, `lechat` vs `mistral`, and four more. Gating capture on the
  // inject key would silently fail to gate exactly those, which is why every
  // entry carries both and why this runs in both directions.
  test(`${build.dir}: every capture adapter has a sites.js entry`, () => {
    const injectSrc = readFileSync(join(EXT, build.dir, 'inject.js'), 'utf8');
    const adapters = [...injectSrc.matchAll(/^\s+name: '([a-z0-9_]+)',$/gm)].map((m) => m[1]);
    assert.ok(adapters.length > 0, `${build.dir}: parsed no capture adapters out of inject.js`);
    const known = new Set(siteRegistry(build.dir).map((s) => s.capture));
    const orphans = [...new Set(adapters)].filter((a) => !known.has(a));
    assert.deepStrictEqual(
      orphans, [],
      `These capture adapters have no sites.js entry, so their turns cannot be ` +
      `gated per site — captureSites[provider] is undefined, which reads as ON, ` +
      `and the panel shows no toggle for them:\n  ${orphans.join('\n  ')}`,
    );
  });

  test(`${build.dir}: every sites.js capture name matches a real adapter`, () => {
    const injectSrc = readFileSync(join(EXT, build.dir, 'inject.js'), 'utf8');
    const adapters = new Set([...injectSrc.matchAll(/^\s+name: '([a-z0-9_]+)',$/gm)].map((m) => m[1]));
    const dead = siteRegistry(build.dir).filter((s) => !adapters.has(s.capture)).map((s) => `${s.key} -> ${s.capture}`);
    assert.deepStrictEqual(
      dead, [],
      `These sites.js capture names match no adapter in inject.js, so their panel ` +
      `toggle controls nothing — a typo here is invisible because an unmatched key ` +
      `just never gets consulted:\n  ${dead.join('\n  ')}`,
    );
  });

  test(`${build.dir}: capture and inject keys are distinct namespaces`, () => {
    // Not a style rule: they are stored in DIFFERENT maps (vodou_capture_sites
    // keyed by adapter, vodou_inject_settings.sites keyed by inject key). If a
    // future edit made them identical strings everywhere the distinction would
    // look redundant and someone would collapse them — this records that six
    // genuinely differ today.
    const differ = siteRegistry(build.dir).filter((s) => s.key !== s.capture).map((s) => s.key);
    assert.ok(
      differ.length >= 6,
      `${build.dir}: expected at least 6 sites where the inject key and capture ` +
      `adapter name differ, found ${differ.length} (${differ.join(', ')}). If the ` +
      `vocabularies were genuinely unified, collapse the two fields deliberately ` +
      `and delete this test — do not just lower the number.`,
    );
  });

  // Absent must mean ON, for both lanes. Every existing install has no per-site
  // map at all, so `!== false` is the entire reason shipping this changes nobody's
  // behaviour. Written as `=== true` it would read as "off" for all 22 and quietly
  // stop capture on upgrade — a silent data-loss bug with no error anywhere.
  test(`${build.dir}: an absent per-site setting means ON, not OFF`, () => {
    const content = readFileSync(join(EXT, build.dir, 'content.js'), 'utf8');
    assert.match(
      content, /captureSites\[provider\] !== false/,
      `${build.dir}: the capture gate must test \`!== false\`. Anything stricter ` +
      `treats "never configured" as "disabled" and silently stops capture for ` +
      `every install that upgrades into this build.`,
    );
    assert.match(
      content, /injectSettings\.sites\[site\] === false/,
      `${build.dir}: the inject gate must test \`=== false\` for the same reason.`,
    );
  });

  test(`${build.dir}: capture is gated by the per-site check, not just the master`, () => {
    const content = readFileSync(join(EXT, build.dir, 'content.js'), 'utf8');
    assert.match(
      content, /captureAllowedFor\(d\.provider\)/,
      `${build.dir}: the netcap relay must consult captureAllowedFor(d.provider). ` +
      `Gating on autoCaptureOn alone is the all-or-nothing behaviour this replaced, ` +
      `and it fails open — every site keeps capturing.`,
    );
  });

  // PLAN-CAPTURE-SAFETY P0-a. Three properties that must hold in CODE, not in a
  // doc, because each failure is silent and the whole point of the switch is that
  // it is trustworthy enough to cite in diligence.
  test(`${build.dir}: the remote policy can only take away, never grant`, () => {
    const bg = readFileSync(join(EXT, build.dir, 'background.js'), 'utf8');
    assert.match(
      bg, /if \(v && v\.capture === false\) providers\[name\] = \{ capture: false \};/,
      `${build.dir}: background.js must keep ONLY explicit capture:false entries. ` +
      `If it stored the file's values verbatim, a remote capture:true would override ` +
      `a user's own off switch — the one thing this switch must never do.`,
    );
    const content = readFileSync(join(EXT, build.dir, 'content.js'), 'utf8');
    assert.match(
      content, /capturePolicy\[provider\] && capturePolicy\[provider\]\.capture === false/,
      `${build.dir}: the policy must be applied as a veto (&&-ed into the gate), not ` +
      `as a source of truth that could re-enable a site.`,
    );
  });

  test(`${build.dir}: the policy fetch fails open and is not a beacon`, () => {
    const bg = readFileSync(join(EXT, build.dir, 'background.js'), 'utf8');
    assert.match(
      bg, /credentials: 'omit'/,
      `${build.dir}: the policy fetch must send no credentials. With cookies it ` +
      `becomes an install-tracking beacon and "captured data never touches Vodou ` +
      `infrastructure" stops being true.`,
    );
    assert.ok(
      /if \(!res\.ok\) return;/.test(bg) && /catch \(_\) \{[^}]*fail open/i.test(bg),
      `${build.dir}: every fetch failure path must return without clearing the cached ` +
      `policy. Failing closed means a plane or a hotel portal silently stops capture.`,
    );
    assert.ok(
      !/POLICY_URL = '[^']*\?/.test(bg),
      `${build.dir}: the policy URL must carry no query string — that is where an ` +
      `install id would end up.`,
    );
  });

  test(`${build.dir}: the policy host is declared in the manifest`, () => {
    const bg = readFileSync(join(EXT, build.dir, 'background.js'), 'utf8');
    const url = /POLICY_URL = '(https:\/\/[^/']+)/.exec(bg);
    assert.ok(url, `${build.dir}: could not find POLICY_URL in background.js`);
    const mf = JSON.parse(readFileSync(join(EXT, build.dir, 'manifest.json'), 'utf8'));
    const host = `${url[1]}/*`;
    assert.ok(
      (mf.host_permissions || []).includes(host),
      `${build.dir}: ${host} must be in host_permissions or the fetch depends on the ` +
      `server's CORS headers and fails silently the day they change.`,
    );
  });

  test(`${build.dir}: a vetoed site is shown as disabled, and the veto is never persisted`, () => {
    const settings = settingsSource(build.dir);
    assert.match(
      settings, /if \(veto\[key\]\)/,
      `${build.dir}: the panel must render a remotely-disabled site as disabled. A box ` +
      `that stays ticked while capture does nothing is the silent-failure shape.`,
    );
    assert.match(
      settings, /if \(!veto\[key\]\) sites\[key\] = box\.checked;/,
      `${build.dir}: a vetoed site's forced-false box must never be written to storage — ` +
      `that would turn a temporary provider block into a permanent user preference that ` +
      `survives the veto being lifted.`,
    );
  });

  test(`${build.dir}: every site has a label for the panel`, () => {
    const unlabelled = siteRegistry(build.dir).filter((s) => !s.label || !s.label.trim()).map((s) => s.key);
    assert.deepStrictEqual(unlabelled, [], `${build.dir}: these sites would render a blank toggle`);
  });

  test(`${build.dir}: chatgpt uses the '${build.chatgpt}' mechanism`, () => {
    const chatgpt = siteRegistry(build.dir).find((s) => s.key === 'chatgpt');
    assert.ok(chatgpt, `${build.dir}: no chatgpt entry in sites.js`);
    assert.strictEqual(
      chatgpt.mechanism, build.chatgpt,
      build.chatgpt === 'composer'
        ? `The store build must NOT use the network body-rewrite — 9bdbbc8 removed ` +
          `outgoing-request rewriting so the store build reads only, and reintroducing ` +
          `it here would both break (inject.js has no rewriter) and undo the CWS ` +
          `review posture.`
        : `The sideload build keeps the invisible network body-rewrite on ChatGPT — ` +
          `it is the one mechanism sideload has that the store build does not.`,
    );
  });
}

// PLAN-BRIDGE-SIDE-PANEL P1 — the panel took over the picker, so three things must
// stay true. Each of them is the kind of regression that looks fine in review.
test('the panel owns the picker, and the 22-host remount loop stays dead', () => {
  for (const build of BUILDS) {
    const cPath = join(EXT, build.dir, 'content.js');
    if (!existsSync(cPath) || !existsSync(join(EXT, build.dir, 'sidepanel.js'))) continue;
    const content = readFileSync(cPath, 'utf8');

    // 1. Exactly one remount timer: the "Save to Vodou" button, which runs on two
    //    hosts. The 🧠 picker button's timer ran on all 22 purely to lose a race
    //    with the host SPA; the panel cannot be deleted by the page, so it is gone.
    const timers = (content.match(/setInterval\(mount/g) || []).length;
    assert.strictEqual(
      timers, 1,
      `${build.dir}: expected exactly 1 setInterval(mount…) — the capture button's, on 2 ` +
      `hosts — but found ${timers}. A second one means the in-page picker button's ` +
      `3-second loop is back on all 22 hosts, fighting the page for a button the side ` +
      `panel replaced.`,
    );

    // 2. The page keeps the two jobs only it can do. Without these the panel has no
    //    search seed and no way to type into the composer, and it fails by going
    //    quiet rather than by erroring.
    for (const m of ['vodou_panel_probe', 'vodou_panel_insert']) {
      assert.match(
        content, new RegExp(`'${m}'`),
        `${build.dir}: content.js must answer ${m}. The panel cannot read the composer ` +
        `draft or type into the page itself.`,
      );
    }

    // 3. The insert must go through insertTextVerified. execCommand returns true on
    //    ProseMirror/Lexical while the editor silently drops the edit — the
    //    2026-07-16 finding. Reverting to insertText would report success into a
    //    composer that never received the text.
    // Slice to the END of the handler, not a fixed character window: a comment
    // added inside it pushed insertTextVerified past a 1200-char cut and failed this
    // test for no real reason. Bound on the next handler instead.
    const from = content.indexOf("'vodou_panel_insert'");
    const nextHandler = content.indexOf('return undefined;\n    });', from);
    const handler = content.slice(from, nextHandler === -1 ? from + 4000 : nextHandler);
    assert.match(
      handler, /insertTextVerified\(/,
      `${build.dir}: the panel insert handler must use insertTextVerified, not insertText — ` +
      `rich editors lie about accepting an edit.`,
    );
  }
});

// Every control must be wired to something that can actually succeed.
//
// Chad asked "is it fully wired up" and two controls were not: "Save this chat" rendered
// on all 22 sites but the gateway only has DOM extractors for ChatGPT and Claude, so it
// could only fail on 20; and the custom-gateway checkbox rendered in every build though
// only the store build handles set_allow_custom_gateway. Both are worse than a missing
// feature — a control that does nothing teaches people the product is broken.
test('no control is offered where it cannot work', () => {
  for (const build of BUILDS) {
    const panelPath = join(EXT, build.dir, 'sidepanel.js');
    if (!existsSync(panelPath)) continue;
    const panel = readFileSync(panelPath, 'utf8');

    // The custom-gateway control only appears where the build answers the message.
    assert.match(
      panel, /hasOwnProperty\.call\(st, 'allow_custom_gateway'\)/,
      `${build.dir}: the custom-gateway checkbox must be gated on the build reporting the ` +
      `field. Sideload builds have no set_allow_custom_gateway handler, so the control ` +
      `silently does nothing there.`,
    );
  }

  // And the gate must match reality: if a build handles the message, it should report it.
  for (const build of BUILDS) {
    const bgPath = join(EXT, build.dir, 'background.js');
    if (!existsSync(bgPath)) continue;
    const bg = readFileSync(bgPath, 'utf8');
    const handles = bg.includes("'set_allow_custom_gateway'");
    const reports = /allow_custom_gateway:/.test(bg);
    assert.strictEqual(
      handles, reports,
      `${build.dir}: background.js ${handles ? 'handles' : 'does not handle'} ` +
      `set_allow_custom_gateway but ${reports ? 'does' : 'does not'} report ` +
      `allow_custom_gateway in get_status. The panel decides whether to show the control ` +
      `from that field, so the two must agree.`,
    );
  }
});

// The panel must NOT offer a full-conversation history import. Removed 2026-07-30
// after Chad asked whether it actually saves everything on Claude — it does not.
//
// The gateway's extractors (`claude_conversation`, the ChatGPT path in
// Vodou-Console/src/api/memory-import.ts) are a single querySelectorAll over rendered
// message nodes: no scrolling, no pagination. Both sites virtualise long threads, so the
// earlier messages such a button promises are exactly what it cannot deliver — and the
// data agreed: no large webcap:claude or import:claude conversation has ever existed.
// The real lanes are the provider's export (Claude) and the paginating backfill
// (ChatGPT), per PLAN-CAPTURE-SAFETY P1-a. Live turns are covered everywhere by passive
// capture.
//
// This guard exists because the control was added twice with labels that had to be
// walked back both times. If it returns, the history problem must be solved first.
test('the panel offers no full-history import', () => {
  for (const build of BUILDS) {
    const html = join(EXT, build.dir, 'sidepanel.html');
    if (!existsSync(html)) continue;
    const markup = readFileSync(html, 'utf8');
    const js = readFileSync(join(EXT, build.dir, 'sidepanel.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
    assert.ok(
      !/id="s-import"/.test(markup),
      `${build.dir}: a history-import control is back in the panel. The extractors read ` +
      `only rendered nodes, so it cannot deliver the earlier messages it implies.`,
    );
    assert.ok(
      !/trigger_capture/.test(js),
      `${build.dir}: the panel sends trigger_capture again. That is the DOM-extractor ` +
      `path — use the provider export or the paginating backfill for history.`,
    );
  }
});

// Panel layout decisions that are easy to undo by accident.
//
// Chad, 2026-07-29: the console/brain links and the Disconnect control must be on the
// MAIN view, not buried in Settings — they are global and used daily. Connection state
// is likewise global, so it sits above the tabs rather than inside one view.
test('global controls are global, and no developer noise reaches the user', () => {
  for (const build of BUILDS) {
    const p = join(EXT, build.dir, 'sidepanel.html');
    if (!existsSync(p)) continue;
    const html = readFileSync(p, 'utf8');
    const tabs = html.indexOf('<nav class="tabs"');
    assert.ok(tabs !== -1, `${build.dir}: no tab nav found`);

    for (const id of ['s-link-gw', 's-link-brain', 's-toggle', 's-line']) {
      const at = html.indexOf(`id="${id}"`);
      assert.ok(at !== -1, `${build.dir}: ${id} is missing from the panel`);
      assert.ok(
        at < tabs,
        `${build.dir}: ${id} sits after the tab nav, which means it lives inside a view. ` +
        `Console/Brain links, Disconnect and the state line are global — burying a daily ` +
        `control two taps deep in Settings is a tax on the user.`,
      );
    }

    // A tab id is developer noise. It was on the panel's first card and read like a
    // debugger, not a product.
    assert.ok(
      !/id="tab"/.test(html),
      `${build.dir}: the raw tab id is back on the panel. It means nothing to a user.`,
    );

    // Quality floor, stated so it cannot quietly disappear in a restyle.
    assert.match(html, /:focus-visible/, `${build.dir}: no visible keyboard focus style`);
    assert.match(html, /prefers-reduced-motion/, `${build.dir}: reduced motion not respected`);
    // Still true, different mechanism: light/dark used to be a media query in this
    // file and is now theme.js, which defaults to mode 'browser' and only follows
    // Vodou when the user ticks the box. The rule is what matters, so assert the
    // rule where it now lives.
    assert.match(
      html, /<script src="theme\.js"><\/script>/,
      `${build.dir}: theme.js is not loaded, so nothing decides light/dark or palette.`,
    );
    const theme = readFileSync(join(EXT, build.dir, 'theme.js'), 'utf8');
    assert.match(
      theme, /prefers-color-scheme: light/,
      `${build.dir}: the panel must follow the browser's light/dark — a dark panel against ` +
      `a light browser reads as a foreign object, which is the opposite of the goal.`,
    );
    // The default INVERTED (2026-08-29): following the browser made the whole
    // feature invisible whenever the browser and the Console disagreed — the panel
    // stayed exactly as it was hardcoded. Vodou's mode is now the default; the
    // browser is one tick away, and that escape hatch is what this guards.
    assert.match(
      theme, /o\.modeChoice === 'browser' \? 'browser' : 'vodou'/,
      `${build.dir}: the panel must default to Vodou's light/dark, and a stored mode ` +
      `must be an explicit choice — not a default written back as one.`,
    );
  }
});

// The popup is RETIRED (Chad, 2026-07-30): the toolbar icon opens the panel
// directly, and the panel holds every control the popup held — settings via
// controls.js, pairing, connection, the localhost lock. This guard keeps the
// retirement honest in all three directions: a manifest that regrows a
// default_popup silently steals the icon click back (chrome.action.onClicked
// stops firing and the panel never opens); popup files with no manifest entry
// ship dead code to store review; and an icon handler that awaits before
// openVodouPanel() spends the user gesture and open() throws (§5b).
test('the popup stays retired — the toolbar icon opens the panel', () => {
  for (const build of BUILDS) {
    const mfPath = join(EXT, build.dir, 'manifest.json');
    if (!existsSync(mfPath)) continue;
    const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
    assert.ok(
      !(mf.action && mf.action.default_popup),
      `${build.dir}: manifest declares a default_popup again. A popup swallows the icon ` +
      `click, so chrome.action.onClicked never fires and the panel stops opening from the icon.`,
    );
    for (const f of ['popup.html', 'popup.js']) {
      assert.ok(
        !existsSync(join(EXT, build.dir, f)),
        `${build.dir}: ${f} is back. The panel is the only settings surface; a second one ` +
        `is how this extension got six uncoordinated copies of the same controls.`,
      );
    }
    const bg = readFileSync(join(EXT, build.dir, 'background.js'), 'utf8');
    assert.match(
      bg, /chrome\.action\.onClicked\.addListener\(\(tab\) => \{\s*\n\s*if \(tab && tab\.id\) openVodouPanel\(tab\.id, 'icon click'\);/,
      `${build.dir}: the icon click must open the panel FIRST and synchronously — the user ` +
      `gesture does not survive an await, and any statement before openVodouPanel() invites one.`,
    );
  }
});

// Enabling a custom gateway is the only setting that can send chat data off the
// machine. It keeps its friction in BOTH surfaces — and the panel must not use a modal
// dialog to do it, because a dialog in an extension page blocks the surface it is drawn
// in (and the store build's whole "local only" claim rests on this control).
test('a custom gateway needs confirmation, without a modal', () => {
  for (const build of BUILDS) {
    const panelPath = join(EXT, build.dir, 'sidepanel.js');
    if (!existsSync(panelPath)) continue;
    const panel = readFileSync(panelPath, 'utf8');
    if (!panel.includes('set_allow_custom_gateway')) continue;
    assert.match(
      panel, /s-allow-confirm/,
      `${build.dir}: enabling a custom gateway must be confirmed, not a single click.`,
    );
    assert.ok(
      !/\bconfirm\(/.test(panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1')),
      `${build.dir}: the panel must not call confirm() — a modal in an extension page ` +
      `blocks that page. Use the inline two-step.`,
    );
  }
});

// The store build carries security code the others do not, and a verbatim file
// copy between builds destroys it.
//
// That happened on 2026-07-29 while syncing the shared-controls extraction: 235
// lines of the store build's settings surface were replaced with the sideload
// version, removing `allow_custom_gateway` — the lock that keeps the store build
// pointed at localhost unless the user explicitly opts out, with confirmation.
// That property is load-bearing in CWS-PERMISSION-JUSTIFICATIONS and the privacy
// policy. The lock's enforcement lives in background.js; its ONLY user control is
// the panel's Advanced section.
test('the store build keeps its localhost lock', () => {
  const dir = 'Store-vodou-bridge';
  const bgPath = join(EXT, dir, 'background.js');
  if (!existsSync(bgPath)) return;
  const bg = readFileSync(bgPath, 'utf8');
  for (const marker of ['isLocalGatewayUrl', 'vodou_allow_custom_gateway', 'set_allow_custom_gateway']) {
    assert.match(
      bg, new RegExp(marker),
      `${dir}/background.js has lost "${marker}". The store build must keep the ` +
      `custom-gateway opt-out — it is what makes "local Vodou only" true, and it is ` +
      `cited in the CWS permission justifications. This is what a verbatim background ` +
      `copy from another build looks like.`,
    );
  }
  const panel = readFileSync(join(EXT, dir, 'sidepanel.js'), 'utf8');
  assert.match(
    panel, /set_allow_custom_gateway/,
    `${dir}: the panel has lost the allow-custom-gateway control — with no UI, the ` +
    `lock cannot be inspected or deliberately opted out of.`,
  );
});

// A send whose readyState check is separated from it by an await or a callback
// is not a check at all — and the resulting console warning CANNOT be caught.
//
// WebSocket.send() on a CLOSING/CLOSED socket does not throw: per spec it discards
// the data, and Chrome writes "WebSocket is already in CLOSING or CLOSED state."
// to the console itself. Every send site in background.js was already wrapped in
// try/catch and the warning appeared anyway (Chad, 2026-07-30) — because catching
// was never going to help. sendActiveTab() was the source: it checked readyState,
// then ran chrome.tabs.query, then sent from the async callback, and it fires on
// every tab switch and every page load.
test('tab_changed sends re-check the socket inside the callback', () => {
  for (const build of BUILDS) {
    const bgPath = join(EXT, build.dir, 'background.js');
    if (!existsSync(bgPath)) continue;
    const bg = readFileSync(bgPath, 'utf8');

    assert.match(
      bg, /function sendOn\(sock, obj\) \{\s*\n\s*if \(!sock \|\| sock\.readyState !== WebSocket\.OPEN\) return false;/,
      `${build.dir}: background.js needs the sendOn(sock, obj) guard — one place that ` +
      `re-checks readyState at the moment of sending.`,
    );

    const from = bg.indexOf('function sendActiveTab()');
    assert.ok(from !== -1, `${build.dir}: sendActiveTab is gone`);
    const body = bg.slice(from, bg.indexOf('\n}', from));
    assert.ok(
      !/\bws\.send\(/.test(body),
      `${build.dir}: sendActiveTab sends on the raw socket again. Its send runs inside ` +
      `a chrome.tabs.query callback, so any readyState check before the query is stale ` +
      `by then — use sendOn(ws, …), which re-checks. try/catch does NOT suppress the ` +
      `"already in CLOSING or CLOSED state" warning; only not calling send does.`,
    );
    assert.match(
      body, /sendOn\(ws,/,
      `${build.dir}: sendActiveTab must send through sendOn().`,
    );
  }
});

// content.js must actually RUN, not merely parse.
//
// 2026-07-30: a CSS comment inside the injected <style> template contained a
// backtick (`.vodou-busy`). That ENDED the JS template literal early, and what
// followed re-parsed as `"...".vodou - busy`...`` — a subtraction whose right
// operand is a tagged template on an undefined identifier. Still valid SYNTAX,
// so `node --check` passed and the store zip packed clean; at runtime it threw
// ReferenceError on load and took the whole content script with it. No button,
// no netcap relay, no panel probe handlers — and nothing in the page console.
//
// A syntax check cannot catch that class of bug. Executing it can. The globals
// below are stubs, but the CONTEXT is a plain object on purpose: an undeclared
// identifier must still throw ReferenceError rather than resolve to a proxy.
test('content.js executes without throwing', async () => {
  const vm = await import('node:vm');
  // Permissive stand-in: any property access or call returns another one, so the
  // script can walk the DOM API freely without us modelling it.
  // `overrides` must be consulted INSIDE the get trap. Object.assign()ing onto a
  // proxy looks like it works and does nothing: the set trap swallows the write and
  // the get trap still answers every read. That mistake made the first version of
  // this test green while the bug it exists for was sitting in the file.
  const anything = (label, overrides = {}) => new Proxy(function () {}, {
    get(_t, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === Symbol.iterator) return function* () {};
      if (prop === 'then') return undefined;          // must not look thenable
      if (prop === 'length') return 0;
      return anything(`${label}.${String(prop)}`);
    },
    set: () => true,
    has: () => true,
    apply: () => anything(`${label}()`),
    construct: () => anything(`new ${label}`),
  });

  for (const build of BUILDS) {
    const file = join(EXT, build.dir, 'content.js');
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');

    // Real values only where they gate control flow — otherwise the script takes
    // an early exit and the code under test never runs.
    const ctx = {
      chrome: anything('chrome'),
      // document behaves like a FRESH page: lookups miss. A blanket proxy returns
      // truthy for getElementById, which makes every `if (!document.getElementById(
      // ...))` guard false — so the guarded body never runs and the test cannot see
      // a bug inside it. That is exactly how the first version of this test passed
      // while the backtick bug was still present.
      document: anything('document', {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => anything('el'),
        createElementNS: () => anything('svgEl'),
        addEventListener() {},
        removeEventListener() {},
        body: anything('document.body'),
        head: anything('document.head'),
        documentElement: anything('document.documentElement'),
        title: '',
        readyState: 'complete',
      }),
      navigator: anything('navigator'),
      localStorage: { getItem: () => null, setItem: () => {} },
      location: { hostname: 'claude.ai', href: 'https://claude.ai/chat/x', pathname: '/chat/x' },
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      MutationObserver: function () { return anything('mo'); },
      console: { log() {}, warn() {}, error() {}, debug() {} },
      getComputedStyle: () => anything('cs'),
      requestAnimationFrame: () => 0,
      fetch: () => Promise.resolve(anything('res')),
      CustomEvent: function () {}, Event: function () {},
      KeyboardEvent: function () {}, Node: function () {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      postMessage() {}, matchMedia: () => anything('mq'),
      Promise, JSON, Math, Date, RegExp, Object, Array, String, Number, Boolean,
      Error, TypeError, Map, Set, WeakMap, WeakSet, Symbol, URL, URLSearchParams,
      encodeURIComponent, decodeURIComponent, btoa: (s) => s, atob: (s) => s,
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    ctx.self = ctx;

    try {
      vm.createContext(ctx);
      vm.runInContext(src, ctx, { filename: `${build.dir}/content.js`, timeout: 5000 });
    } catch (err) {
      assert.fail(
        `${build.dir}/content.js threw on load: ${err && err.message}\n` +
        `  This is what a stray backtick inside the injected <style> template does — ` +
        `it closes the literal early and the remainder still PARSES, so node --check ` +
        `and the pack script both pass while the content script is dead in the browser.`,
      );
    }
  }
});

// Every path into logActivity must actually WRITE.
//
// 2026-07-30: a regex cleanup removing a retired-key `storage.remove` call spanned
// from the comment above it to the remove() line, swallowing the
// `chrome.storage.local.set({ [ACTIVITY_KEY]: log })` that sat between them — the
// ONLY write for a new row. Nothing failed. Capture and inject kept working, acks
// kept arriving, and the panel's Activity tab simply stopped growing, which looks
// exactly like "nothing is being captured". It cost an evening of chasing the
// gateway before anyone looked at the writer.
//
// The merge branches each have their own set(); the tail (a brand-new row) needs
// one too. Count them rather than trust one.
test('logActivity writes on every branch', () => {
  for (const build of BUILDS) {
    const p = join(EXT, build.dir, 'background.js');
    if (!existsSync(p)) continue;
    const bg = readFileSync(p, 'utf8');
    const from = bg.indexOf('function logActivity(');
    assert.ok(from !== -1, `${build.dir}: logActivity is gone`);
    const body = bg.slice(from, bg.indexOf('\n}', from));

    const writes = (body.match(/chrome\.storage\.local\.set\(\{\s*\[ACTIVITY_KEY\]/g) || []).length;
    assert.ok(
      writes >= 3,
      `${build.dir}: logActivity has ${writes} storage write(s), expected 3 — one per ` +
      `merge branch plus the new-row tail. A missing tail write is SILENT: everything ` +
      `keeps working and the activity feed just never grows.`,
    );

    // the tail specifically: unshift a new row, then persist it
    assert.match(
      body,
      /log\.unshift\(e\);[\s\S]{0,400}?chrome\.storage\.local\.set\(\{\s*\[ACTIVITY_KEY\]/,
      `${build.dir}: logActivity unshifts a new row but never writes it back.`,
    );
  }
});

// Every declared command MUST be handled, or Chrome swallows the keystroke.
//
// Registering inject-context/inject-visible as manifest commands made Chrome capture
// Ctrl+B at browser level; the page's keydown listener stopped seeing it and the
// hotkey went dead the moment it became discoverable. Declaring a command takes the
// key away from the page, so the extension owes a handler for it.
test('every declared command has a handler', () => {
  for (const build of BUILDS) {
    const mfPath = join(EXT, build.dir, 'manifest.json');
    if (!existsSync(mfPath)) continue;
    const cmds = Object.keys(JSON.parse(readFileSync(mfPath, 'utf8')).commands || {});
    if (!cmds.length) continue;
    const bg = readFileSync(join(EXT, build.dir, 'background.js'), 'utf8');
    const unhandled = cmds.filter((c) => !bg.includes(`'${c}'`));
    assert.deepStrictEqual(
      unhandled, [],
      `${build.dir}: declared in the manifest but never handled in background.js: ` +
      `${unhandled.join(', ')}. Chrome captures a declared command's keystroke, so the page ` +
      `never sees the keydown — the shortcut goes dead rather than falling through.`,
    );
  }
});

// A composer insert must never carry the machine fence.
//
// The picker inserted the gateway's fenced block into the composer, which Chad saw
// land as raw markup. The fence belongs to the INVISIBLE network path;
// PLAN-AUTO-INJECT-P4 §0.1 found a fenced "retrieved memory" block trips Claude's
// injection resistance. Fence-less then REQUIRES the loop-strip registry, because
// there is no marker for capture to strip.
test('the panel insert is fence-less and registered for loop-strip', () => {
  for (const build of BUILDS) {
    const panelPath = join(EXT, build.dir, 'sidepanel.js');
    if (!existsSync(panelPath)) continue;
    const panel = readFileSync(panelPath, 'utf8');
    assert.match(
      panel, /type: 'vodou_panel_insert', items:/,
      `${build.dir}: the panel must send the chosen items, not a pre-formatted block.`,
    );
    assert.ok(
      !/\$\{p\.open\}/.test(panel),
      `${build.dir}: sidepanel.js is assembling a fenced block again — in a composer a ` +
      `human reads, that lands as raw vodou:context markup.`,
    );
    const content = readFileSync(join(EXT, build.dir, 'content.js'), 'utf8');
    const from = content.indexOf("'vodou_panel_insert'");
    const end = content.indexOf('return undefined;\n    });', from);
    // Strip comments before matching. FOURTH time in this file that a guard matched
    // its own prose: commenting the call out left the string `registerStrip(` in the
    // comment and the assertion still passed. Guards over source text must look at
    // code, not at text that mentions code.
    const handler = content.slice(from, end === -1 ? from + 4000 : end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
    assert.match(
      handler, /registerStrip\(/,
      `${build.dir}: a fence-less insert MUST call registerStrip — with no marker, capture ` +
      `cannot strip it and the injected text re-enters memory as though the user typed it.`,
    );
  }
});

// Reloading the extension orphans content scripts in open tabs. Two things must be
// true or the panel silently stops working after every update — which is exactly what
// happened on the first live P1 run: probe failed, so the seed was empty, so the
// gateway seeded from captured turns and returned unrelated memories, and insert had
// no handler to reach. It looked like two bugs and was one.
test('the content script survives an extension reload', () => {
  for (const build of BUILDS) {
    const cPath = join(EXT, build.dir, 'content.js');
    if (!existsSync(cPath) || !existsSync(join(EXT, build.dir, 'sidepanel.js'))) continue;
    const content = readFileSync(cPath, 'utf8');

    // Guards must be versioned. `if (window.__x) return;` makes re-injection a no-op,
    // so a newer build cannot replace an orphaned older one.
    assert.match(
      content, /const MOUNT_TOKEN/,
      `${build.dir}: content.js needs a versioned MOUNT_TOKEN guard.`,
    );
    const boolGuards = content.match(/if \(window\.__vodou\w+\) return;/g) || [];
    assert.deepStrictEqual(
      boolGuards, [],
      `${build.dir}: these guards are boolean, so re-injecting a new build returns early ` +
      `and registers nothing: ${boolGuards.join(' ')}`,
    );

    // The panel must heal rather than instruct. "Reload the tab" is how this bug
    // survives contact with a user.
    const panel = readFileSync(join(EXT, build.dir, 'sidepanel.js'), 'utf8');
    assert.match(
      panel, /vodou_ensure_content/,
      `${build.dir}: the panel must re-inject the content script when a probe fails.`,
    );

    // An empty seed must never be sent as a query: the gateway seeds from captured
    // turns, which returns confidently unrelated results.
    assert.match(
      panel, /seed\.trim\(\)\.length >= 2/,
      `${build.dir}: the panel must not search on an empty seed.`,
    );
  }
});

test('the panel picker keeps the tuned ranking behaviour', () => {
  for (const build of BUILDS) {
    const p = join(EXT, build.dir, 'sidepanel.js');
    if (!existsSync(p)) continue;
    const js = readFileSync(p, 'utf8');
    // These were tuned against real queries. A silent change to any of them alters
    // what gets pre-ticked, which is what actually travels to a third-party AI.
    assert.match(js, /PRE_FLOOR = 20/, `${build.dir}: the 20% pre-check floor is missing`);
    assert.match(js, /PRE_CAP = 5/, `${build.dir}: the 5-item pre-check cap is missing`);
    assert.match(
      js, /item\.in_vault && relPct\(item\) >= preThresh/,
      `${build.dir}: private (out-of-vault) items must never be auto-ticked — an explicit ` +
      `tick is the consent step for anything outside the shared vault.`,
    );
  }
});

// sidePanel.open() "may only be called in response to a user action", and Chrome's
// user gesture does NOT survive an await. The first version of this code awaited
// setOptions() and then open(), spending the gesture on the way — so open() threw
// and the panel never appeared. Two structural rules keep that from returning:
//
//   1. Nothing may be awaited inside openVodouPanel before sidePanel.open().
//   2. The commands listener must not be async — an async listener invites exactly
//      the `await chrome.tabs.query(...)` that broke it.
test('the side panel open path never awaits before open()', () => {
  for (const build of BUILDS) {
    const bgPath = join(EXT, build.dir, 'background.js');
    if (!existsSync(bgPath)) continue;
    const bg = readFileSync(bgPath, 'utf8');
    if (!bg.includes('openVodouPanel')) continue;

    const fnStart = bg.indexOf('function openVodouPanel');
    assert.ok(fnStart !== -1, `${build.dir}: openVodouPanel not found as a function declaration`);
    assert.ok(
      !/async\s+function openVodouPanel/.test(bg),
      `${build.dir}: openVodouPanel must NOT be async — an async body is how an await ` +
      `creeps in before open() and silently spends the user gesture.`,
    );
    const openAt = bg.indexOf('chrome.sidePanel.open(', fnStart);
    assert.ok(openAt !== -1, `${build.dir}: openVodouPanel never calls chrome.sidePanel.open()`);
    // Strip comments first. The comment above open() explains the gesture rule and
    // therefore contains the word "await" — matching that is a false positive, and
    // the second time in this file a guard has tripped over prose it was written to
    // protect (see the sites.js script-order test).
    const preamble = bg.slice(fnStart, openAt)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
    assert.ok(
      !/\bawait\b/.test(preamble),
      `${build.dir}: there is an 'await' between entering openVodouPanel and calling ` +
      `sidePanel.open(). Chrome's user gesture does not survive it, so open() throws ` +
      `"may only be called in response to a user action" and the panel never opens.`,
    );

    const cmdAt = bg.indexOf('chrome.commands.onCommand.addListener(');
    if (cmdAt !== -1) {
      assert.ok(
        !/chrome\.commands\.onCommand\.addListener\(\s*async/.test(bg),
        `${build.dir}: the commands listener is async. Keep it synchronous so the gesture ` +
        `reaches sidePanel.open() — resolve the tab from the event's own tab argument.`,
      );
    }
  }
});

// macOS: a bare "Ctrl" in a mac suggested_key is NOT the Control key.
//
// Chrome converts it to Command ("On macOS Ctrl is automatically converted into
// Command"), so `"mac": "Ctrl+B"` asks for Cmd+B. That broke twice over on
// 2026-07-29: Ctrl+Shift+M became Cmd+Shift+M, which Chrome's own profile switcher
// owns and which "cannot be overridden", so the panel shortcut did nothing at all;
// and Ctrl+B became Cmd+B, which is the site's bold and is exactly what
// content.js:1006 deliberately avoids (`e.ctrlKey && !e.metaKey`).
//
// The content-script gate tests the literal Control key, so the manifest must ask
// for the literal Control key: MacCtrl.
test('mac shortcuts use MacCtrl, not bare Ctrl', () => {
  for (const build of BUILDS) {
    const mfPath = join(EXT, build.dir, 'manifest.json');
    if (!existsSync(mfPath)) continue;
    const cmds = JSON.parse(readFileSync(mfPath, 'utf8')).commands || {};
    for (const [name, def] of Object.entries(cmds)) {
      const mac = (def.suggested_key || {}).mac;
      if (!mac) continue;
      assert.ok(
        !/(^|\+)Ctrl(\+|$)/.test(mac),
        `${build.dir}: command "${name}" has mac="${mac}". A bare Ctrl there means COMMAND, ` +
        `not Control. Use MacCtrl for the Control key (or say Command explicitly if that is ` +
        `really what you want). content.js gates on e.ctrlKey && !e.metaKey, so Command would ` +
        `never reach it.`,
      );
    }
  }
});

// The panel is all-or-nothing PER BUILD, and every build either has it or none do.
//
// This is the invariant the version test alone could not catch. On 2026-07-29 the
// spike landed in sideload only while all three were bumped to one version — so
// three packages claimed 0.5.97.11 while one of them had a whole surface the others
// lacked. Under "one version line", equal versions must mean equal features; the
// deliberate lineage difference is the ChatGPT mechanism, nothing else.
test('the side panel is present in every build, or none', () => {
  const present = BUILDS.filter((b) => existsSync(join(EXT, b.dir, 'manifest.json')));
  const state = present.map((b) => {
    const mf = JSON.parse(readFileSync(join(EXT, b.dir, 'manifest.json'), 'utf8'));
    return {
      dir: b.dir,
      html: existsSync(join(EXT, b.dir, 'sidepanel.html')),
      js: existsSync(join(EXT, b.dir, 'sidepanel.js')),
      perm: (mf.permissions || []).includes('sidePanel'),
      declared: !!(mf.side_panel && mf.side_panel.default_path),
      cmd: !!(mf.commands && mf.commands['toggle-side-panel']),
    };
  });
  // Per build: all five parts or none. A build with the files but no permission
  // fails silently at runtime — sidePanel is simply undefined and the panel never
  // opens, with nothing to see.
  for (const s of state) {
    const parts = [s.html, s.js, s.perm, s.declared, s.cmd];
    assert.ok(
      parts.every(Boolean) || !parts.some(Boolean),
      `${s.dir} is HALF-ported: files=${s.html && s.js}, permission=${s.perm}, ` +
      `side_panel=${s.declared}, command=${s.cmd}. Files without the permission means ` +
      `chrome.sidePanel is undefined and the panel silently never opens.`,
    );
  }
  // Across builds: same answer everywhere, so equal versions mean equal features.
  const has = state.filter((s) => s.html).map((s) => s.dir);
  assert.ok(
    has.length === 0 || has.length === state.length,
    `The panel is in some builds but not others (${has.join(', ')}), while all builds share ` +
    `one version. Either port it everywhere or give the builds distinct versions — as it ` +
    `stands, one version string would name packages with different features.`,
  );
});

// Versions must be ONE line across builds. They drifted to three different values
// (store .10, sideload .9, sideload-only .8) because each got bumped by whichever
// piece of work touched it. Two things break when they diverge:
//
//   • Order stops meaning anything. On 2026-07-29 sideload .9 contained the side
//     panel while store .10 did not, so the higher number was the older code.
//   • `dist/` zips are named by version, so `vodou-bridge-0.5.97.9-store.zip`
//     already existed from an earlier STORE build at .9 — one version string
//     naming two different packages.
//
// The builds differ in content by design (network vs composer on ChatGPT); they do
// not differ in release. Same version, different flavour.
test('every build reports the same version', () => {
  const versions = BUILDS
    .filter((b) => existsSync(join(EXT, b.dir, 'manifest.json')))
    .map((b) => [b.dir, JSON.parse(readFileSync(join(EXT, b.dir, 'manifest.json'), 'utf8')).version]);
  const distinct = [...new Set(versions.map(([, v]) => v))];
  assert.strictEqual(
    distinct.length, 1,
    `The builds report different versions:\n  ${versions.map(([d, v]) => `${d}: ${v}`).join('\n  ')}\n` +
    `Bump all of them together. A higher number must always mean newer code, whichever ` +
    `build it is, and the dist zip filenames depend on it.`,
  );
});

// The FIFTH list. The gateway's capture feed keeps its own adapter-name -> title
// map because it runs in a different process and cannot load sites.js. It is the
// same drift class as the other four, and it had already drifted: the toggles said
// "Mistral" where the feed said "Le Chat" for the same surface (found 2026-07-29).
// Both files live in this repo, so the boundary is no excuse for not checking.
//
// Convention: labels are PRODUCT names, not company names — ChatGPT not OpenAI,
// Claude not Anthropic, Le Chat not Mistral.
test('the gateway feed agrees with sites.js on every provider title', () => {
  const feedPath = join(EXT, '..', 'MCP-servers', 'Vodou-Console', 'public', 'feed.html');
  if (!existsSync(feedPath)) return; // extension shipped standalone — nothing to compare
  const block = /const PROVIDER_LABEL = \{([\s\S]*?)\};/.exec(readFileSync(feedPath, 'utf8'));
  assert.ok(block, 'feed.html: PROVIDER_LABEL map not found — did it move or get renamed?');
  const feed = new Map([...block[1].matchAll(/'?([\w-]+)'?:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));

  const missing = [];
  const conflicting = [];
  for (const s of siteRegistry('Store-vodou-bridge')) {
    if (!feed.has(s.capture)) missing.push(`${s.capture} (${s.label})`);
    else if (feed.get(s.capture) !== s.label) conflicting.push(`${s.capture}: panel "${s.label}" vs feed "${feed.get(s.capture)}"`);
  }
  assert.deepStrictEqual(
    missing, [],
    `These providers have no title in the feed, so their capture cards render the ` +
    `raw adapter key:\n  ${missing.join('\n  ')}`,
  );
  assert.deepStrictEqual(
    conflicting, [],
    `The panel and the capture feed show DIFFERENT names for the same surface. A ` +
    `user unticks one name and sees another in the feed:\n  ${conflicting.join('\n  ')}`,
  );
  // The feed legitimately carries more: the IDE lanes (claude-code, cursor) are
  // capture sources with no browser site and so no entry in sites.js.
});

// The policy file is deployed by hand to a CDN, so a provider name that drifts from
// the registry is a kill switch that silently does nothing on the day it matters.
test('the example capture policy lists exactly the known adapters', () => {
  const examplePath = join(EXT, 'capture-policy.example.json');
  if (!existsSync(examplePath)) return;
  const example = JSON.parse(readFileSync(examplePath, 'utf8'));
  const listed = Object.keys(example.providers || {}).sort();
  const known = [...new Set(siteRegistry('Store-vodou-bridge').map((s) => s.capture))].sort();
  assert.deepStrictEqual(
    listed, known,
    `capture-policy.example.json must list exactly the capture adapter names in ` +
    `sites.js. A name only in the example is a veto that will never match; a name ` +
    `missing from it is a provider nobody knows they can switch off.`,
  );
});

// The divergence that actually matters. Sideload may differ from store on
// MECHANISM (network vs composer on ChatGPT) but must never differ on COVERAGE:
// the build the team and alpha users run should never inject on fewer sites
// than the public one. That was true until 2026-07-29 — sideload had 2 entries
// to the store's 22 — and nothing reported it.
test('no build injects on fewer sites than the store build', () => {
  const present = BUILDS.filter((b) => existsSync(join(EXT, b.dir, 'content.js')));
  const store = present.find((b) => b.dir === 'Store-vodou-bridge');
  if (!store) return;
  const baseline = new Set(siteRegistry(store.dir).map((s) => s.key));
  for (const build of present) {
    if (build.dir === store.dir) continue;
    const have = new Set(siteRegistry(build.dir).map((s) => s.key));
    const missing = [...baseline].filter((k) => !have.has(k));
    assert.deepStrictEqual(
      missing, [],
      `${build.dir} injects on fewer sites than the store build. Ctrl+B works ` +
      `for the public but not for us on:\n  ${missing.join('\n  ')}`,
    );
  }
});
