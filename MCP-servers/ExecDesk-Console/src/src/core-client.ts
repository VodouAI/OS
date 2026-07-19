/**
 * Typed HTTP client for vodou-core (127.0.0.1:8766).
 * Reads the per-install shared secret from .vodou/console.token.
 * All methods throw on HTTP or API errors.
 */

import * as fs from "fs";
import * as path from "path";

const CORE_API_PORT = 8766;
const BASE_URL = `http://127.0.0.1:${CORE_API_PORT}`;

// ── Types ──────────────────────────────────────────────────

export interface SearchResult {
  content: string;
  score: number;
  source?: string;
  created_at?: string;
}

export interface IntentMatch {
  server: string;
  tool: string;
  confidence: number;
  keyword: string;
  parameters: Record<string, unknown>;
}

export interface ServerInfo {
  name: string;
  connection_type: string;
  connection_config?: string;
  active: boolean;
  health?: string;
}

export interface ToolInfo {
  server: string;
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AutomationSummary {
  id: number;
  name: string;
  description?: string;
  enabled: boolean;
  interval_minutes: number;
  last_run_at?: string;
  next_run_at?: string;
  run_count: number;
  post_to_chat: boolean;
}

export interface AutomationDetail extends AutomationSummary {
  trigger: unknown;
  actions: unknown[];
  notify?: unknown;
  state: unknown;
  last_error?: string;
  created_at: string;
  updated_at?: string;
}

export interface AutomationRun {
  id: number;
  started_at: string;
  finished_at?: string;
  trigger_result?: unknown;
  actions_result?: unknown;
  events_matched: number;
  success: boolean;
  error?: string;
}

export interface HookInfo {
  id: number;
  name: string;
  event_name: string;
  matcher_type?: string;
  matcher_value?: string;
  hook_type: string;
  hook_command: string;
  hook_config?: unknown;
  priority: number;
  enabled: boolean;
}

export interface ScheduledTask {
  id: number;
  name: string;
  schedule: string;
  schedule_type: string;
  payload: string;
  enabled: boolean;
  one_shot: boolean;
  next_run_at?: string;
  last_run_at?: string;
}

export interface OAuthStatus {
  name: string;
  connection_type: string;
  connected: boolean;
  health?: string;
  credential_count: number;
}

// ── Internal helpers ───────────────────────────────────────

function readToken(): string {
  const projectRoot = process.env.VODOU_PROJECT_ROOT ?? process.cwd();
  const tokenPath = path.join(projectRoot, ".vodou", "console.token");
  try {
    const t = fs.readFileSync(tokenPath, "utf8").trim();
    if (t) return t;
  } catch {
    // fall through
  }
  throw new Error(
    `[vodou-core] console.token not found at ${tokenPath} — start the vodou daemon first`
  );
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${readToken()}`,
  };
}

async function post<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`[vodou-core] POST ${endpoint} → ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { ok: boolean; data: T; error?: string };
  if (!json.ok) throw new Error(`[vodou-core] POST ${endpoint}: ${json.error}`);
  return json.data;
}

async function get<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`[vodou-core] GET ${endpoint} → ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { ok: boolean; data: T; error?: string };
  if (!json.ok) throw new Error(`[vodou-core] GET ${endpoint}: ${json.error}`);
  return json.data;
}

async function del<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`[vodou-core] DELETE ${endpoint} → ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { ok: boolean; data: T; error?: string };
  if (!json.ok) throw new Error(`[vodou-core] DELETE ${endpoint}: ${json.error}`);
  return json.data;
}

async function patch<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`[vodou-core] PATCH ${endpoint} → ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { ok: boolean; data: T; error?: string };
  if (!json.ok) throw new Error(`[vodou-core] PATCH ${endpoint}: ${json.error}`);
  return json.data;
}

// ── Public API ─────────────────────────────────────────────

export const VodouCore = {
  // Health
  async health(): Promise<{ version: string; service: string }> {
    const res = await fetch(`${BASE_URL}/health`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`[vodou-core] health → ${res.status}`);
    return res.json();
  },

  // Memory
  async memorySearch(query: string, topK = 10, scope?: string) {
    return post<{ query: string; count: number; results: SearchResult[] }>(
      "/api/memory/search",
      { query, top_k: topK, scope }
    );
  },

  // Intents
  async analyzeIntent(query: string) {
    return post<{ query: string; matches: IntentMatch[] }>(
      "/api/intents/analyze",
      { query }
    );
  },

  // Brain
  async brainExecute(query: string, clean = false) {
    return post<{ query: string; response: string }>(
      "/api/brain/execute",
      { query, clean }
    );
  },

  // Servers
  async listServers() {
    return get<{ count: number; servers: ServerInfo[] }>("/api/servers");
  },
  async registerServer(params: {
    name: string;
    connection_type: unknown;
    description?: string;
    install_method?: string;
    tags?: string[];
  }) {
    return post<{ id: number; name: string }>("/api/servers", params);
  },
  async removeServer(name: string) {
    return del<{ name: string; deleted: boolean }>(`/api/servers/${encodeURIComponent(name)}`);
  },
  async setServerActive(name: string, active: boolean) {
    return patch<{ name: string; active: boolean }>(
      `/api/servers/${encodeURIComponent(name)}/active`,
      { active }
    );
  },

  // Tools
  async listTools(opts?: { server?: string; search?: string }) {
    const q = new URLSearchParams();
    if (opts?.server) q.set("server", opts.server);
    if (opts?.search) q.set("search", opts.search);
    const qs = q.toString() ? `?${q}` : "";
    return get<{ count: number; tools: ToolInfo[] }>(`/api/tools${qs}`);
  },
  async getToolSchema(toolName: string) {
    return get<{ name: string; description?: string; input_schema?: unknown }>(
      `/api/tools/${encodeURIComponent(toolName)}/schema`
    );
  },
  async callTool(server: string, tool: string, args?: unknown) {
    return post<{ result: unknown; duration_ms: number }>(
      "/api/tools/call",
      { server, tool, args: args ?? {} }
    );
  },

  // OAuth
  async oauthStatus() {
    return get<{ count: number; servers: OAuthStatus[] }>("/api/oauth/status");
  },
  async saveCredentials(params: {
    server_name: string;
    api_key: string;
    header_name?: string;
    header_format?: string;
  }) {
    return post<{ server_name: string; saved: boolean }>("/api/oauth/credentials", params);
  },
  async oauthStart(params: {
    server_name: string;
    mcp_url: string;
    redirect_uri: string;
    client_id?: string;
    client_secret?: string;
  }) {
    return post<{ authorize_url: string; state: string; server_name: string; used_dcr: boolean }>(
      "/api/oauth/start",
      params
    );
  },
  async oauthRevoke(serverName: string) {
    return post<{ server_name: string; revoked: boolean }>("/api/oauth/revoke", { server_name: serverName });
  },
  async oauthSwitchAccount(serverName: string) {
    return post<{ server_name: string; tokens_removed: boolean }>(
      "/api/oauth/switch-account",
      { server_name: serverName }
    );
  },

  // Automations
  async listAutomations() {
    return get<{ count: number; automations: AutomationSummary[] }>("/api/automations");
  },
  async getAutomation(id: number) {
    return get<{ automation: AutomationDetail; runs: AutomationRun[] }>(`/api/automations/${id}`);
  },
  async createAutomation(params: {
    name: string;
    trigger: unknown;
    description?: string;
    actions?: unknown[];
    notify?: unknown;
    interval_minutes?: number;
    enabled?: boolean;
    post_to_chat?: boolean;
  }) {
    return post<{ id: number; name: string }>("/api/automations", params);
  },
  async updateAutomation(id: number, params: Partial<{
    name: string;
    description: string;
    trigger: unknown;
    actions: unknown[];
    notify: unknown;
    interval_minutes: number;
    enabled: boolean;
    post_to_chat: boolean;
  }>) {
    return patch<{ id: number; updated: number }>(`/api/automations/${id}`, params);
  },
  async deleteAutomation(id: number) {
    return del<{ id: number; deleted: boolean }>(`/api/automations/${id}`);
  },
  async triggerAutomation(id: number) {
    return post<{ id: number; queued: boolean; note: string }>(`/api/automations/${id}/run`, {});
  },
  async resetAutomationState(id: number) {
    return post<{ id: number; reset: boolean }>(`/api/automations/${id}/reset-state`, {});
  },

  // Hooks
  async listHooks(event?: string) {
    const qs = event ? `?event=${encodeURIComponent(event)}` : "";
    return get<{ count: number; hooks: HookInfo[] }>(`/api/hooks${qs}`);
  },
  async createHook(params: {
    name: string;
    event_name: string;
    hook_type: string;
    hook_command: string;
    matcher_type?: string;
    matcher_value?: string;
    hook_config?: unknown;
    priority?: number;
  }) {
    return post<{ id: number; name: string }>("/api/hooks", params);
  },
  async deleteHook(id: number) {
    return del<{ id: number; deleted: boolean }>(`/api/hooks/${id}`);
  },
  async toggleHook(id: number, enabled: boolean) {
    return post<{ id: number; enabled: boolean }>(`/api/hooks/${id}/toggle`, { enabled });
  },

  // Schedule
  async listSchedule() {
    return get<{ count: number; tasks: ScheduledTask[] }>("/api/schedule");
  },
  async addScheduleTask(params: {
    name: string;
    schedule: string;
    schedule_type: string;
    payload_type: string;
    payload: string;
    one_shot?: boolean;
    next_run_at?: string;
  }) {
    return post<{ id: number; name: string }>("/api/schedule", params);
  },
  async removeScheduleTask(id: number) {
    return del<{ id: number; deleted: boolean }>(`/api/schedule/${id}`);
  },
};
