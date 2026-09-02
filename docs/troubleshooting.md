# Vodou Troubleshooting

Common issues, solutions, and debugging techniques for Vodou.

## First step: run the doctor

Before walking through specific symptoms below, capture a full health report:

```bash
bash scripts/vodou-doctor.sh           # full audit (~30-90s, includes memory + channel live probes)
bash scripts/vodou-doctor.sh --quick   # 2–4 second sanity check (skips slow probes)
```

The doctor runs 12 checks across:

1. **Environment** — OS, bundled Node, sqlite3, perl, optional python3, RAM, disk
2. **Binaries** — vodou-core / vodou-hook-bin / ./do present, executable, version match
3. **Daemon** — socket, lock, listening PID, system.log tail
4. **Databases** — vodou-core.db / memory.db / gateway.db integrity + critical tables
5. **Gateway** — port 8765 listening, /health, /api/system version, /api/tools count, /api/servers
6. **MCP Servers** — registered count + per-server health
7. **Workspace** — MEMORY/USER/IDENTITY/AGENTS/SOUL/TOOLS markdown + memory.toml provider
8. **Hook roundtrip** — `vodou-hook-bin sock prompt` synthetic probe + `context` no-`[missing]` guard
9. **Memory pipeline** — recall mode detection (vector vs FTS-only) + smoke test + gateway extractor cycle log
10. **Channels** — live `auth.test` / `getMe` per active channel
11. **Update API** — reachability of `app.vodou.ai/api/version/check`
12. **IDE hooks** — .claude/settings.json + .cursor/hooks.json wired

**Output:** a timestamped markdown report at `.vodou/doctor/vodou-doctor-YYYY-MM-DDTHH-MM-SSZ.md` with collapsible `<details>` blocks containing raw command output. **Paste this file when reporting an issue.** Almost every diagnostic conversation should start here.

The doctor exits non-zero if anything failed, so it can also be wired into CI / scheduled tasks for regression detection.

### Kernel / runtime health

Before blaming the model or MCP servers, check orchestration health:

- **Web:** Open **`#/system`**. The chat footer **Kernel** badge and (with shell v2) the menubar kernel pill reflect **`runtime.overall`** from **`GET /api/system`** (~25s poll; server-side cache keeps load low).
- **CLI:** `./vodou-core runtime-status --json` or `./do runtime-status`.
- **Reference:** [runtime-observability.md](runtime-observability.md) (binary swap hygiene, **`VODOU_GATEWAY_AUTO_ENSURE`**, **`VODOU_HOOK_SKIP_ENSURE`**).
- **Gateway chat (history vs model, stream mismatches):** [gateway-chat-debugging.md](gateway-chat-debugging.md) — `GET /api/system/diagnostics` **`gateway_debug`**, `turnId` logs, **`VODOU_DEBUG_WS`**, LLM hydrate from `gateway.db`.

### Common doctor signals and what they mean

- **`Recall mode: vector + reranker`** ✅ full pipeline; embeddings + BGE reranker active
- **`Recall mode: FTS-only`** ⚠️ ONNX warmup failed (memory pressure on small VMs?) or `ORT_DYLIB_PATH` not set in `.env`. Recall thresholds relax automatically. Conceptual / paraphrased queries return less context than vector mode but exact-keyword queries still work.
- **`Daemon socket missing`** ❌ daemon crashed during startup. Common cause: zombie process holding port 8766. Fix:
  ```bash
  lsof -ti :8766 | xargs kill -9
  rm -f .vodou/daemon.sock .vodou/daemon.lock
  bash start-vodou-services.sh
  ```
- **`/api/system version=unknown`** ❌ gateway dist is stale (auto-updater is binary-only by default — only binary, hook-bin, and ./do script are swapped). Re-run `./install-prebuilt.sh` or run a component update from System → Updates to refresh `MCP-servers/Vodou-Console/dist/`.
- **`vodou-hook-bin context returns [missing]` for files that exist** ❌ stale `.context_cache` invalidation didn't fire (or hook binary itself is older than v0.5.64). Clear it: `rm -f .vodou/workspace/.context_cache`.
- **Memory recall under threshold** ❌ check daemon socket + extractor.log; the doctor prints whichever recall mode is active, and adjusts thresholds accordingly.

---

## Parameter Generation Issues

### Debugging Parameter Generation

If you're experiencing issues with parameter generation or want to understand how queries are being parsed, use the `--test-params` flag:

```bash
# Test how a query is parsed and parameters are generated
vodou-core brain "cpu" --test-params

# Test complex queries
vodou-core brain "analyze codebase for performance issues" --test-params
```

**What `--test-params` shows:**
- Query analysis and intent mappings found
- Input schema for each tool
- Parameter generation details (rule used, generated parameters, timing)
- Rule details (required fields, field generators)
- Execution preview (what would be executed)
- Direct call syntax for manual testing

**Common Issues:**

#### Parameters Not Generated Correctly
```bash
# 1. Test parameter generation
vodou-core brain "your query" --test-params

# 2. Check if intent mapping exists
vodou-core intent list | grep "your keyword"

# 3. Check tool schema
vodou-core tool-schema <server> <tool>

# 4. Verify rule exists in parameter engine
# Check extractors.toml (project root) or database
```

#### No Intent Found
If you see "No Intent Found" in test mode:
```bash
# 1. List all available intents
vodou-core intent list

# 2. Add intent mapping if needed
vodou-core intent add <keyword> <server> <tool> <priority>

# 3. Test again
vodou-core brain "your query" --test-params
```

#### Rule Not Being Used
If test mode shows "Rule Used: ❌ No (schema fallback)":
- Check that parameter rule exists in `extractors.toml` (project root)
- Verify rule signature matches `server::tool` format
- Check rule is loaded: `vodou-core brain "query" --test-params` shows rule details

#### Missing Required Fields in Rules
If a tool fails with "Required field missing" errors, the parameter rule may be outdated:

```bash
# Check what required fields the rule has
sqlite3 vodou-core.db "SELECT tool_signature, required_fields FROM parameter_rules WHERE tool_signature = 'server::tool';"

# Force regenerate rules for a server
./force-regenerate-rules.sh server-name

# Or manually delete and regenerate
sqlite3 vodou-core.db "DELETE FROM parameter_rules WHERE server_name = 'server-name';"
./vodou-core auto-generate-rules server-name
```

**See also:** Rule regeneration for parameter extractors is documented in **`docs-DEV/custom-parameter-engine.md`** (internal copy; see [INTERNAL-DEVELOPER-DOCS.md](INTERNAL-DEVELOPER-DOCS.md)).

## Web gateway and messaging

| Symptom | What to try |
|--------|----------------|
| **Nothing on :8765** | Confirm **`START_AIGATEWAY=1`**, run **`./start-vodou-services.sh`** (or start the gateway the way your install documents), and ensure **`WEB_PORT`** is not used by another process. |
| **WhatsApp odd / double delivery** | Use **one** standalone WhatsApp listener only; do not run a duplicate process on the same webhook port. See [messaging.md](messaging.md). |
| **A channel-adapter fix doesn't take effect** | The runtime loads the **built** adapters from `MCP-servers/Vodou-channels/packages/<ch>/dist` (via the `~/.vodou/channels` symlinks), **not** `src/channels/*.ts`. Edit the adapter, `npm run build` in that package, then restart the channel. Run **`MCP-servers/Vodou-channels/scripts/check-channel-sync.sh`** (also wired into `start-vodou-services.sh`) — it warns when `src/channels/` is newer than the built `packages/*/dist`, i.e. a fix was written but never shipped. |
| **`CHANNEL_MEDIA_STRICT=1` and attachments fail** | Set **`CHANNEL_MEDIA_ROOTS`** to comma-separated absolute directories that contain your channel download folders (see **`.env.example`**). |
| **Stale tab icon / old UI** | Hard-refresh the browser; favicon and static assets are cached aggressively. |

Gateway-specific behavior (attachments, ports) is summarized for users in **`MCP-servers/Vodou-Console/README.md`** in the repo.

## Quick Diagnostics

### System Health Check
```bash
# 1. Check Vodou is working
vodou-core --help

# 2. Check database exists and is readable
ls -la vodou-core.db
sqlite3 vodou-core.db "SELECT COUNT(*) FROM mcp_servers;"

# 3. Check connected servers
vodou-core list

# 4. Test server connectivity
vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //' | head -1 | xargs vodou-core capabilities

# 5. Test parameter generation (debug mode)
vodou-core brain "cpu" --test-params
```

### Environment Check
```bash
# Check required dependencies
which sqlite3
which cargo
which rustc

# Check file permissions
ls -la vodou-core.db
ls -la ./target/debug/vodou-core

# Check current directory and paths
pwd
echo $PATH
```

---

## Connection Issues

### Server Won't Connect

#### "No such file or directory" Error
```bash
vodou-core connect my-server ./nonexistent-binary
# Error: No such file or directory (os error 2)
```

**Causes & Solutions:**

1. **Binary doesn't exist**
   ```bash
   # Check if file exists
   ls -la ./nonexistent-binary
   
   # Use absolute path
   vodou-core connect my-server /full/path/to/binary
   
   # Or ensure binary is in current directory
   ls -la ./my-server-binary
   chmod +x ./my-server-binary
   vodou-core connect my-server ./my-server-binary
   ```

2. **Binary not executable**
   ```bash
   # Check permissions
   ls -la ./server-binary
   # -rw-r--r-- means not executable
   
   # Fix permissions
   chmod +x ./server-binary
   ```

3. **Wrong path or typo**
   ```bash
   # Double-check spelling and path
   find . -name "*server*" -type f
   
   # Use tab completion if available
   vodou-core connect my-server ./[TAB]
   ```

#### "Permission denied" Error
```bash
vodou-core connect my-server ./server-binary
# Error: Permission denied (os error 13)
```

**Solutions:**
```bash
# Make binary executable
chmod +x ./server-binary

# Check file ownership
ls -la ./server-binary
# If owned by different user:
sudo chown $USER:$USER ./server-binary
chmod +x ./server-binary
```

#### Node.js Module Errors
```bash
vodou-core connect node-server node ./server.js
# Error: Cannot find module 'express'
```

**Solutions:**
```bash
# Install dependencies
cd ./path/to/server/directory
npm install

# Or use package manager
npm install express

# Verify package.json exists
ls -la package.json

# Check node version compatibility
node --version
npm --version
```

#### Python Module Errors  
```bash
vodou-core connect py-server python -m my_mcp.server
# Error: ModuleNotFoundError: No module named 'my_mcp'
```

**Solutions:**
```bash
# Install missing module
pip install my_mcp

# Use virtual environment
source ./venv/bin/activate
pip install my_mcp
vodou-core connect py-server ./venv/bin/python -m my_mcp.server

# Or use direct script path
vodou-core connect py-server python ./scripts/server.py

# Check Python path
python -c "import sys; print(sys.path)"
```

### Server Connects but Doesn't Work

#### Protocol Initialization Failed
```
🔌 Connecting to MCP server: my-server (node)
🤝 Initializing MCP protocol...
❌ Protocol initialization failed: Timeout
```

**Debugging Steps:**
```bash
# 1. Test server manually
node ./server.js
# Should show MCP protocol messages

# 2. Check server logs (varies by server)
node ./server.js 2>&1 | head -20

# 3. Test with simple JSON-RPC
echo '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}' | node ./server.js

# 4. Check server documentation for required initialization
```

#### Server Hangs During Connection
**Symptoms:** Command never returns, no error message

**Solutions:**
```bash
# Use timeout to prevent hanging
timeout 30 vodou-core connect my-server node ./server.js

# Check if server requires specific arguments
# (check server documentation)

# Test server separately
node ./server.js --help

# Check if server is listening on wrong interface
# (some servers need --host 127.0.0.1 or similar)
```

---

## Attached clients (MCP host mode)

The other direction: a client (Cursor, Claude Desktop, your own script) attached **to**
Vodou. Full reference in [mcp-host.md](mcp-host.md).

### The client connects, but memory comes back empty

Tools answer, `tools/list` is correct, nothing errors — and `vc_memory_search` returns
nothing at all. Usually the client is pinned to a vault that does not exist: a typo at
install, or a vault deleted long after. The membership set is empty, so it fails closed.

```bash
vodou-core mcp clients      # a dead pin prints as: demo (missing!)
vodou-core mem vault list   # the vaults you actually have
```

Re-point it:

```bash
vodou-core mcp install cursor --http --vault portable
```

**This is not a leak** — the client reads nothing rather than too much. It is also not the
confinement the row claims, which is why it is now marked rather than printed as if it
were live. `mcp clients --json` carries `vault_exists`; `null` there means *could not
tell*, not *missing*.

### A CLI command printed nothing and exited non-zero

`vodou-core`'s stderr is captured into `.vodou/system.log`. A failure — or any warning a
subcommand writes to stderr — will not appear in your terminal. Read the log rather than
theorising:

```bash
tail -50 .vodou/system.log
```

---

## Remote Server Issues ⭐ **New!**

### Connection Timeout Errors

**Symptoms:**
```
⏰ Connection timeout: Request timed out after 30 seconds
💡 Troubleshooting:
   1. Check if the server URL is correct and reachable
   2. Verify your network connection
   3. The server may be slow to respond - try again
```

**Solutions:**
```bash
# 1. Test server connectivity
curl https://mcp.api.gusto.com/anthropic

# 2. Check network connection
ping mcp.api.gusto.com

# 3. Validate connection with timeout
vodou-core connect <server> --url <url> --validate

# 4. Check if server requires authentication
vodou-core credentials <server> list
```

### Authentication Failures

**Symptoms:**
```
❌ Authentication failed: Authentication required. Status: 401 Unauthorized
💡 Action required:
   1. Check if credentials are configured: vodou-core credentials <server> list
   2. Add credentials: vodou-core credentials <server> add --cred-type api_key <key>
```

**Solutions:**
```bash
# 1. Check if credentials are configured
vodou-core credentials <server> list

# 2. Test credentials
vodou-core credentials <server> test

# 3. Add credentials (from environment variable - recommended)
vodou-core credentials <server> add --cred-type api_key --from-env "API_KEY_VAR" --header "X-API-Key"

# 4. Add to .env file
echo "API_KEY_VAR=your-api-key" >> .env

# 5. Verify environment variable
echo $API_KEY_VAR

# 6. Test connection again
vodou-core connect <server> --url <url> --validate
```

### Invalid Server Response

**Symptoms:**
```
❌ Invalid server response: The server may not be a valid MCP server or may be incompatible
💡 The server may not be a valid MCP server or may be incompatible
   Verify the URL points to a valid MCP server endpoint
```

**Solutions:**
```bash
# 1. Test server manually
curl -X POST https://mcp.api.gusto.com/anthropic \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}'

# 2. Validate server before connecting
vodou-core connect <server> --url <url> --validate

# 3. Check server documentation for correct endpoint
# Some servers may require different paths or headers
```

### Network Connectivity Issues

**Symptoms:**
```
❌ Connection failed: Network error
💡 Troubleshooting:
   1. Verify the server URL is correct: <url>
   2. Check your internet connection
   3. Ensure the server is running and accessible
```

**Solutions:**
```bash
# 1. Test basic connectivity
ping <server-domain>

# 2. Test HTTPS connectivity
curl -I https://<server-domain>

# 3. Check DNS resolution
nslookup <server-domain>

# 4. Check firewall/proxy settings
# Some networks may block external connections

# 5. Try from different network
# Test if issue is network-specific
```

### Credential Not Found Errors

**Symptoms:**
```
⚠️  No credentials found for server
```

**Solutions:**
```bash
# 1. List all credentials
vodou-core credentials <server> list

# 2. Add credentials if missing
vodou-core credentials <server> add --cred-type api_key --from-env "API_KEY_VAR" --header "X-API-Key"

# 3. Check environment variable exists
echo $API_KEY_VAR

# 4. Verify .env file exists and is readable
cat .env | grep API_KEY_VAR
```

### Server Validation Fails

**Symptoms:**
```
❌ Validation failed - cannot connect to server
```

**Solutions:**
```bash
# 1. Check server URL format
# Must start with http:// or https://
vodou-core connect <server> --url https://correct-url.com

# 2. Test server manually
curl https://server-url.com

# 3. Check if server requires authentication
# Some servers require credentials even for validation

# 4. Try connecting without validation first
vodou-core connect <server> --url <url>

# 5. Check server logs (if accessible)
# Server may be down or experiencing issues
```

### Credential Priority Issues

**Understanding Credential Priority:**
1. **Database credentials** (highest - explicit configuration)
2. **Environment variables** (automatic fallback)
3. **CLI flags** (lowest - temporary for testing)

**If credentials aren't working:**
```bash
# 1. Check what credentials are loaded
vodou-core credentials <server> list

# 2. Test credentials
vodou-core credentials <server> test

# 3. Check environment variables
env | grep <SERVER_NAME>_API_KEY

# 4. Verify .env file is loaded
# Vodou automatically loads .env from current directory

# 5. Check credential source
# Database credentials take priority over environment variables
```

## Tool Calling Issues

### Tool Not Found
```bash
vodou-core call my-server unknown-tool
# Error: Tool 'unknown-tool' not found
```

**Solutions:**
```bash
# 1. List available tools
vodou-core tools my-server

# 2. Check exact spelling (case-sensitive)
vodou-core tools my-server | grep -i "tool-name"

# 3. Refresh server capabilities
vodou-core connect my-server node ./server.js
vodou-core tools my-server
```

### Invalid JSON Arguments  
```bash
vodou-core call my-server my-tool '{invalid json'
# Error: Invalid JSON arguments
```

**Solutions:**
```bash
# 1. Validate JSON syntax
echo '{"param": "value"}' | jq empty

# 2. Use proper JSON escaping
vodou-core call my-server my-tool '{"path": "/path/with/quotes"}'

# 3. Use file for complex JSON
cat > params.json << 'EOF'
{
  "complex": {
    "nested": "value"
  }
}
EOF
vodou-core call my-server my-tool "$(cat params.json)"

# 4. Debug JSON step by step
PARAMS='{"test": true}'
echo "$PARAMS" | jq .
vodou-core call my-server my-tool "$PARAMS"
```

### Tool Execution Errors
```bash
vodou-core call weather-server get_weather '{"location": "InvalidPlace"}'
# MCP Error: Invalid location
```

**Solutions:**
```bash
# 1. Check tool documentation
vodou-core tools weather-server | grep -A 10 "get_weather"

# 2. Try with minimal parameters
vodou-core call weather-server get_weather '{}'

# 3. Check tool parameter requirements
# (look for "required" parameters in tool description)

# 4. Test with known-good parameters
vodou-core call weather-server get_weather '{"location": "San Francisco"}'
```

### Server Connection Timeout
```bash
vodou-core call slow-server long-task
# Hangs for long time, then timeout
```

**Solutions:**
```bash
# 1. Use timeout command
timeout 300 vodou-core call slow-server long-task

# 2. Check if server supports progress queries
vodou-core tools slow-server | grep -i "progress\|status"

# 3. Break task into smaller pieces if possible
vodou-core call slow-server small-task '{"batch_size": 10}'
```

---

## Database Issues

### Database File Problems

#### "Database is locked" Error
```bash
vodou-core connect my-server node ./server.js
# Error: database is locked
```

**Solutions:**
```bash
# 1. Check for other vodou-core processes
ps aux | grep vodou-core
kill [PID_IF_FOUND]

# 2. Check database file permissions
ls -la vodou-core.db
chmod 644 vodou-core.db

# 3. Check disk space
df -h .

# 4. Restart and try again
```

#### "Database corruption" Errors
```bash
vodou-core list
# Error: database disk image is malformed
```

**Recovery Steps:**
```bash
# 1. Backup current database
cp vodou-core.db vodou-core.db.backup

# 2. Try to recover
sqlite3 vodou-core.db ".dump" | sqlite3 vodou-core-recovered.db
mv vodou-core.db vodou-core-corrupted.db
mv vodou-core-recovered.db vodou-core.db

# 3. If recovery fails, start fresh (loses all connections)
rm vodou-core.db
vodou-core connect first-server node ./server.js

# 4. Restore from backup if available
cp vodou-core.db.backup vodou-core.db
```

### Schema Issues

#### "No such table" Errors
```bash
vodou-core list
# Error: no such table: mcp_servers
```

**Solutions:**
```bash
# 1. Check database schema
sqlite3 vodou-core.db ".tables"

# 2. Apply migrations if needed
sqlite3 vodou-core.db < migrations/002_add_prompts_resources.sql

# 3. Rebuild from scratch if necessary
rm vodou-core.db
vodou-core connect first-server node ./server.js
```

---

## Performance Issues

### Slow Tool Calls

#### High Connection Overhead
**Symptom:** Every tool call takes 2-5 seconds

**Solutions:**
```bash
# 1. Check server startup time
time node ./server.js < /dev/null

# 2. Use servers that start quickly
# (avoid servers with heavy initialization)

# 3. Consider batch operations if server supports them
vodou-core call server batch-operation '{"items": [....]}'

# 4. Keep long-running servers alive externally
# (start server separately, connect to running instance)
```

#### Database Performance
**Symptom:** `list` and `capabilities` commands slow

**Solutions:**
```bash
# 1. Check database size
ls -lh vodou-core.db

# 2. Check database integrity
sqlite3 vodou-core.db "PRAGMA integrity_check;"

# 3. Vacuum database if needed
sqlite3 vodou-core.db "VACUUM;"

# 4. Consider cleaning old/unused servers
# (manually remove from database if needed)
```

### High Memory Usage

#### Large Tool Results
**Symptom:** System runs out of memory during tool calls

**Solutions:**
```bash
# 1. Stream large results to file
vodou-core call big-data-server export > large-file.json

# 2. Use pagination if server supports it
vodou-core call server get-data '{"limit": 100, "offset": 0}'

# 3. Process results with streaming tools
vodou-core call server get-data | jq -c '.[] | select(.important == true)'
```

### Memory Janitor Issues

#### Janitor never runs
**Symptom:** No `memory-janitor` task in scheduled_tasks; no janitor reports written

**Solutions:**
```bash
# 1. Verify env var is set
grep VODOU_JANITOR_ENABLED .env
# Should output: VODOU_JANITOR_ENABLED=1

# 2. Restart the worker so it picks up the env var
ps aux | grep "vodou-core worker" | grep -v grep | awk '{print $2}' | xargs kill
./vodou-core worker start &

# 3. Verify task got registered
sqlite3 vodou-core.db "SELECT * FROM scheduled_tasks WHERE name = 'memory-janitor';"
# Should show row with id, schedule, payload='mem janitor', enabled=1

# 4. Test manually (bypasses scheduler)
./vodou-core mem janitor
```

#### Janitor stuck in dry-run forever
**Symptom:** All janitor reports show `**Mode:** dry-run` even after many runs

**Solutions:**
```bash
# 1. Check if VODOU_JANITOR_DRY_RUN is forcing it
grep VODOU_JANITOR_DRY_RUN .env
# If set to 1, that's the cause — remove or set to 0

# 2. Inspect state file — must show dry_run_count >= 3 to enter live mode
cat .vodou/.janitor_state

# 3. Force a live run manually (skips dry-run window)
./vodou-core mem janitor --force-live
```

#### Janitor pruned too many chunks
**Symptom:** Live run pruned hundreds of chunks unexpectedly; report shows large `cap_pruned`

**Cause:** `VODOU_MEMORY_CHUNK_CAP` was lowered below the current chunk count. The default is 500K — designed as a runaway-protection ceiling that should almost never fire. If you're seeing prune activity, someone explicitly tightened the cap.

**Solutions:**
```bash
# 1. Check current chunk count
sqlite3 memory.db "SELECT COUNT(*) FROM memory_chunks WHERE archived = 0;"

# 2. Check what your cap is set to
grep VODOU_MEMORY_CHUNK_CAP .env

# 3. Raise the cap back above current count (or restore default 500000)
# Edit .env: VODOU_MEMORY_CHUNK_CAP=500000

# 4. Restart worker (or just wait — manual runs use the new value immediately)

# 5. Restore from backup if data loss is unacceptable
# Janitor does NOT back up before pruning. Use git or sqlite3 .dump for safety nets.
```

#### Janitor lock held / "lock held" error
**Symptom:** `janitor lock held (age Xs, stale at 600s)` when running manually

**Solutions:**
```bash
# 1. Check if a previous run is still in progress
ls -la .vodou/.janitor_lock
# Lock contains the running PID; check if that process exists

# 2. If stale (age > 10 min) the next run will replace it automatically
# Otherwise wait or force-remove
rm .vodou/.janitor_lock
```

#### Duplicate cluster merges all skip with "LLM not configured"
**Symptom:** Janitor reports show `merged=0` even when dup clusters are detected

**Cause:** The extraction provider is set to `heuristic` or no provider is configured.

**Solution:** Set `VODOU_MEMORY_EXTRACTION_PROVIDER=auto` in `.env` so the janitor uses the gateway's active LLM provider for cluster merges. Mechanical work (relative date fixes, prune, stale deletion) still works without an LLM.

---

## Build and Installation Issues

### Cargo Build Problems

#### Compilation Errors
```bash
cargo build
# Error: failed to compile vodou-core
```

**Solutions:**
```bash
# 1. Update Rust toolchain
rustup update

# 2. Clean and rebuild
cargo clean
cargo build

# 3. Check Rust version compatibility
rustc --version
# Should be recent version (1.70+)

# 4. Update dependencies
cargo update
```

#### Missing Dependencies
```bash
cargo build
# Error: could not find system library
```

**Solutions:**
```bash
# On macOS:
brew install sqlite3

# On Ubuntu/Debian:
sudo apt-get install libsqlite3-dev

# On RHEL/CentOS:
sudo yum install sqlite-devel
```

### Runtime Dependencies

#### SQLite Missing
```bash
./target/debug/vodou-core list
# Error: sqlite3: command not found
```

**Solutions:**
```bash
# SQLite is built-in to Vodou, but if there are issues:

# macOS:
brew install sqlite3

# Ubuntu/Debian:
sudo apt-get install sqlite3

# RHEL/CentOS:
sudo yum install sqlite
```

---

## Debugging Techniques

### Verbose Output

#### Enable Debug Logging (if implemented)
```bash
# Set environment variable
RUST_LOG=debug vodou-core connect my-server node ./server.js

# Or use verbose flag (if implemented)
vodou-core --verbose connect my-server node ./server.js
```

#### Manual Server Testing
```bash
# Start server manually and test JSON-RPC
node ./server.js &
SERVER_PID=$!

# Send test request
echo '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}' | nc localhost [port]

# Clean up
kill $SERVER_PID
```

### Database Inspection

#### Check Database Contents
```bash
# List all servers
sqlite3 vodou-core.db "SELECT * FROM mcp_servers;"

# Count capabilities
sqlite3 vodou-core.db "
SELECT 
    s.name, 
    COUNT(DISTINCT t.id) as tools,
    COUNT(DISTINCT p.id) as prompts,
    COUNT(DISTINCT r.id) as resources
FROM mcp_servers s
LEFT JOIN tools t ON s.id = t.server_id
LEFT JOIN prompts p ON s.id = p.server_id  
LEFT JOIN resources r ON s.id = r.server_id
GROUP BY s.id, s.name;
"

# Check for orphaned data
sqlite3 vodou-core.db "SELECT COUNT(*) FROM tools WHERE server_id NOT IN (SELECT id FROM mcp_servers);"
```

#### Database Schema Check
```bash
# Check current schema
sqlite3 vodou-core.db ".schema"

# Check for missing tables
sqlite3 vodou-core.db ".tables" | tr ' ' '\n' | sort
```

### Network and Process Issues

#### Check Process Status
```bash
# Find Vodou processes
ps aux | grep vodou-core

# Find server processes
ps aux | grep -E "node.*server|python.*mcp"

# Check network connections (if servers use network)
netstat -an | grep LISTEN
```

#### File System Issues
```bash
# Check current directory permissions
ls -la .

# Check available disk space
df -h .

# Check file descriptor limits
ulimit -n
```

---

## 🆕 Professional Feature Issues

Inspector and professional development feature troubleshooting.

### MCP Inspector Issues

#### Inspector Won't Launch
```bash
vodou-core inspect my-server
# Error: Inspector failed to start
```

**Solutions:**
```bash
# 1. Check Node.js is installed
node --version
# Should be Node.js 16+ for Inspector compatibility

# 2. Check if Inspector is properly installed
which mcp-inspector
# Or check if Inspector is in local directory
ls -la ./node_modules/.bin/mcp-inspector

# 3. Install Inspector if missing
npm install -g @mcp-inspector/tools
# Or install locally
npm install @mcp-inspector/tools

# 4. Check if server exists in database
vodou-core list | grep my-server

# 5. Try basic status first
vodou-core status my-server
```

#### Inspector UI Doesn't Load
**Symptom:** Inspector starts but browser shows "Cannot connect"

**Solutions:**
```bash
# 1. Check if Inspector process is running
ps aux | grep inspector

# 2. Check if port is available (default 3000)
netstat -an | grep 3000
lsof -i :3000

# 3. Try different port if needed
# (implementation-specific - check Inspector docs)

# 4. Check firewall/security settings
# Ensure localhost connections are allowed

# 5. Try incognito/private browsing mode
# (clears cache issues)
```

### Validation Issues

#### Pre-Connection Validation Fails
```bash
vodou-core validate node ./server.js
# Error: Validation failed - server not responding
```

**Solutions:**
```bash
# 1. Test server manually first
node ./server.js
# Should start without errors

# 2. Check server supports MCP protocol
echo '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}' | node ./server.js

# 3. Try with --detailed flag for more info
vodou-core validate node ./server.js --detailed

# 4. Check server path and permissions
ls -la ./server.js
which node

# 5. Validate with simpler server first
# Test with known-working server to verify validation works
```

#### Validation Passes but Connection Fails
**Symptom:** `validate` succeeds but `connect` fails

**Solutions:**
```bash
# 1. Check if there's a timing issue
# Some servers need warmup time

# 2. Try connecting without --validate flag first
vodou-core connect my-server node ./server.js

# 3. Compare validation and connection commands exactly
# Ensure identical command line arguments

# 4. Check for race conditions
# Server might work individually but fail under load
```

### Testing Issues

#### Comprehensive Tests Fail
```bash
vodou-core test my-server --test-type full
# Error: Multiple test failures detected
```

**Solutions:**
```bash
# 1. Start with basic tests
vodou-core test my-server --test-type basic

# 2. Check server status first
vodou-core status my-server --detailed

# 3. Test individual methods manually
vodou-core debug my-server --method tools/list

# 4. Check server logs during testing
# Run server separately and monitor output

# 5. Try performance tests separately
vodou-core test my-server --test-type performance
```

#### Test Results Inconsistent
**Symptom:** Tests sometimes pass, sometimes fail

**Solutions:**
```bash
# 1. Check for resource contention
# Run tests when system is not under load

# 2. Increase timeout values if possible
# (implementation-specific)

# 3. Check server stability
vodou-core health-check --metrics

# 4. Run tests multiple times to identify patterns
for i in {1..5}; do
    echo "Test run $i:"
    vodou-core test my-server
    sleep 2
done
```

### Performance Analysis Issues

#### Analysis Command Hangs
```bash
vodou-core analyze my-server
# Command never returns
```

**Solutions:**
```bash
# 1. Use timeout to prevent hanging
timeout 120 vodou-core analyze my-server

# 2. Check server response times first
vodou-core status my-server --detailed

# 3. Try basic testing before analysis
vodou-core test my-server --test-type basic

# 4. Check if server has performance issues
vodou-core debug my-server --method tools/list
```

#### Performance Reports Empty or Invalid
```bash
vodou-core analyze my-server --output report.json
# Creates empty or malformed JSON
```

**Solutions:**
```bash
# 1. Check file permissions for output directory
ls -la reports/
mkdir -p reports

# 2. Verify JSON output manually
vodou-core analyze my-server | jq .

# 3. Try without --output flag first
vodou-core analyze my-server

# 4. Check disk space
df -h .

# 5. Validate JSON structure
cat report.json | jq empty
```

### Enhanced Command Flag Issues

#### --detailed Flag Not Working
```bash
vodou-core status my-server --detailed
# Shows same output as without flag
```

**Solutions:**
```bash
# 1. Check flag syntax (after server name)
vodou-core status my-server --detailed

# 2. Verify Inspector integration is working
vodou-core test my-server --test-type basic

# 3. Check if server supports enhanced features
vodou-core capabilities my-server

# 4. Try with different server
vodou-core status other-server --detailed
```

#### --metrics Flag Issues
```bash
vodou-core health-check --metrics
# Error: Metrics collection failed
```

**Solutions:**
```bash
# 1. Try basic health check first
vodou-core health-check

# 2. Check if Inspector is available
vodou-core validate --help | grep -i inspector

# 3. Verify servers are responsive
vodou-core list

# 4. Check system resources
top
# Ensure system isn't overloaded
```

### Debug Command Issues

#### CLI Debugging Fails
```bash
vodou-core debug my-server --method tools/list
# Error: Debug session failed
```

**Solutions:**
```bash
# 1. Check method name exactly
vodou-core tools my-server
# Verify method names available

# 2. Try different method
vodou-core debug my-server --method initialize

# 3. Check server connectivity
vodou-core status my-server

# 4. Use basic Inspector testing first
vodou-core test my-server --test-type basic

# 5. Verify debug syntax
vodou-core debug --help
```

### Integration Issues

#### Inspector and Core Commands Conflict
**Symptom:** Regular commands work but Inspector features fail

**Solutions:**
```bash
# 1. Check if Inspector is properly integrated
# Try pure core commands first
vodou-core list
vodou-core capabilities my-server

# 2. Verify Inspector installation separately
mcp-inspector --version

# 3. Check for version conflicts
node --version
npm list @mcp-inspector/tools

# 4. Try reinstalling Inspector
npm uninstall -g @mcp-inspector/tools
npm install -g @mcp-inspector/tools
```

#### Performance Issues with Enhanced Features
**Symptom:** Commands much slower with --detailed or --metrics

**Solutions:**
```bash
# 1. Use enhanced features selectively
# Only use --detailed for single servers
vodou-core status my-server --detailed

# 2. Check system resources during enhanced operations
top
# Monitor CPU and memory usage

# 3. Try with smaller/simpler servers first
vodou-core status simple-server --detailed

# 4. Consider timeouts for slow operations
timeout 60 vodou-core analyze slow-server
```

---

## 🚀 Enhanced Feature Troubleshooting

### Filesystem Roots Management Issues

#### Roots Command Shows "No allowed directories"
```bash
vodou-core roots my-filesystem-server
# No allowed directories found for server 'my-filesystem-server'
```

**Causes & Solutions:**

1. **Server connected without allowed directories**
   ```bash
   # Check how server was connected
   vodou-core config my-filesystem-server
   
   # Add allowed directories
   vodou-core update-roots my-filesystem-server --add "/tmp" --add "~/dev"
   
   # Verify directories were added
   vodou-core roots my-filesystem-server
   ```

2. **Wrong server name**
   ```bash
   # List all servers to find correct name
   vodou-core list
   
   # Try with correct server name
   vodou-core roots correct-server-name
   ```

3. **Database permissions issue**
   ```bash
   # Check database file permissions
   ls -la vodou-core.db
   
   # Fix permissions if needed
   chmod 644 vodou-core.db
   
   # Test database access
   sqlite3 vodou-core.db "SELECT COUNT(*) FROM server_roots;"
   ```

#### Update-roots Command Fails with Permission Error
```bash
vodou-core update-roots fs-server --add "/restricted"
# Error: Permission denied accessing directory '/restricted'
```

**Solutions:**
```bash
# Check directory exists and is accessible
ls -la /restricted
cd /restricted  # Test access

# Use directory you have permissions for
vodou-core update-roots fs-server --add "/tmp"
vodou-core update-roots fs-server --add "~/Documents"

# For system directories, ensure proper permissions
sudo chown $USER:$USER /path/to/directory
```

#### Clear-roots Safety Prompt Issues
```bash
vodou-core clear-roots important-server
# Hangs at confirmation prompt in scripts
```

**Solutions:**
```bash
# For interactive use - respond to prompt
vodou-core clear-roots server-name
# Type 'y' and press Enter

# For scripted use - not recommended, but:
echo "y" | vodou-core clear-roots server-name

# Better: Remove specific directories instead
vodou-core update-roots server-name --remove "/specific/path"
```

### User Approval System Issues

#### Approvals Command Shows No History
```bash
vodou-core approvals my-server
# No approval history found for server 'my-server'
```

**Causes & Solutions:**

1. **No operations have required approval yet**
   ```bash
   # Check approval policy
   vodou-core approval-policy my-server --status
   
   # If policy is 'auto', no approvals needed
   vodou-core approval-policy my-server strict
   
   # Perform operation that requires approval
   vodou-core call-tool write_file --args '{"path":"test.txt","content":"test"}'
   ```

2. **Database table missing or corrupted**
   ```bash
   # Check if approval tables exist
   sqlite3 vodou-core.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%approval%';"
   
   # Should show: user_approvals, server_auto_approvals
   # If missing, database needs migration to version 4
   ```

#### Auto-approve Rules Not Working
```bash
vodou-core auto-approve fs-server --operations "read_file"
vodou-core call-tool read_file --args '{"path":"test.txt"}'
# Still prompting for approval despite auto-approve rule
```

**Debugging Steps:**
```bash
# Check auto-approval configuration
vodou-core approvals fs-server --configuration

# Verify rule was saved
sqlite3 vodou-core.db "SELECT * FROM server_auto_approvals WHERE server_id = (SELECT id FROM mcp_servers WHERE name='fs-server');"

# Check if conditions are blocking auto-approval
vodou-core auto-approve fs-server --operations "read_file" --conditions '{}'

# Verify operation type matches exactly
vodou-core tools fs-server  # Check exact tool name
```

#### Progress Tracking Not Showing Operations
```bash
vodou-core progress my-server
# No active operations found for server 'my-server'
```

**Troubleshooting:**
```bash
# Check if server supports progress tracking
vodou-core config my-server --detailed

# If server was connected without --progress-tracking, reconnect
vodou-core reconnect my-server
# Or connect with progress tracking enabled
vodou-core connect my-server command args --progress-tracking

# Check database for progress table
sqlite3 vodou-core.db "SELECT COUNT(*) FROM server_progress;"

# Start an operation and immediately check progress
vodou-core call-tool long_running_operation &
vodou-core progress my-server
```

### Bidirectional MCP Communication Issues

#### Server Requests Failing
```bash
# Server logs show: Failed to request roots/list from client
```

**Diagnostic Steps:**
```bash
# Check if server is properly configured for bidirectional communication
vodou-core config server-name --detailed

# Verify notification settings
sqlite3 vodou-core.db "SELECT * FROM server_notifications WHERE server_id = (SELECT id FROM mcp_servers WHERE name='server-name');"

# Test bidirectional connectivity manually
vodou-core reconnect server-name

# Check for permission issues
vodou-core roots server-name  # Should show allowed directories
```

**Solutions:**
```bash
# Enable bidirectional communication during connection
vodou-core connect server-name command args \
  --notification-config "roots/listChanged:true"

# Or update existing server
vodou-core update-config server-name command args
```

#### Notification System Issues
```bash
# Notifications not being received from server
```

**Debugging:**
```bash
# Check notification configuration
sqlite3 vodou-core.db "SELECT * FROM server_notifications WHERE enabled=1;"

# Test notification system
vodou-core update-roots server-name --add "/tmp"  # Should trigger notification

# Check server logs for notification attempts
vodou-core reconnect server-name  # Restart with fresh connection

# Enable all notifications for testing
vodou-core connect server-name command args \
  --notification-config "all:true"
```

### Progress Tracking and Cancellation Issues

#### Cancel Command Fails
```bash
vodou-core cancel my-server --operation op123
# Error: Operation 'op123' not found or not running
```

**Troubleshooting:**
```bash
# List all operations to find correct ID
vodou-core progress my-server --all

# Check if operation already completed
vodou-core progress my-server --operation op123 --detailed

# Try cancelling with correct operation ID
vodou-core progress my-server  # Get current operations
vodou-core cancel my-server --operation [correct-id]
```

#### Progress Command Shows Stale Data
```bash
vodou-core progress my-server
# Shows operations completed hours ago as "running"
```

**Solutions:**
```bash
# Clean up stale progress entries
vodou-core clear-progress my-server

# Restart server to refresh progress state
vodou-core reconnect my-server

# Check database for inconsistent data
sqlite3 vodou-core.db "SELECT * FROM server_progress WHERE status='running' AND updated_at < datetime('now', '-1 hour');"

# Manual cleanup of stale entries (if needed)
sqlite3 vodou-core.db "UPDATE server_progress SET status='failed', message='Connection lost' WHERE status='running' AND updated_at < datetime('now', '-1 hour');"
```

### Enhanced Connect Command Issues

#### New Parameters Not Recognized
```bash
vodou-core connect fs-server npx @modelcontextprotocol/server-filesystem --allowed-dirs ~/dev
# Error: unrecognized option '--allowed-dirs'
```

**Causes & Solutions:**

1. **Using older version of Vodou**
   ```bash
   # Check version
   vodou-core --version
   
   # Build latest version
   cargo build --release
   
   # Use correct binary path
   ./target/release/vodou-core connect fs-server npx @modelcontextprotocol/server-filesystem --allowed-dirs ~/dev
   ```

2. **Parameter format incorrect**
   ```bash
   # Correct format with equals sign
   vodou-core connect fs-server command args --allowed-dirs="~/dev,~/Documents"
   
   # Or space-separated format
   vodou-core connect fs-server command args --allowed-dirs ~/dev ~/Documents
   ```

#### Sampling Configuration Invalid
```bash
vodou-core connect server command --sampling-config "invalid-json"
# Error: Invalid JSON in sampling configuration
```

**Solutions:**
```bash
# Use proper JSON format with escaped quotes
vodou-core connect server command --sampling-config "data:{\"interval\":5000,\"types\":[\"file_changes\"]}"

# Or use single quotes to avoid escaping
vodou-core connect server command --sampling-config 'data:{"interval":5000,"types":["file_changes"]}'

# Validate JSON before using
echo '{"interval":5000,"types":["file_changes"]}' | python -m json.tool
```

### Database Schema Migration Issues

#### Missing New Tables Error
```bash
vodou-core roots my-server
# Error: no such table: server_roots
```

**Solutions:**
```bash
# Check current database schema version
sqlite3 vodou-core.db "SELECT MAX(version) FROM schema_version;"

# If version < 4, database needs migration
# Backup current database first
cp vodou-core.db vodou-core-backup.db

# Run migration (if migration script exists)
# sqlite3 vodou-core.db < migrations/004_enhanced_features.sql

# Or recreate database (WARNING: loses data)
rm vodou-core.db
vodou-core connect test-server echo hello  # Creates new database
vodou-core remove test-server
```

#### Foreign Key Constraint Errors
```bash
vodou-core update-roots my-server --add "/tmp"
# Error: FOREIGN KEY constraint failed
```

**Debugging:**
```bash
# Check if server exists
vodou-core list | grep my-server

# Check server ID in database
sqlite3 vodou-core.db "SELECT id, name FROM mcp_servers WHERE name='my-server';"

# Enable foreign key constraints (might be disabled)
sqlite3 vodou-core.db "PRAGMA foreign_keys = ON;"

# If server missing, reconnect
vodou-core connect my-server command args
```

### Performance Issues with New Features

#### Progress Tracking Slowing System
```bash
# System becomes slow after enabling progress tracking on multiple servers
```

**Optimizations:**
```bash
# Clean up old progress entries regularly
for server in $(vodou-core list | awk '{print $2}'); do
    vodou-core clear-progress $server
done

# Disable progress tracking for servers that don't need it
vodou-core reconnect non-critical-server  # Without --progress-tracking

# Check database size
ls -lh vodou-core.db

# Optimize database
sqlite3 vodou-core.db "VACUUM;"
sqlite3 vodou-core.db "ANALYZE;"
```

#### Approval System Causing Delays
```bash
# Every operation requires manual approval, slowing workflow
```

**Configuration Adjustments:**
```bash
# Use relaxed policy for development
vodou-core approval-policy dev-server relaxed

# Set up comprehensive auto-approval rules
vodou-core auto-approve dev-server \
  --operations "read_file,list_directory,file_exists,get_file_stats"

# Use strict policy only for production servers
vodou-core approval-policy prod-server strict
```

---

## Getting Help

### Information Gathering

Before reporting issues, gather this information:

```bash
# System information
uname -a
rustc --version
cargo --version

# Vodou information
./target/debug/vodou-core --help
ls -la vodou-core.db

# Server information
vodou-core list
vodou-core capabilities [problematic-server-name]

# Error reproduction
vodou-core [failing-command] 2>&1 | tee error.log
```

### Log Collection
```bash
# Capture complete session
script -a vodou-core-session.log
# Run problematic commands
# Type 'exit' to stop recording

# Or redirect all output
{
    echo "=== System Info ==="
    uname -a
    rustc --version
    
    echo "=== Vodou Status ==="
    vodou-core list
    
    echo "=== Error Reproduction ==="
    vodou-core [failing-command]
} 2>&1 | tee debug-info.log
```

### Common Solutions Summary

| Problem | Quick Fix |
|---------|-----------|
| Binary not found | Use absolute path or `chmod +x` |
| Permission denied | `chmod +x binary` |
| Module not found | `npm install` or `pip install` |
| JSON error | Validate with `jq` |
| Database locked | Kill other processes, check permissions |
| Slow performance | Check server startup time, use timeouts |
| Connection hangs | Use `timeout 30`, check server requirements |
| Tool not found | `vodou-core tools server-name` |
| Inspector won't start | Check Node.js version, install Inspector |
| Validation fails | Test server manually, check MCP protocol |
| Tests inconsistent | Check system load, increase timeouts |
| Analysis hangs | Use timeout, check server performance |
| --detailed not working | Verify Inspector integration, try different server |
| Parameter generation issues | `vodou-core brain "query" --test-params` to debug |

---

**Next:** [Architecture](../docs-DEV/architecture.md) (internal doc) — how Vodou works internally