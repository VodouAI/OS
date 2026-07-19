# Vodou-Session-Manager

MCP server for managing long-running MCP server sessions (e.g., Playwright browser automation).

## Features

- ✅ Session lifecycle management (create, use, reuse, cleanup)
- ✅ Automatic session reuse
- ✅ Idle session cleanup
- ✅ Process management
- ✅ Database-backed session tracking
- ✅ Analytics/debugging support

## Usage

```bash
# Create session
oi "open browser"

# Use session (automatic)
oi "navigate to github.com"
oi "click login button"
oi "take screenshot"

# Session auto-closes after 1 hour of inactivity
```

## Architecture

Similar to `Vodou-script-executor`, but for MCP server sessions instead of scripts.

## Development

```bash
npm install
npm run build
npm start
```

## Database

Uses `vodou-core.db` with tables:
- `mcp_sessions` - Active sessions
- `mcp_session_calls` - Call history/analytics

## Installation

1. Install dependencies: `npm install`
2. Build: `npm run build`
3. Run migration: `cd migrations && chmod +x run-migration.sh && ./run-migration.sh`
4. Connect to Vodou: `./vodou-core connect Vodou-session-manager node -- "$(pwd)/MCP-servers/Vodou-session-manager/dist/index.js"`
5. Add intent mappings: `sqlite3 vodou-core.db < migrations/intent-mappings.sql`

