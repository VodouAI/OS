/**
 * Cards framework — type definitions.
 * See PLANS/0.5.88/PLAN-LENSES-FRAMEWORK-v4.md + PLAN-LENSES-MVP.md
 *
 * A card is a pluggable visual block the assistant can emit in chat.
 * It binds to one or more URL patterns + a motive, defines how to fetch
 * the data it needs, and how to render that data into a small focused UI.
 *
 * fetch() runs server-side on the gateway (this file's neighborhood).
 * Component() runs client-side in the browser (public/js/lenses/).
 * The render model JSON crosses the wire — source HTML never does.
 */

export type CardPath = 'bridge' | 'puppeteer' | 'cheerio';

export type CookieScope = 'ephemeral' | 'card-scoped' | 'user-scoped';

export interface CardRequires {
  /** Domains the card touches. Documentation only — not enforced. */
  network_domains?: string[];
  /** Does this card need a JS-rendered page? */
  runs_js?: boolean;
  /** Does this card require the user's real session (Bridge-only)? */
  needs_session?: boolean;
  /** Ordered render-path preference. Default: ['cheerio']. */
  paths?: CardPath[];
  /** Cookie jar scope (only meaningful for puppeteer fallback). */
  cookie_scope?: CookieScope;
}

export interface CardActionDef {
  /** Display label for the action button. */
  label: string;
  /** Whether the action requires per-domain user consent before running. */
  requiresConsent: boolean;
  /** Server-side handler — typically dispatches a Bridge `act_in_tab` command. */
  run: (model: any, ctx: ActionCtx) => Promise<{ ok: boolean; message?: string }>;
}

export interface LensManifest {
  type: string;
  version: number;
  /** Human-readable description. The Router-LLM reads this to match user intent. */
  motive: string;
  /** Glob URL patterns the card claims (e.g. "*.allrecipes.com/recipe/*"). */
  url_patterns: string[];
  /** Per-card cache TTL in seconds. */
  ttl_seconds: number;
  /** Constraints / requirements. */
  requires: CardRequires;
  /** Optional icon (emoji or path). */
  icon?: string;
  /** Optional category for management UI grouping. */
  category?: string;
  /** Optional author handle. */
  author?: string;
  /** License — defaults to MIT for community contribution. */
  license?: string;
  /**
   * Optional list of render-model fields this lens extracts (e.g. ["title",
   * "ingredients", "steps"]). Shown in the inspect modal's "What it extracts"
   * section. Omitted → inspect view shows "(not declared)".
   */
  extracts?: string[];
  /**
   * Required fields in the lens `payload` object. Surfaced in the system
   * prompt so the LLM knows exactly which keys it must include. e.g.
   * `["origin", "destination"]` for map.directions. Models that don't infer
   * schema well (Kimi K2.x) need this to be explicit.
   */
  payload_required?: string[];
  /**
   * JSON example of a valid `payload` shape. Surfaced verbatim in the system
   * prompt — give the LLM a concrete template to copy. e.g.
   * `{ "origin": "Detroit, MI", "destination": "Grand Rapids, MI", "mode": "driving" }`
   */
  payload_example?: Record<string, any>;
}

/**
 * The render model is the JSON the card.fetch() returns — and the ONLY
 * thing that crosses the wire to the browser. No source HTML ever leaks
 * past this boundary. This is the structural privacy/safety guarantee.
 */
export type RenderModel = Record<string, any>;

export interface FetchCtx {
  /** Native fetch — defaults to a real Chrome UA so sites don't bot-gate us. */
  fetchStatic(url: string, init?: RequestInit): Promise<{
    status: number;
    body: string;
    headers: Record<string, string>;
  }>;
  /** Cheerio loader for simple DOM parsing. */
  cheerio: typeof import('cheerio')['load'];
  /** Bridge-routed fetch (uses user's real session). null if Bridge unavailable. */
  extension: BridgeApi | null;
  /**
   * LLM snippet helper — generate a short summary or extract structured
   * info from text using the gateway's LLM provider chain. Cards can use
   * this to turn raw fetched HTML/text into a clean snippet for display.
   * Throws if no LLM is configured.
   */
  llmSnippet(prompt: string, opts?: { max_tokens?: number; system?: string }): Promise<string>;
}

export interface ActionCtx extends FetchCtx {
  /** Conversation context for the action. */
  conversationId: string;
  /** Source URL the card was rendered for. */
  sourceUrl: string;
}

export interface BridgeApi {
  /** Fetch URL in the user's Chrome (carries real cookies + session). */
  fetch(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    body: string;
    status: number;
    headers: Record<string, string>;
  }>;
  /** Open a hidden tab, extract fragments by selector, close it. */
  extract(url: string, selector: string, opts?: { wait_for?: string; timeout_ms?: number }): Promise<{
    matches: Array<{ outerHTML: string; text: string; attrs: Record<string, string> }>;
  }>;
  /** Run a function in a matching tab. Returns the function's return value. */
  actInTab(urlPattern: string, fn: string, args?: any[]): Promise<{ result: any }>;
  /** Snapshot of tabs the user has open right now. */
  listTabs(urlPattern?: string): Promise<Array<{ id: number; url: string; title: string }>>;
  /**
   * **bridge:cookies path** — fetch a URL with the user's Chrome session
   * cookies, **no tab opened**. Use this when the site returns useful
   * server-rendered HTML (GitHub, Reddit old, news sites, dashboards that
   * render server-side). Returns SPA shells for sites like Gmail/X — use
   * `extract()` for those instead.
   */
  cookiesFetch(url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: 'follow' | 'manual';
  }): Promise<{
    body: string;
    status: number;
    headers: Record<string, string>;
    url?: string;
    cookies_sent?: number;
  }>;
  /**
   * **observe() cache** — read an opportunistic snapshot stored by an
   * observer (e.g. gmail.unread caches inbox state while user is on Gmail).
   * Returns null if no snapshot exists. Includes `updated_at` so the lens
   * can decide if it's fresh enough.
   */
  cacheGet(key: string): Promise<{ value: any; updated_at: number } | null>;
  /** Write/overwrite an observe() snapshot for a given key. */
  cacheSet(key: string, value: any): Promise<void>;
  /**
   * CSP-safe page extraction for sites where `actInTab` fails because the
   * target page forbids `unsafe-eval` (Gmail, X, banks). Lenses pass a
   * built-in extractor ID; the extension dispatches to a hardcoded function
   * reference via `chrome.scripting.executeScript({func})`, which doesn't
   * trigger CSP's eval rules. Available IDs are defined in
   * `extension/vodou-bridge/background.js` BUILTIN_EXTRACTORS.
   */
  extractBuiltin(id: string): Promise<any>;
  /**
   * Navigate an existing tab matching `match_url` to `url`. If no match
   * (or `new_tab: true`), opens a new tab. Lets lens row-clicks land in
   * the user's already-logged-in session instead of spawning a new tab.
   */
  openUrl(url: string, opts?: { match_url?: string; new_tab?: boolean }): Promise<{ tab_id: number; reused: boolean }>;
}

export interface LensModule {
  /** Manifest data — what gets shown to users + read by router-LLM. */
  manifest: LensManifest;
  /** Validate the payload before fetch. Cheap, synchronous. */
  validate(payload: any, sourceUrl?: string): boolean;
  /** Synthesize a source URL from payload when the LLM didn't provide one. */
  synthesizeUrl?(payload: any): string;
  /**
   * Server-side. Pull data, return the render model. The render model
   * is the ONLY thing that reaches the browser. Source HTML never does.
   */
  fetch(payload: any, sourceUrl: string, ctx: FetchCtx): Promise<RenderModel>;
  /** Per-action server-side handlers (for `card_action` AGENT_ACTIONS). */
  actions?: Record<string, CardActionDef>;
  /** Health check — verify selectors still produce non-empty output. */
  extractionHealth?(model: RenderModel): { ok: boolean; missing?: string[] };
}

export interface CardRegistration {
  module: LensModule;
}

export interface RouterFacade {
  /** What the router-LLM reads in 0.5.89. Stable shape. */
  listManifests(): LensManifest[];
  /** Find cards whose url_patterns match the given URL. */
  findCardsForUrl(url: string): LensManifest[];
}

/** Standard error codes returned from /api/lenses/fetch. */
export type CardErrorCode =
  | 'UNKNOWN_TYPE'
  | 'VALIDATION_FAILED'
  | 'FETCH_FAILED'
  | 'EXTRACTION_FAILED'
  | 'SELECTORS_STALE'
  | 'BRIDGE_REQUIRED'
  | 'TIMEOUT'
  | 'INTERNAL';

export interface CardError {
  code: CardErrorCode;
  message: string;
  detail?: any;
}
