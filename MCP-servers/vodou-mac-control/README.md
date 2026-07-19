# vodou-mac-control

macOS computer control for AI agents. Read any app's UI, click buttons, type text, press keys, scroll, take screenshots, manage windows, and read/write the clipboard — all through the MCP protocol.

Every action returns the **full accessibility tree + diff** showing what changed. The AI never acts blind.

## How It Works

```
┌──────────────────────────────────────────────┐
│  Node.js MCP Server (src/index.ts)           │
│  13 tools · blocklist · rate limiting · logs │
├──────────────────────────────────────────────┤
│  vodou-ax (Swift binary, ~464KB)              │
│  AXUIElement · CGEvent · ScreenCaptureKit    │
│  Reads accessibility trees, executes actions │
│  Returns JSON to stdout                      │
└──────────────────────────────────────────────┘
```

The Node.js layer handles the MCP protocol (stdio transport). The Swift binary does the native macOS work — accessibility tree traversal, mouse clicks, keyboard input, window management, screenshots. No external dependencies in either layer.

## 13 Tools

### Core — Action + Traverse

Every mutation tool returns the new UI tree and a diff (added/removed/modified elements).

| Tool | What it does |
|------|-------------|
| `traverse` | Read the accessibility tree for any running app. Returns every button, text field, menu item as structured data. |
| `click_and_traverse` | Click at screen coordinates. Returns new UI tree + diff. |
| `click_element_and_traverse` | Find an element by text (e.g. "Send") and click it. More reliable than coordinates — works when windows move. |
| `type_and_traverse` | Type text into the focused element. Returns new UI tree + diff. |
| `press_key_and_traverse` | Press a key or combo (e.g. Cmd+A). Supports all keys and modifiers. Returns new UI tree + diff. |
| `scroll_and_traverse` | Scroll at a position. Returns new UI tree + diff. |
| `open_and_traverse` | Open or activate an app. Launches it if not running. Returns the UI tree once ready. |

### Utility

| Tool | What it does |
|------|-------------|
| `screenshot` | Capture a window or full screen as PNG. Optional click-point annotation (red crosshair). |
| `clipboard_read` | Read current clipboard contents. |
| `clipboard_write` | Write text to the clipboard. |
| `list_windows` | List all visible windows with app name, title, position, and size. |
| `manage_window` | Focus, resize, move, or minimize a window by app name. |
| `check_permission` | Check if macOS Accessibility permission is granted. |

## The Action + Traverse Pattern

This is the key design decision. When you click something, you don't just get "ok" — you get the entire new UI state plus what changed:

```json
{
  "ok": true,
  "action": "click",
  "app": "Slack",
  "element_count": 1247,
  "diff": {
    "added": [{"id": 848, "role": "AXTextArea", "title": "Message #general"}],
    "removed": [],
    "modified": [{"id": 42, "role": "AXStaticText", "field": "focused", "old": "false", "new": "true"}]
  },
  "tree": [...]
}
```

This means a Vodou skill can:
1. Open an app → get the UI tree
2. Present what's on screen to the user at a stopping point
3. User picks an action → execute it → get the new state
4. Present the result → wait for next decision

The AI always knows what happened. No blind clicking.

## Click by Element (Not Just Coordinates)

Most automation tools make you click at pixel coordinates. Those break when a window moves, resizes, or renders differently on another machine.

`click_element_and_traverse` finds the element by its text content:

```bash
# Instead of: click at (340, 680) and hope "Send" is still there
vodou-core call vodou-mac-control click_element_and_traverse \
  '{"app": "Slack", "element": "Send", "role": "AXButton"}'
```

The Swift binary searches the accessibility tree, finds the element matching "Send" with role AXButton, and clicks the center of its bounding box. Works regardless of window position.

## Safety Features

### App Blocklist

Terminal, iTerm2, System Settings, and Keychain Access are blocked by default. The AI cannot automate these sensitive apps.

Override by creating `blocklist.json` next to the server:
```json
["Terminal", "iTerm2", "System Settings", "Keychain Access", "1Password"]
```

### Input Guard

Mutation tools accept a `guard` parameter (default: true). When enabled:
- All user keyboard and mouse input is blocked during the action
- A message appears: "Vodou is clicking in Slack... Press Esc to cancel"
- 30-second watchdog auto-disengages if the process hangs
- Press Escape to cancel immediately
- Cursor position and frontmost app are restored after the action

This prevents accidental interference while automation is running.

### Rate Limiting

5 mutation actions per second, burst of 10. Read-only tools (traverse, screenshot, clipboard_read, list_windows, check_permission) are unlimited.

### Audit Log

Every action is logged to `/tmp/vodou-mac-control/audit.jsonl`:
```json
{"timestamp":"2026-03-24T19:55:27Z","tool":"traverse","app":"Finder","ok":true,"duration_ms":387}
{"timestamp":"2026-03-24T19:55:45Z","tool":"traverse","app":"Terminal","ok":false,"duration_ms":0,"error":"App 'Terminal' is blocked"}
```

Rotates at 10MB.

## Requirements

- **macOS 13+** (Ventura or later)
- **Accessibility permission** — System Settings > Privacy & Security > Accessibility. Grant access to your terminal app or the process running the MCP server.
- **Screen Recording permission** — only needed for the `screenshot` tool. On macOS Sequoia, CLI binaries (non-.app bundles) won't trigger the permission prompt — you must add vodou-ax manually: System Settings > Privacy & Security > Screen Recording > click + > Cmd+Shift+G > paste the path to `bin/vodou-ax-arm64`. If the file picker won't show it, symlink it to `/Applications/vodou-ax` and select that instead.
- **Node.js 18+** — for the MCP server wrapper
- **Swift 5.9+** — only if building from source (pre-compiled binaries ship in releases)

## Install

### Already connected to Vodou:
```bash
vodou-core connect vodou-mac-control node MCP-servers/vodou-mac-control/dist/index.js
```

### Build from source:
```bash
cd MCP-servers/vodou-mac-control

# Build Swift binary
cd swift && swift build -c release && cd ..

# Install Node.js deps + build TypeScript
npm install && npm run build

# Connect
cd ../.. && vodou-core connect vodou-mac-control node MCP-servers/vodou-mac-control/dist/index.js
```

### Verify:
```bash
vodou-core call vodou-mac-control check_permission '{}'
vodou-core call vodou-mac-control traverse '{"app": "Finder"}'
vodou-core call vodou-mac-control list_windows '{}'
```

## Usage Examples

### Read what's on screen
```bash
vodou-core call vodou-mac-control traverse '{"app": "Safari"}'
# Returns: 800+ UI elements with roles, titles, values, positions
```

### Open an app and see its UI
```bash
vodou-core call vodou-mac-control open_and_traverse '{"app": "Notes"}'
# Launches Notes (or activates it), waits for UI ready, returns tree
```

### Click a button by name
```bash
vodou-core call vodou-mac-control click_element_and_traverse \
  '{"app": "Safari", "element": "Downloads", "role": "AXButton"}'
# Finds "Downloads" button, clicks its center, returns new UI tree + diff
```

### Type text
```bash
vodou-core call vodou-mac-control type_and_traverse \
  '{"app": "TextEdit", "text": "Hello from Vodou"}'
# Types into focused field, returns tree showing the new text
```

### Keyboard shortcut
```bash
vodou-core call vodou-mac-control press_key_and_traverse \
  '{"app": "TextEdit", "key": "a", "modifiers": ["command"]}'
# Cmd+A (select all), returns diff showing selection change
```

### Screenshot
```bash
vodou-core call vodou-mac-control screenshot '{"app": "Slack"}'
# Returns: {"screenshot_path": "/tmp/vodou-ax/screenshots/Slack-1711382133.png", "size_bytes": 245760}
```

### Window management
```bash
vodou-core call vodou-mac-control manage_window \
  '{"app": "Slack", "action": "resize", "width": 1200, "height": 800}'
```

### Through natural language (via Vodou intent routing)
```bash
oi "open TextEdit"
oi "what's on screen in Safari"
oi "screenshot of Slack"
oi "list all windows"
```

## Architecture

```
vodou-mac-control/
├── swift/                          # Native macOS binary
│   ├── Package.swift               # Swift Package (macOS 13+, zero deps)
│   └── Sources/vodou-ax/
│       ├── main.swift              # CLI: traverse, click, type, press-key, scroll, open, screenshot, clipboard, windows
│       ├── Models.swift            # JSON response structs (Codable)
│       ├── AXTraverser.swift       # BFS accessibility tree traversal (max 2000 elements, 5s timeout)
│       ├── AXActions.swift         # Click (CGEvent), type (AppleScript), key press, scroll, element search
│       ├── AXDiff.swift            # Before/after tree comparison (±5pt coordinate matching)
│       ├── AppLauncher.swift       # Open apps via NSWorkspace, wait for AX readiness
│       ├── InputGuard.swift        # CGEventTap input blocking + Escape cancel + 30s watchdog
│       ├── Screenshot.swift        # ScreenCaptureKit + screencapture CLI fallback + crosshair annotation
│       └── WindowManager.swift     # CGWindowList + AXUIElement window control
├── src/                            # MCP server wrapper
│   ├── index.ts                    # 13 tool definitions + request handlers
│   ├── ax-bridge.ts                # Spawns vodou-ax binary, parses JSON
│   ├── types.ts                    # TypeScript interfaces matching Swift models
│   ├── blocklist.ts                # App blocklist (Terminal, System Settings, Keychain)
│   ├── rate-limiter.ts             # Token-bucket: 5 mutations/sec
│   └── audit-log.ts               # JSON lines to /tmp/vodou-mac-control/audit.jsonl
├── bin/                            # Pre-compiled binaries for release
│   ├── vodou-ax-arm64              # Apple Silicon
│   └── vodou-ax-x86_64            # Intel
├── package.json
├── tsconfig.json
├── vodou-manifest.json             # Intent keywords + parameter extractors
└── LICENSE                         # MIT
```

## How It Compares

| Feature | Claude Cowork | mediar-ai/mcp-server-macos-use | **vodou-mac-control** |
|---------|--------------|-------------------------------|----------------------|
| Approach | Screenshots + vision model | Accessibility tree + traverse | **Accessibility tree + traverse** |
| Click by element text | No | Yes | **Yes** |
| Diff tracking | No | Yes | **Yes** |
| Input guard | N/A | Yes | **Yes (+ 30s watchdog)** |
| Screenshot | Built-in (vision) | Via subprocess | **Built-in** |
| Clipboard | No | No | **Yes** |
| Window management | Via screen control | No | **Yes** |
| App blocklist | No | No | **Yes** |
| Rate limiting | No | No | **Yes** |
| Audit logging | No | No | **Yes** |
| Speed | 3-10s/action | ~300ms/action | **~300ms/action** |
| License | Proprietary | BSL 1.1 | **MIT** |

## License

MIT. Vodou-owned. Zero external dependencies with restrictive licenses.
