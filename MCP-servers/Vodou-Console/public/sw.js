/**
 * Vodou gateway service worker — caches static assets for fast load.
 * Does NOT cache API calls or WebSocket — those need to be live.
 */

// Bump this when assets need force-revalidation. Old service workers
// keep intercepting requests until a SW with a different CACHE_NAME
// activates. The activate handler below deletes old caches.
//   v180 → v181: card-fence renderer escape fix (2026-05-17)
//   v181 → v182: card-fence base64 attribute fix (2026-05-17)
//   v182 → v183: card light-theme readability fixes (2026-05-17)
//   v183 → v184: recipe.allrecipes 404 detection + no-invent-URLs prompt
//   v184 → v185: card title light-theme color + remove duplicate emoji icons
//   v185 → v186: mount card placeholders on history reload
//   v186 → v187: lenses sidebar view + nav entry (PLAN-LENSES-MANAGEMENT Phase 3)
//   v187 → v188: lenses community directory browse modal (Phase 4)
//   v188 → v189: lenses permissions tab + scaffold/health endpoints (Phase 5)
//   v189 → v190: lenses view uses theme CSS vars (light/dark fix)
//   v190 → v191: fix /js/cards/* → /js/lenses/* script tags (404 since rename) + npm.package renderer
//   v191 → v192: fix vodou-card-* → vodou-lens-* class mismatch (shell wrote new names, CSS used old → empty lens body)
//   v192 → v193: chat.js reads `data-lens-block-b64` post-rename (was reading data-card-block-b64 → empty pre tag)
//   v193 → v194: phase indicator above streaming bubble (🧠 Thinking… / 🛠 Using N tools) + lens-vs-tool system prompt
//   v194 → v195: gmail.unread pretty renderer + Gmail aria-label extractor
//   v195 → v196: clickable rows navigate existing Gmail tab (Bridge openUrl)
//   v196 → v197: §0.8a manage-modal extensions — tools list, intents/skills counts, Remove server, ?manage=X URL state
//   v197 → v198: §0.8b "+ Add server" dropdown + §0.8c filter (apps + tools) + noopener popup fix (Canva connect)
//   v198 → v199: stop toggle event bubbling (side panel flash) + "From catalog" scrolls to first grid section
//   v199 → v200: drop success toast on toggle — the toast slide-in was the "opens/closes on the right" Chad saw
//   v200 → v201: §0.8a phase 2b — per-tool enable/disable toggle + health-log section in manage modal
//   v201 → v202: drop ALL success toasts on /apps (connect/disconnect/add/remove) — same right-side flash as toggle
//   v202 → v203: mind-map click reliability — switch jsmind to SVG renderer + fallback click listener; localStdio disconnect now reflects active flag; workbench unmount on remount (no doubled responses)
//   v203 → v204: hide Atlas tab from Memory view (kept in code, just not surfaced)
//   v204 → v205: lens BRIDGE_REQUIRED renders a real install card with step-by-step instructions instead of a tiny "fetch failed" warning
//   v205 → v206: Lenses view shows a passive bridge-status banner up top with install/wake instructions when the extension isn't connected
//   v206 → v207: Apps view shows the same bridge-status banner above the grid
//   v207 → v208: bridge banners only show when an installed lens actually needs the bridge (most lenses use server-side fetch and work without it)
//   v208 → v209: chat scroll — pin user prompt to top of viewport at stream start, stop per-chunk auto-scroll-to-bottom (no more bouncing); refresh still lands at bottom
//   v209 → v210: tab/history load snaps to bottom invisibly (mask during scroll, drop 400ms late jump) — content just appears at the bottom
//   v210 → v211: disable browser scrollRestoration (was fighting our snap-to-bottom on reload) + bump chat/apps/memory/lenses/shell ?v= so the new JS actually loads
//   v211 → v212: override CSS scroll-behavior:smooth on #chat-messages (was animating every programmatic scroll → the visible "load and scroll" on tab/page load)
//   v212 → v213: skill "Draft with AI" populates required_tools from real Vodou servers + gmail placeholder (was generic mcp-monitor example)
//   v213 → v214: Draft with AI now also fills advanced fields (delivery_mode/target, ephemeral, history_window, stopping_points, prefer_model, parameters_json) with strict server-side validation
//   v215 → v216: skills review panel (autonomous draft proposals) + sidebar review badge — bump skills.js?v=2 + new skills-review-badge.js so the new JS loads
//   v216 → v217: drop 🧪 from review panel header — skills.js?v=3
//   v217 → v218: dock — split Heartbeat+Board into own cluster vs chats; rename BRIEFING→Heartbeat; bump chat.js?v=64 so the new dock JS actually loads past stale SW cache
//   v218 → v219: dock group divider was chat-tab-sep (display:none in shell-v2 → invisible); switch to chat-tab-tier-divider; chat.js?v=65
//   v219 → v220: Board (source='board') was misclassified as a channel → messaging tier; exclude it so it joins the Heartbeat system cluster; chat.js?v=66
//   v220 → v221: Heartbeat/Board group divider now matches inter-tier hairlines exactly (full height via align-self:stretch + asymmetric 8px/12px spacing, was a short 20px symmetric line); 05-shell.css?v=57
//   v221 → v222: Chats now render as their own .chat-tab-tier so the Heartbeat/Board→Chats divider IS a .chat-tab-tier::before (identical to all other group dividers); removed the standalone span; chat.js?v=67
//   v222 → v223: rename a primary chat now re-renders the scope header so its letter-avatar icon matches the new name (was only the dock icon updating); chat.js?v=68
//   v223 → v224: chat scroll — stick-to-bottom guard; scrolling up stops the load/stream auto-snap (was yanking back to bottom); chat.js?v=69
//   v224 → v225: temporarily disable the memory-indicator hover that listed the specific memories used this turn (generic tooltip only); chat.js?v=70
//   v225 → v226: board UI self-heals — periodic ~30s reconcile so cards converge to DB truth even when a completion emits no refresher event (stuck-in-progress fix); board.js?v=4
//   v226 → v227: board set_status now emits a status_changed event (Rust) so every transition is visible to the live poll; board.js refresher list + ?v=5
//   v227 → v228: lens-fence entity-decode fix — escapeHtml now escapes "/' so lens JSON was base64'd with entities → JSON.parse failed at mount → raw-JSON-leak; chat.js?v=71
//   v228 → v229: dock Group 1 now holds ALL automated runs — scheduled skill_run tabs (daily-competitor-intel / morning-briefing) join via source==='skill-console' in isSystemTab; surfaced automations hoisted into #chat-tabs in _renderAppsTier; chat.js?v=73
//   v229 → v230: recently-closed chat restore — undo toast on tab close + ↺ dock menu (soft-delete backed); toast Undo inherits toast palette; ↺ dock tip no longer says "New chat"; chat.js?v=74 shell-init.js?v=16 04-views.css?v=34 05-shell.css?v=58
//   v230 → v231: info-toast light-theme readability — --toast-bg stays dark in light theme but --text-secondary flips dark → dark-on-dark; pin light text; 04-views.css?v=35
//   v231 → v232: first-run EULA click-wrap in onboarding Step 0 — checkbox gates both connect paths, server-enforced via gateway_settings (eula_accepted_at); signup forwards terms_accepted to app.vodou.ai; onboarding.js?v=19
//   v232 → v233: legal links point at app.vodou.ai (live) instead of vodou.ai (no site yet); onboarding.js?v=20
//   v233 → v234: fix onboarding finish → #/chat (was #/heartbeat + reload, hid chat panel); router.js?v=3 chat.js?v=75 onboarding.js?v=21
//   v234 → v235: pinned heartbeat run-prompt was opacity:0.6 → feed bled through the sticky header; force opacity:1 when .pin-active; 03-layout-chat.css?v=14
//   v235 → v236: live tool-chip timer (.tool-elapsed) had no reserved width → every tick resized the chip and bounced the wrap row; tabular-nums + min-width:5ch + right-align; 03-layout-chat.css?v=15
//   v236 → v237: docs viewer — GFM tables, code-block protection, heading anchor IDs + in-page scroll, cross-doc links; force-purge stale docs.js/04-views.css; js/views/docs.js css/04-views.css
//   v237 → v238: per-project dock (Phase 1) — skills sidebar filters by active project; project editor gains a skill checklist; project:changed re-filters the dock; chat.js?v=76 skills.js?v=4 projects.js?v=2 04-views.css
//   v238 → v239: per-project dock (Phase 2) — Scheduled view splits System vs per-project user tasks; new tasks inherit the active project; move-to-project select; project:changed re-filters; scheduler.js?v=5 04-views.css
//   v239 → v240: fix — dock chat-tab strip now filters by active project (was showing all projects' tabs); Heartbeat/Board stay global; switching project re-scopes tabs + lands on the project's chat; chat.js?v=77
//   v240 → v241: Claude CLI "Reconnect" banner — chat shows a signed-out banner (GET /api/claude-auth/status) w/ Reconnect (opens in-app terminal auto-running claude) + Switch provider; classify connection/logout errors → actionable msg; pre-dispatch guard kills the 15-min hang; chat.js?v=78 terminal.js?v=2 04-views.css
//   v241 → v242: left-nav IA cleanup — Chat/Board/Memory promoted to top; Skills+Capabilities merged into one "Skills & Tools" group (Automated skill folded in); section labels (Connections, Capabilities); Docs & API moved to footer; Settings "Memory" → "Memory tuning"; router.js?v=4 index.html
//   v242 → v243: "Obsidian, Bone & Gold" design direction — warm obsidian palette + bone text + ritual-gold accent (01-tokens dark+light); btn ink fix; nav section-label gold hairline + active weight; css 01/02/03 bumped
//   v243 → v244: chat tab strip — active tab expands into a labeled gold pill (icon + title) so the current chat is readable; inactive stay calm muted icon tiles; fix hardcoded-teal active state → gold; 05-shell.css?v=59
//   v244 → v245: fix "NC" tab pile-up — raise hydration bar (abandoned default-titled chats need a completed turn ≥2 msgs to become a tab); collapse unused "New Chat" shells on restore (keep ≤1); chat.js?v=79
//   v245 → v246: chat empty-state redesign — crossroads sigil + "What do you need done?" + 4 real starter prompts (recall/automate/build/connect) that prefill the composer; chat.js?v=80 03-layout-chat.css?v=17
//   v246 → v247: warm the shell-v2 glass — menubar + dock strip backgrounds were cold blue-grey rgba(20,22,28); now warm obsidian to match the canvas; menu hover uses accent-ink; 05-shell.css?v=60
//   v247 → v248: palette cleanup — warm the top status pills (were cool white); replace all bare teal #0d9488 washes in shell-v2 + the teal gradient badge + voice dot with gold; 05-shell.css?v=61 04-views.css?v=36
//   v248 → v249: Settings active-provider card → gold (border + tint + ring) and ACTIVE badge → solid gold, matching the app's active language; green "Ready" health check unchanged; 04-views.css?v=36
//   v250 → v251: project switcher restyled to match the dock — tile radius/height, warm glass, gold-tinted border + hover wash; 04-views.css?v=38
//   v251 → v252: project-color tab chip only shows for cross-project tabs (dock filters to active project, so same-project chips were redundant 'dots on every tab'); chat.js?v=81
//   v252 → v253: Apps sidebar auto-refreshes (30s poll + apps:changed event) so a newly added MCP server auto-loads into the nav without a page reload; apps.js?v=14
//   v253 → v255: dock "calm & consistent" cleanup — idle letter-avatars now ONE quiet aged-bronze tone (was a rainbow of hashed colors), strip left-aligned (was floating center), ALL vertical pipe separators gone (tier::before + tier-divider + legacy `.chat-tab + .chat-tab::before` from 03-layout-chat.css) → grouping by quiet whitespace gaps; only the active gold pill stays loud; chat.js?v=82 05-shell.css?v=63
//   v255 → v256: extend the calm palette past the dock — chat title-bar avatar was a bright hashed-red letter box, now GOLD on a gold-washed tile (matches the active pill, since the title bar = current chat); project-switcher dot was an off-palette blue-grey, now gold (active project); dropdown keeps per-project colors; chat.js?v=83 05-shell.css?v=64 04-views.css?v=39
//   v256 → v257: dock groupings shown off as recessed "trays" — each cluster (Runs · Chats · Messaging · Apps · Skills) now sits in a subtle inset well (darker wash + hairline + inner shadow) so groups read as distinct, macOS-dock style; dock height 44→50 for tray breathing room; active gold pill still pops above its tray; 05-shell.css?v=65
//   v257 → v258: bump dock tray contrast — wells were too subtle; darker wash (0.18→0.30), brighter hairline (0.05→0.10), deeper inner shadow so the groupings read more clearly; 05-shell.css?v=66
//   v258 → v259: Chats/Messaging/Apps/Skills trays — neutralize legacy `.chat-tabs` strip styling (03-layout-chat.css `border-bottom` underline + `--bg-secondary` fill) inside the v2 dock so the inner strip is transparent and matches its group tray; Runs (#chat-tabs) keeps its tray fill via the more-specific rule; 05-shell.css?v=67
//   v259 → v260: Google Calendar app-tray icon was dark-on-dark in dark mode — its monochrome glyph was mislabeled logoColor:true so it missed the mono-invert; corrected preset to logoColor:false (presets/google-calendar.json, takes effect next gateway restart) + a dark-mode CSS shim that inverts it to white now (scoped :not(.icon-logo-mono-img) so it can't double-invert after the preset reloads); 05-shell.css?v=68
//   v260 → v261: de-dupe redundant System-status links — removed the menubar "Connected" WS pill (#shell-ind-ws) and the footer "Kernel" runtime badge (#chat-runtime-badge); the menubar "OK" kernel pill + left-nav "System status" remain (both → #/system); updater JS already null-guards both; shell-init.js?v=17 + index.html
//   v261 → v262: project switcher dropdown was clipped off-screen when the dock is pinned to the bottom (menu always opened downward at rect.bottom+4); now measures the menu and flips it above the anchor when it wouldn't fit below; chat.js?v=84
//   v262 → v263: menubar dropdowns (View/Window/Help) were too transparent — used the 0.72 bar glass so content bled through; bumped to near-opaque (0.97 dark / 0.98 light) while keeping the blur; 05-shell.css?v=69
//   v263 → v264: progressive onboarding Phase 0+1 — guided spotlight tour (Layer A): new onboarding-tour.js + 07-onboarding-tour.css, Chapter 1 (chat/slash/voice/⌘K/dock), menubar "?" help button (Take tour / Reset tips), offer toast after setup, /?tour=1 deep link; server progress API at /api/onboarding/progress (gateway_settings, live after next gateway restart; client falls back to localStorage until then); shell-init.js?v=18 onboarding-tour.js?v=1 07-onboarding-tour.css?v=1
//   v264 → v265: tour Chapter 2 — full left-sidebar walkthrough (Chat, Board, Memory, Projects, Messaging, Apps, Skills&Tools, Activity, Settings, Advanced, Docs&API, System status), each spotlighted with a beside-the-item coach card (new right/left placement); dropped the voice stop; /?tour=N jumps to stop N; onboarding-tour.js?v=2
//   v265 → v266: progressive onboarding Phase 3 — "Get started" checklist (Layer B): ✨ launcher pill + panel with progress ring + 6 auto-checking milestones (message sent, ⌘K used, tour taken, channel connected, board task run, apps browsed); server signals via GET /api/onboarding/progress/checklist (gateway_messages + board.db, sticky flags); Help "?" → Show checklist; /?checklist=1 deep link; onboarding-tour.js?v=3 07-onboarding-tour.css?v=2
//   v266 → v267: checklist launcher/panel lifted to bottom:84px so it clears the chat composer (no overlap with Send); 07-onboarding-tour.css?v=3
//   v267 → v268: progressive onboarding Phase 4 — first-visit coachmarks (Layer C): a one-time non-blocking gold-ring tip the first time you open Memory/Messaging/Apps/Skills/Activity/Projects/Settings (anchors the view hero, falls back to the nav entry); persists onboarding.coach.<id>_seen_at; "Reset onboarding tips" now also clears the Board's own inline intro (unified reset); onboarding-tour.js?v=4 07-onboarding-tour.css?v=4
//   v268 → v269: progressive onboarding — "what's new since your last visit" nudge: returning users (tour completed) who've added MCP servers/skills get a one-time toast naming the new capabilities, linking to Apps/Skills; baseline snapshot established silently on first run, updated per nudge; new GET /api/onboarding/progress/capabilities (mcp_servers + skills_registry names); onboarding-tour.js?v=5
//   v269 → v270: onboarding offer + what's-new toasts had no box (base .toast has no background; the variant class supplies it) — gave .ob-offer-toast its own palette-matched box (obsidian bg + gold border + shadow); 07-onboarding-tour.css?v=5
//   v270 → v271: fix progress sync precedence — was Object.assign({},server,local) so a STALE local mirror overrode fresher server state (what's-new snapshot never updated); now server wins; onboarding-tour.js?v=6
//   v271 → v272: what's-new diagnostics — /?whatsnew=demo + OnboardingTour.demoWhatsNew() force the boxed nudge with sample data (snapshot-independent); OnboardingTour.version exposes the loaded build (confirm cache-bust); onboarding-tour.js?v=7
//   v272 → v273: dock polish — (1) faint outline + wash on every tab tile so each reads as a separate item; (2) bottom-dock active gold pill no longer clipped (more internal vertical padding 3px→6/7px + tiles grow upward via transform-origin center bottom); (3) more bottom-dock clearance below the chat composer/footer pills (app-content padding-bottom +8px→+20px); 05-shell.css?v=70
//   v273 → v274: bottom-dock clip fixes (proper root cause via live DOM diagnostic) — (a) footer pills were flush against #chat-container overflow:hidden edge → #chat-input-area padding-bottom 0→6px; (b) active gold pill bottom border was clipped because v273's larger bar padding squeezed the content box down to the ~40px tray height (0 clearance) → revert to modest 4/6px padding + min-height 58px so the tray sits well inside the bar's overflow clip; 05-shell.css?v=71
//   v274 → v279: light-mode dark-on-light sweep — fixed undefined-CSS-var dark fallbacks + literal dark fills that rendered dark in every theme (exposed by light mode): skills.js modals/detail panel (committed earlier), chat.js approval-card border + args box (var(--border,#3a3a3a), rgba(0,0,0,0.18)), apps.js reauth-command <pre> (#0f0f0f bg → invisible dark-on-dark in light), and var(--danger) (undefined) → var(--error) in automations.js + projects.js. Replaced with real tokens (--border-primary, --code-bg, --error). Left intentional colored badges/buttons + the dark terminal/log blocks (xterm, channels log) which are self-consistent; chat.js?v=85 apps.js?v=15 automations.js?v=7 projects.js?v=3
//   v279 → v280: mac dock now defaults to BOTTOM for fresh installs — boot reads vodou-shell-dock-pos and goes bottom unless explicitly 'top' (was: top unless explicitly 'bottom'); existing users keep their chosen position; shell-init.js?v=19
//   v282 → v283: non-chat views (/#/apps, settings, docs, etc.) couldn't scroll — #main-content was a flex item missing min-height:0, so tall content grew past the viewport instead of scrolling internally (body is overflow:hidden, so nothing scrolled); added min-height:0 to bound it to the flex chain; 04-views.css?v=40
//   v283 → v284: brand palette default (#2563EB/#6B7280) × light/dark + Settings Appearance selector (data-palette brand|ritual); ritual gold kept as Classic; FOUC boot + accent hardcode sweep; 01-tokens.css?v=5 settings.js?v=15
//   v284 → v285: shell menubar/dock glass follows data-palette (brand cool / ritual warm)
//   v285 → v286: fix Settings _loadProfileForm typo → _loadProfilePanel
//   v286 → v287: Settings nav → Appearance; footer Docs/API type matches nav
//   v287 → v288: System status footer = kernel only (not MCP catalog health)
//   v288 → v289: 10 appearance palettes (8 new) + lean Appearance UI
//   v289 → v290: restore palette card descriptions + roomier grid
//   v290 → v291: +12 appearance palettes (22 total)
//   v291 → v292: cull near-dupe palettes → 12 distinct (brand+ritual+10)
//   v292 → v293: 24 palettes (soft pastels + hard accents)
//   v293 → v294: Soft/Hard/Muted badges on new palettes
//   v294 → v295: popular-product palettes + Soft/Hard/Muted on all
//   v295 → v296: descriptive palette names (no brand marks)
//   v296 → v297: appearance.json sync Console→Brain
//   v297 → v298: Settings Memory vaults — fix preview count, create scopes/flash, clarify System embedder link; settings.js?v=25
//   v298 → v299: System Memory brain — confirm+ETA before bge upgrade/MiniLM revert; Settings link wording; system.js+settings.js cache bump
const CACHE_NAME = 'vodou-v299';
const STATIC_ASSETS = [
  '/icons/vodou-logo.png',
  '/js/lazy.js',
  '/js/api.js',
  '/js/components.js',
  '/js/router.js',
  '/js/chat-helpers.js',
  '/js/chat-composer.js',
  '/js/chat-file-drop.js',
  '/js/workbench-surfaces.js',
  '/js/ws-bus.js',
  '/js/scope-registry.js',
  '/js/scope-adapters/integration.js',
  '/js/scope-adapters/skill.js',
  '/js/scoped-workbench.js',
  '/js/smart-render.js',
  '/js/autocomplete.js',
  '/js/command-palette.js',
  '/js/views/chat.js',
  '/js/views/home.js',
  '/js/views/system.js',
  '/js/views/servers.js',
  '/js/views/skills.js',
  '/js/views/lenses.js',
  '/js/views/intents.js',
  '/js/views/scheduler.js',
  '/js/views/automations.js',
  '/js/views/scripts.js',
  '/js/views/logs.js',
  '/js/views/capabilities.js',
  '/js/views/activity.js',
  '/js/views/terminal.js',
  '/js/views/memory.js',
  '/js/views/setup.js',
  '/js/views/channels.js',
  '/js/views/onboarding.js',
  '/js/skill-runner.js',
  '/js/inline-forms.js',
  '/js/views/settings.js',
  '/js/views/builder.js',
  '/js/builder/canvas.js',
  '/js/builder/nodes.js',
  '/js/builder/properties.js',
  '/js/builder/serializer.js',
  '/js/builder/deserializer.js',
  '/js/builder/validator.js',
  '/js/builder/tool-browser.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls, WebSocket, or POST requests
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    return;
  }

  const isHtml = event.request.headers.get('accept')?.includes('text/html');
  const isCss  = url.pathname.endsWith('.css');
  const isJs   = url.pathname.endsWith('.js');
  const isRootDoc = isHtml && (url.pathname === '/' || url.pathname === '/index.html');

  // Root document: network-only, NO cache fallback. If the gateway is down
  // the user sees the browser's "connection refused" page instead of a
  // stale shell that can't actually talk to anything (which would show
  // confusing WS errors and look like a bug instead of a stopped service).
  if (isRootDoc) {
    return; // pass through to network — browser handles failure naturally
  }

  // Network-first for HTML, CSS, and JS — always get latest, fall back to cache offline.
  // Cache-first only for fonts / icons / images that rarely change.
  if (isHtml || isCss || isJs) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          // Update the cache as a side-effect so offline still works
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
