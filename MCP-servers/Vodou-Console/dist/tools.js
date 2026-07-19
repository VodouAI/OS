/**
 * Vodou Tool Definitions for Claude - Simplified Single Generic Tool
 *
 * Instead of defining dozens of tools for Claude, we define ONE generic tool
 * that lets Claude call ANY vodou-core MCP tool directly.
 *
 * Version: 0.5.33.6 - Direct vodou-core Integration
 */
import { modelCapabilities } from './model-capabilities.js';
export const VODOU_TOOLS = [
    {
        name: "vodou_core_call",
        description: `Call any Vodou/vodou-core MCP tool directly.

Available servers and tools (examples):
- mcp-monitor: get_cpu_usage, get_memory_usage, get_disk_usage, get_top_processes
- Vodou-Enhanced-Thinking: start_thinking_session, get_session_state
- chrome-devtools: take_screenshot, navigate_page, take_snapshot, list_console_messages
- vodou-core: vc_load_skill, vc_list_servers

Use this tool to execute system monitoring, deep thinking, memory operations, etc.
Pass server name, tool name, and optional arguments.`,
        input_schema: {
            type: "object",
            properties: {
                server: {
                    type: "string",
                    description: "MCP server name (e.g., 'mcp-monitor', 'Vodou-Enhanced-Thinking')"
                },
                tool: {
                    type: "string",
                    description: "Tool name (e.g., 'get_cpu_usage', 'start_thinking_session')"
                },
                args: {
                    type: "object",
                    description: "Tool arguments as JSON object (optional)"
                }
            },
            required: ["server", "tool"]
        }
    },
    // ── Board tools — available to gateway-dispatched board workers ──────────
    // These call `vodou-core board <subcmd>` natively (not via MCP routing)
    // so they work regardless of whether the Vodou-Board MCP server is built.
    {
        name: "board_show",
        description: "Show a board task's full details: title, body, status, prior run history, and worker context. Call this first when starting a board task.",
        input_schema: {
            type: "object",
            properties: {
                task_id: { type: "string", description: "Task ID (e.g. t_abc123)" }
            },
            required: ["task_id"]
        }
    },
    {
        name: "board_complete",
        description: "Mark a board task as completed. Call when the work is done.",
        input_schema: {
            type: "object",
            properties: {
                task_id: { type: "string", description: "Task ID" },
                summary: { type: "string", description: "What was accomplished (max 4KB). One paragraph: what you produced, key findings, what the next consumer needs." }
            },
            required: ["task_id", "summary"]
        }
    },
    {
        name: "board_block",
        description: "Block a board task when stuck or needing human input. Be specific about the reason.",
        input_schema: {
            type: "object",
            properties: {
                task_id: { type: "string", description: "Task ID" },
                reason: { type: "string", description: "Specific reason (e.g. 'Need decision on geo scope', not 'stuck')" }
            },
            required: ["task_id", "reason"]
        }
    },
    {
        name: "board_heartbeat",
        description: "Signal liveness during long-running board task work. Call every few minutes to prevent reclaim.",
        input_schema: {
            type: "object",
            properties: {
                task_id: { type: "string", description: "Task ID" },
                note: { type: "string", description: "Optional progress note" }
            },
            required: ["task_id"]
        }
    },
    // ─────────────────────────────────────────────────────────────────────────
    {
        name: "list_available_tools",
        description: "List MCP servers and tools from the local vodou-core.db cache (instant). Use to discover capabilities without connecting to remotes. Refresh **Capabilities → MCP Servers** if the list looks stale — do not shell out to `./vodou-core tools` / `all-tools` mid-turn.",
        input_schema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "describe_tool",
        description: "Show ONE tool's full definition — description + typed input schema (JSON Schema) — from the local catalog. Call this BEFORE vodou_core_call when you're unsure of a tool's arguments, so you pass correct args instead of guessing. Discover names first with list_available_tools or search_tools. Read-only, instant (no remote round-trip).",
        input_schema: {
            type: "object",
            properties: {
                server: { type: "string", description: "MCP server name (e.g. 'gmail', 'monday')" },
                tool: { type: "string", description: "Tool name on that server (e.g. 'send_email')" }
            },
            required: ["server", "tool"]
        }
    },
    {
        name: "search_tools",
        description: "Find tools by MEANING across all connected servers — semantic search, so a paraphrase works even with no keyword overlap (e.g. \"cancel newsletters I never read\" finds Gmail tools). Returns the best-matching server::tool names + descriptions. Use this when you know WHAT you want to do but not which tool does it; then describe_tool the chosen one for its arguments. Read-only.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Natural-language description of the task you want a tool for" }
            },
            required: ["query"]
        }
    },
    // WS4 (PLAN-GATEWAY-STATE-LAYER): retrieve the rest of a tool result that was
    // truncated/parked out-of-band. When a tool result ends with "...call expand_result
    // with id=..." the full output was NOT discarded — it's stashed so it isn't re-sent
    // every step. Call this with that id to read more.
    {
        name: "expand_result",
        description: "Retrieve more of a tool result that was truncated and parked out-of-band (you'll see a note like 'call expand_result with id=\"...\"'). Returns a bounded window; pass `offset` to continue reading (the response includes `next_offset`), or `query` to return only matching lines. Use this instead of re-running the original tool.",
        input_schema: {
            type: "object",
            properties: {
                id: { type: "string", description: "The parked-result id from the truncation note." },
                offset: { type: "number", description: "0-based character offset to start from (use the `next_offset` from a prior call to paginate)." },
                query: { type: "string", description: "If set, return only lines containing this substring (case-insensitive) instead of a window." }
            },
            required: ["id"]
        }
    }
];
// ── FS tools (managed/API web-chat) — PLAN 0.6.4 §4.1 ────────────────────────
// Kept as a SEPARATE constant (NOT in VODOU_TOOLS) so flag-off is provably
// byte-identical on every tool surface (§4.3). Exposed only via getActiveTools()
// behind VODOU_FS_TOOLS_ENABLED + a web-chat source gate. `path` (not file_path)
// is the param name so detectFileChanges() auto-tracks write_file/edit_file.
// NOTE: `bash` is intentionally absent — it ships later behind VODOU_FS_BASH_ENABLED
// + an OS sandbox + an approval gate (§6); do NOT add it here.
export const FS_TOOLS = [
    {
        name: "write_file",
        description: "Create or write a text file in your per-conversation workspace. Use a relative path (e.g. \"website/index.html\"); parent folders are created automatically. mode: \"create\" (default, fails if the file exists), \"overwrite\", or \"append\". Confined to the workspace — paths outside it are refused.",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Relative path within the workspace (e.g. \"src/app.ts\")" },
                content: { type: "string", description: "Full file contents to write" },
                mode: { type: "string", enum: ["create", "overwrite", "append"], description: "create (default) | overwrite | append" }
            },
            required: ["path", "content"]
        }
    },
    {
        name: "read_file",
        description: "Read a text file from your per-conversation workspace. Returns line-numbered content (\"<num>\\t<text>\"). For a LARGE file, read a WINDOW with offset (1-based start line) + limit (line count) instead of the whole file — the result's truncated/endLine/totalLines tell you how to page (next call: offset = endLine + 1). When copying text into edit_file, drop the leading \"<num>\\t\" gutter (it's stripped automatically if you don't). Confined to the workspace.",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Relative path within the workspace" },
                offset: { type: "number", description: "1-based first line to return (default 1)" },
                limit: { type: "number", description: "Max lines to return (default 2000)" },
                max_bytes: { type: "number", description: "Optional cap on bytes read from disk" }
            },
            required: ["path"]
        }
    },
    {
        name: "list_dir",
        description: "List files and folders in your per-conversation workspace. Use for orientation before reading or editing. Confined to the workspace.",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Relative directory path within the workspace (default \".\")" }
            }
        }
    },
    {
        name: "edit_file",
        description: "Edit an existing file by string replacement. old_string should match the file (whitespace/indentation differences are tolerated); it must identify a UNIQUE location unless replace_all is true. Fails (no write) if old_string is not found or is ambiguous — include surrounding context to make it unique.",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Relative path within the workspace" },
                old_string: { type: "string", description: "Text to replace (must be unique unless replace_all)" },
                new_string: { type: "string", description: "Replacement text (literal — no $-expansion)" },
                replace_all: { type: "boolean", description: "Replace every occurrence (default false)" }
            },
            required: ["path", "old_string", "new_string"]
        }
    },
    {
        name: "multi_edit",
        description: "Apply several edits to ONE file atomically. All edits are matched against the original file and applied together (all-or-nothing) — order doesn't matter, and if any edit fails to match or two edits overlap, NOTHING is written. Prefer this over multiple edit_file calls when changing a file in several places.",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Relative path within the workspace" },
                edits: {
                    type: "array",
                    description: "Edits to apply, each like edit_file. Matched against the original file; must not overlap.",
                    items: {
                        type: "object",
                        properties: {
                            old_string: { type: "string", description: "Text to replace (unique unless replace_all)" },
                            new_string: { type: "string", description: "Replacement text (literal)" },
                            replace_all: { type: "boolean", description: "Replace every occurrence (default false)" }
                        },
                        required: ["old_string", "new_string"]
                    }
                }
            },
            required: ["path", "edits"]
        }
    },
    {
        name: "search_files",
        description: "Search your workspace for text and get back the FILES that match (path + first matching line + line number) — not their full content. Use this to LOCATE code/strings across many files cheaply, then read_file the window you want. Skips hidden/binary/huge files. Returns up to 100 files; truncated=true means narrow the query.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Text to find (case-insensitive substring; or a regex when regex=true)" },
                path: { type: "string", description: "Relative subdirectory to search under (default whole workspace)" },
                regex: { type: "boolean", description: "Treat query as a JS regex (case-insensitive). Default false (substring)." },
                max_results: { type: "number", description: "Max matching files to return (default/cap 100)" }
            },
            required: ["query"]
        }
    },
    {
        name: "grep",
        description: "Search your workspace and get back EVERY matching line (path + line number + text), optionally with surrounding context lines — unlike search_files which returns one line per file. Use grep to INSPECT all occurrences of something (e.g. every call site of a function) before editing. Optionally filter the files searched with a `glob`. Skips hidden/binary/huge files.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Text to find (case-insensitive substring; or a regex when regex=true)" },
                path: { type: "string", description: "Relative subdirectory to search under (default whole workspace)" },
                regex: { type: "boolean", description: "Treat query as a JS regex (case-insensitive). Default false (substring)." },
                glob: { type: "string", description: "Only search files whose path matches this glob (e.g. \"**/*.ts\")" },
                context: { type: "number", description: "Lines of context to include before & after each match (0–10, default 0)" },
                max_results: { type: "number", description: "Max matching lines to return total (default/cap 200)" },
                max_per_file: { type: "number", description: "Max matching lines per file (default/cap 20)" }
            },
            required: ["query"]
        }
    },
    {
        name: "glob",
        description: "Find files by NAME/PATH pattern — e.g. \"**/*.test.ts\", \"src/**/index.*\". `**` matches across directories; `*`/`?` do not cross \"/\". Returns matching file paths (with size + mtime), newest-pattern-match first. Use to locate files when you know the name shape but not the location; read_file them after. Reads no file contents — cheap.",
        input_schema: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "Glob pattern matched against the path relative to `path` (e.g. \"**/*.ts\")" },
                path: { type: "string", description: "Relative subdirectory to search under (default whole workspace)" },
                max_results: { type: "number", description: "Max files to return (default/cap 500)" }
            },
            required: ["pattern"]
        }
    },
    {
        name: "file_stat",
        description: "Get metadata for one path WITHOUT reading its contents: whether it exists, type (file/dir/symlink), size in bytes, last-modified time, and line count for a text file. Use to check existence/size before a read or write. Confined to the workspace.",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Relative path within the workspace" }
            },
            required: ["path"]
        }
    },
    {
        name: "directory_tree",
        description: "Show the nested folder/file structure under a directory to a given depth — for orienting yourself in an unfamiliar workspace before reading files. Returns entries with their path, type, and depth. Confined to the workspace; skips hidden/dependency dirs.",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Relative directory to start from (default workspace root)" },
                depth: { type: "number", description: "How many levels deep to descend (1–10, default 3)" },
                max_entries: { type: "number", description: "Max entries to return (default/cap 500)" }
            }
        }
    }
];
/** True when the FS-tools feature flag is enabled (read at call time, not module load). */
export function fsToolsFlagOn() {
    const v = process.env.VODOU_FS_TOOLS_ENABLED;
    return v === '1' || v === 'true';
}
/**
 * Web-chat source predicate — mirrors index.ts:966 (`!c.source || c.source==='web'`).
 * A web/global chat row's `source` is `'web'` OR null; every unattended surface
 * (channels, scheduler/heartbeat, board) sets a NON-web source before chat(), so
 * this excludes all of them. Gating on `=== 'web'` alone would wrongly drop
 * null-source web chats (§4.3).
 */
export function isWebChatSource(source) {
    return !source || source === 'web';
}
/**
 * Conversation-id prefixes that are NOT the main interactive web chat and must NOT
 * get FS tools even with a web source (§10.2 #3). `workbench:*` covers the
 * skill-console panel AND scheduled `/chat/skill-fire` runs (both are workbench:skill:*
 * with a default 'web' source) plus integration workbenches. Phase 1 scopes FS tools
 * to the MAIN web chat only; skill-console can be allowlisted later if wanted.
 */
const NON_INTERACTIVE_CONV_PREFIXES = ['workbench:'];
export function isInteractiveWebConvId(conversationId) {
    if (!conversationId)
        return true; // main web chat may omit it; the source+flag gate still applies
    return !NON_INTERACTIVE_CONV_PREFIXES.some((p) => conversationId.startsWith(p));
}
/**
 * Should FS tools be active for this conversation? Flag ON, a web-chat source, AND
 * the MAIN interactive web chat (not a workbench/skill-fire conversation).
 */
export function fsToolsActive(source, conversationId) {
    return fsToolsFlagOn() && isWebChatSource(source) && isInteractiveWebConvId(conversationId);
}
/**
 * The active raw Anthropic Tool[] for a conversation, with the FS gate applied.
 * Flag-off (or non-web source) returns VODOU_TOOLS unchanged — byte-identical.
 * #8 §1.3: when `model` is a 'whole-file' model (VODOU_WHOLE_FILE_MODELS), the
 * targeted-edit tools (edit_file/multi_edit) are withheld — it rewrites via write_file.
 */
export function getActiveTools(opts) {
    if (!fsToolsActive(opts?.source, opts?.conversationId))
        return VODOU_TOOLS;
    const fs = modelCapabilities(opts?.model).editFormat === 'whole-file'
        ? FS_TOOLS.filter((t) => t.name !== 'edit_file' && t.name !== 'multi_edit')
        : FS_TOOLS;
    return [...VODOU_TOOLS, ...fs];
}
/** Anthropic-SDK tool surface (raw Tool[]). Single gate home for the SDK paths. */
export function getAnthropicTools(opts) {
    return getActiveTools(opts);
}
/**
 * Get tool by name (searches FS tools too, so name-based lookups resolve when the
 * feature is enabled — the executor still hard-gates execution via the sandbox).
 */
export function getTool(name) {
    return VODOU_TOOLS.find(tool => tool.name === name) || FS_TOOLS.find(tool => tool.name === name);
}
/**
 * Get all tool names. Always the base set — FS tools are per-conversation and
 * gated, NOT a global capability, so they are not advertised in global listings
 * like /health (adversarial-review finding #4). Use getActiveTools({source}) for
 * the per-turn surface. getTool() still resolves FS tools by name.
 */
export function getToolNames() {
    return VODOU_TOOLS.map(tool => tool.name);
}
/**
 * OpenAI-compatible tool format (used by OpenAI, Gemini, Groq, Ollama, etc.).
 * Gated identically to the Anthropic path via getActiveTools(); no-arg / flag-off
 * is byte-identical to the original 6-tool set.
 */
export function getOpenAITools(opts) {
    return getActiveTools(opts).map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description || '',
            parameters: t.input_schema,
        },
    }));
}
/** Detect menu/stopping-point replies — these should skip tool calling and stay in active skill.
 *  Matches: "1", "1. Quick Start", "3) Option", "2: something", "yes", "no", "all", "y", "n" */
export function isMenuReply(message) {
    return /^\d{1,2}[\.\)\s:]|^\d{1,2}$|^(all|yes|no|y|n)\s*[!?.]*$/i.test(message.trim());
}
