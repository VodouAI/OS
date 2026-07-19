/**
 * Typed HTTP client for vodou-core (127.0.0.1:8766).
 * Reads the per-install shared secret from .vodou/console.token.
 * All methods throw on HTTP or API errors.
 */
import * as fs from "fs";
import * as path from "path";
const CORE_API_PORT = 8766;
const BASE_URL = `http://127.0.0.1:${CORE_API_PORT}`;
// ── Internal helpers ───────────────────────────────────────
function readToken() {
    const projectRoot = process.env.VODOU_PROJECT_ROOT ?? process.cwd();
    const tokenPath = path.join(projectRoot, ".vodou", "console.token");
    try {
        const t = fs.readFileSync(tokenPath, "utf8").trim();
        if (t)
            return t;
    }
    catch {
        // fall through
    }
    throw new Error(`[vodou-core] console.token not found at ${tokenPath} — start the vodou daemon first`);
}
function authHeaders() {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${readToken()}`,
    };
}
async function post(endpoint, body) {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`[vodou-core] POST ${endpoint} → ${res.status}: ${text}`);
    }
    const json = (await res.json());
    if (!json.ok)
        throw new Error(`[vodou-core] POST ${endpoint}: ${json.error}`);
    return json.data;
}
async function get(endpoint) {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
        headers: authHeaders(),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`[vodou-core] GET ${endpoint} → ${res.status}: ${text}`);
    }
    const json = (await res.json());
    if (!json.ok)
        throw new Error(`[vodou-core] GET ${endpoint}: ${json.error}`);
    return json.data;
}
async function del(endpoint) {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: "DELETE",
        headers: authHeaders(),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`[vodou-core] DELETE ${endpoint} → ${res.status}: ${text}`);
    }
    const json = (await res.json());
    if (!json.ok)
        throw new Error(`[vodou-core] DELETE ${endpoint}: ${json.error}`);
    return json.data;
}
async function patch(endpoint, body) {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`[vodou-core] PATCH ${endpoint} → ${res.status}: ${text}`);
    }
    const json = (await res.json());
    if (!json.ok)
        throw new Error(`[vodou-core] PATCH ${endpoint}: ${json.error}`);
    return json.data;
}
// ── Public API ─────────────────────────────────────────────
export const VodouCore = {
    // Health
    async health() {
        const res = await fetch(`${BASE_URL}/health`, { headers: authHeaders() });
        if (!res.ok)
            throw new Error(`[vodou-core] health → ${res.status}`);
        return res.json();
    },
    // Memory
    async memorySearch(query, topK = 10, scope) {
        return post("/api/memory/search", { query, top_k: topK, scope });
    },
    // Intents
    async analyzeIntent(query) {
        return post("/api/intents/analyze", { query });
    },
    // Brain
    async brainExecute(query, clean = false) {
        return post("/api/brain/execute", { query, clean });
    },
    // Servers
    async listServers() {
        return get("/api/servers");
    },
    async registerServer(params) {
        return post("/api/servers", params);
    },
    async removeServer(name) {
        return del(`/api/servers/${encodeURIComponent(name)}`);
    },
    async setServerActive(name, active) {
        return patch(`/api/servers/${encodeURIComponent(name)}/active`, { active });
    },
    // Tools
    async listTools(opts) {
        const q = new URLSearchParams();
        if (opts?.server)
            q.set("server", opts.server);
        if (opts?.search)
            q.set("search", opts.search);
        const qs = q.toString() ? `?${q}` : "";
        return get(`/api/tools${qs}`);
    },
    async getToolSchema(toolName) {
        return get(`/api/tools/${encodeURIComponent(toolName)}/schema`);
    },
    async callTool(server, tool, args) {
        return post("/api/tools/call", { server, tool, args: args ?? {} });
    },
    // OAuth
    async oauthStatus() {
        return get("/api/oauth/status");
    },
    async saveCredentials(params) {
        return post("/api/oauth/credentials", params);
    },
    async oauthStart(params) {
        return post("/api/oauth/start", params);
    },
    async oauthRevoke(serverName) {
        return post("/api/oauth/revoke", { server_name: serverName });
    },
    async oauthSwitchAccount(serverName) {
        return post("/api/oauth/switch-account", { server_name: serverName });
    },
    // Automations
    async listAutomations() {
        return get("/api/automations");
    },
    async getAutomation(id) {
        return get(`/api/automations/${id}`);
    },
    async createAutomation(params) {
        return post("/api/automations", params);
    },
    async updateAutomation(id, params) {
        return patch(`/api/automations/${id}`, params);
    },
    async deleteAutomation(id) {
        return del(`/api/automations/${id}`);
    },
    async triggerAutomation(id) {
        return post(`/api/automations/${id}/run`, {});
    },
    async resetAutomationState(id) {
        return post(`/api/automations/${id}/reset-state`, {});
    },
    // Hooks
    async listHooks(event) {
        const qs = event ? `?event=${encodeURIComponent(event)}` : "";
        return get(`/api/hooks${qs}`);
    },
    async createHook(params) {
        return post("/api/hooks", params);
    },
    async deleteHook(id) {
        return del(`/api/hooks/${id}`);
    },
    async toggleHook(id, enabled) {
        return post(`/api/hooks/${id}/toggle`, { enabled });
    },
    // Schedule
    async listSchedule() {
        return get("/api/schedule");
    },
    async addScheduleTask(params) {
        return post("/api/schedule", params);
    },
    async removeScheduleTask(id) {
        return del(`/api/schedule/${id}`);
    },
};
