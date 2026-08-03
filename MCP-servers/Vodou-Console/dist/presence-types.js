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
export {};
