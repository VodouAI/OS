/**
 * nav-manifest.js — navigation as data (PLANS/0.6.31/redesign, brief §4).
 *
 * ONE list of destinations. The rail renders it, the command palette indexes
 * it, the router's active-state reads it. Adding a capability means joining an
 * existing destination or adding a `reach` entry (⌘K only) — never a rail item.
 *
 * `match` is the list of hash path prefixes that light this destination.
 * `href` is where the rail tile goes. Icons are inline SVG (stroke, 24 box).
 */
(function () {
  'use strict';
  const I = {
    chat:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>',
    memory:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M4.9 19.1l2.2-2.2M16.9 7.1l2.2-2.2"/></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
    skills:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
    connect:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    search:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    feedback: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/><path d="M8.5 9.5h7M8.5 13h4.5"/></svg>',
  };

  window.VodouNav = {
    /** The rail. Order is display order. */
    destinations: [
      { id: 'chat',     label: 'Chat',     href: '#/chat',                   match: ['/chat'],                                   icon: I.chat,     hint: 'Talk with Vodou' },
      { id: 'memory',   label: 'Memory',   href: '#/memory',                 match: ['/memory'],                                 icon: I.memory,   hint: 'What Vodou remembers' },
      { id: 'activity', label: 'Activity', href: '#/activity?tab=history',   match: ['/activity', '/board'],                     icon: I.activity, hint: 'What ran, what is scheduled', badge: 'state-activity' },
      { id: 'skills',   label: 'Skills',   href: '#/capabilities?tab=skills', match: ['/capabilities', '/lenses', '/builder'],   icon: I.skills,   hint: 'Teach Vodou what to do' },
      { id: 'connect',  label: 'Connect',  href: '#/connect',                match: ['/connect', '/messaging', '/apps', '/servers'], icon: I.connect, hint: 'Channels, apps and servers', badge: 'state-messaging' },
    ],
    /** Bottom of the rail. Not outcomes. */
    utility: [
      { id: 'settings', label: 'Settings', href: '#/settings?tab=appearance', match: ['/settings', '/projects'], icon: I.settings, hint: 'Appearance, profile, model, environment' },
    ],
    /**
     * Off-app links. Rendered at the bottom of the rail and offered in ⌘K,
     * but they leave the app — so they are NOT destinations (no `match`, no
     * active state) and every renderer must open them in a new window.
     */
    external: [
      { id: 'feedback', label: 'Feedback', href: 'https://discord.com/invite/KvgVRBY6p5', external: true, icon: I.feedback, hint: 'Tell us what is broken — the Vodou Discord' },
    ],
    icons: I,
    /**
     * Everything else. Reachable from ⌘K and by deep link, never from chrome.
     * ExecDesk is deliberately absent (skipped in 0.6.31, deep link only).
     */
    reach: [
      { label: 'Messaging',      href: '#/connect?tab=messaging',      hint: 'Telegram, Slack, Discord…' },
      { label: 'Apps',           href: '#/connect?tab=apps',           hint: 'OAuth-connected apps' },
      { label: 'MCP servers',    href: '#/connect?tab=servers',        hint: 'Local and remote tool servers' },
      { label: 'Browser',        href: '#/connect?tab=browser',        hint: 'Which sites the extension captures on' },
      { label: 'Scheduled',      href: '#/activity?tab=scheduled',     hint: 'On a schedule, or when a feed has new items' },
      { label: 'History',        href: '#/activity?tab=history',       hint: 'What Vodou did' },
      { label: 'Board',          href: '#/activity?tab=board',         hint: 'Multi-agent task board' },
      { label: 'Projects',       href: '#/projects',                   hint: 'Working directories' },
      { label: 'Scripts',        href: '#/capabilities?tab=scripts',   hint: 'Registered scripts and job runs' },
      { label: 'Routing rules',  href: '#/capabilities?tab=routing-rules', hint: 'Keyword → tool mappings' },
      { label: 'Lenses',         href: '#/lenses',                     hint: 'Rich-rendering modules' },
      { label: 'Terminal',       href: '#/terminal',                   hint: 'Embedded shell' },
      { label: 'Docs & API',     href: '#/docs',                       hint: 'API explorer and guides' },
      { label: 'System status',  href: '#/system',                     hint: 'Version, health, diagnostics' },
      { label: 'Appearance',     href: '#/settings?tab=appearance',    hint: 'Theme and palette' },
      { label: 'Profile',        href: '#/settings?tab=profile',       hint: 'Identity and preferences' },
      { label: 'LLM / Model',    href: '#/settings?tab=model',         hint: 'Provider, model, credentials' },
      { label: 'Environment',    href: '#/settings?tab=env',           hint: 'Variables and secrets' },
      { label: 'Memory tuning',  href: '#/settings?tab=memory',        hint: 'Memory settings' },
      { label: 'Clients',        href: '#/settings?tab=clients',       hint: 'Attached apps and what they may reach' },
      { label: 'About',          href: '#/settings?tab=about',         hint: 'Version and build' },
    ],
    /** Which destination a hash path belongs to. */
    resolve(pathOnly) {
      const all = this.destinations.concat(this.utility);
      for (const d of all) {
        for (const m of d.match) {
          if (pathOnly === m || pathOnly.startsWith(m + '/')) return d.id;
        }
      }
      return null;
    },
  };
})();
