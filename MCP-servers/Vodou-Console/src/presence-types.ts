/**
 * Presence v1 — sessions-as-data contract served at GET /api/presence.
 * PLAN-PRESENCE-DOCK (0.6.18).
 *
 * RULES: `id` is stable for the life of the session (surface-prefixed, see
 * presence.ts id derivation). `surface` and `actions` are closed enums —
 * renderers switch on them; an unknown value must render as an inert
 * observe-only tile, never crash.
 *
 * Mirrored by hand at one/web/app/src/api/presence-types.ts — keep in sync.
 */

export type PresenceSurface = 'gateway' | 'browser' | 'channel' | 'ide' | 'autonomous' | 'cli';

export type PresenceState = 'active' | 'idle' | 'awaiting_approval' | 'running' | 'stale';

export type PresenceCapture = 'on' | 'off' | 'pending' | 'n/a';

export type PresenceInjectable = 'full' | 'composer' | 'body-rewrite' | 'none';

export type PresenceAction =
  | 'open'          // navigate to the owning view / focus the browser tab
  | 'inject'        // push mem context into the session (browser: composer/body)
  | 'send'          // full write (gateway/channel/cli convs)
  | 'approve'       // autonomous approval pending
  | 'stop'          // stop a running turn / autonomous run
  | 'view-memory';  // deep-link Brain console filtered to this session's chunks

export interface PresenceSession {
  /** Stable, surface-prefixed id:
   *  gw:<conversationId> | ch:<conversationId> | web:<provider>:<convToken>
   *  web:<provider>:tab:<tabId> (ephemeral, upgrades in place — see replacesId)
   *  ide:<source> | auto:<kind>:<conversationId> | cli:<conversationId> */
  id: string;
  surface: PresenceSurface;
  /** 'claude' | 'chatgpt' | 'slack' | 'telegram' | 'cursor' | 'heartbeat' | 'vodou' | ... */
  provider: string;
  title: string;
  state: PresenceState;
  /** ISO; drives live/idle and the tile pulse. */
  lastActivity: string;
  capture: PresenceCapture;
  injectable: PresenceInjectable;
  memoryScope: { vault: string | null; projectId: string | null };
  /** Server-computed — the client never invents actions. */
  actions: PresenceAction[];
  /** When an ephemeral tab session upgraded to a stable id, the id it replaces
   *  (so the tile morphs instead of duplicating). */
  replacesId?: string;
  /** Surface-specific extras, render-optional.
   *  browser: {tabId, url, host, tabActive}  autonomous: {kind}
   *  ide: {lagSeconds, sources} */
  detail?: Record<string, unknown>;
}

export interface PresenceSnapshot {
  version: 1;
  generatedAt: string;
  sessions: PresenceSession[];
  counts: {
    live: number;             // lastActivity within liveWindowMs
    capturing: number;        // capture === 'on' within liveWindowMs
    awaitingApproval: number;
  };
  liveWindowMs: number;       // what "live" means (default 15 min)
  /** Extension bridge state — when disconnected, browser tabs are simply
   *  absent (never phantom tiles) and the client may show its bridge affordance. */
  bridge: { connected: boolean };
}

/** WS event pushed to every client on a session state transition. */
export interface PresenceUpdateEvent {
  type: 'presence_update';
  session: PresenceSession;
}
