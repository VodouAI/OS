# JetBrains AI integration

JetBrains IDEs (IntelliJ / PyCharm / RustRover / WebStorm / etc.) and the
JetBrains AI Assistant are extended via Kotlin/Java plugins built against
the IntelliJ Platform SDK. Two integration paths:

## Path 1: External tool + keyboard shortcut (works today, manual)

JetBrains supports External Tools that can be bound to keyboard shortcuts:

1. Settings → Tools → External Tools → `+`
2. Name: `Vodou recall`
3. Program: `vodou-hook-bin`
4. Arguments: `sock prompt`
5. Working directory: `$ProjectFileDir$`
6. Settings → Keymap → bind to e.g. `Ctrl+Shift+V`

Now `Ctrl+Shift+V` invokes `vodou-hook-bin sock prompt` from any JetBrains
window. The daemon detects `Surface::JetBrains` from the `/JetBrains/` path
heuristic.

## Path 2: Native JetBrains plugin (future work)

For automatic per-prompt recording (similar to Claude Code's hook), build a
plugin:

```
jetbrains-vodou/                 (new repo or this directory's `jetbrains-vodou/`)
├── build.gradle.kts
├── src/main/
│   ├── kotlin/
│   │   └── com/vodou/intellij/
│   │       └── VodouService.kt  — IntelliJ ProjectActivity + hooks
│   └── resources/
│       └── META-INF/plugin.xml
```

The plugin would hook into JetBrains AI Assistant's chat lifecycle (when the
SDK exposes those hooks — currently limited) and call `vodou-hook-bin sock prompt`
on each user message.

Estimated cost: 2-3 days (Kotlin + IntelliJ Platform SDK ramp + plugin
distribution). Out of scope for the host-adapter unification plan.

## Verify Path 1 is working

```bash
# After binding the External Tool and triggering it once:
sqlite3 /path/to/vodou/MCP-servers/Vodou-Console/gateway.db \
  "SELECT id, conversation_id, substr(content,1,40) FROM gateway_messages \
   WHERE conversation_id = 'workbench:surface:jetbrains' \
   ORDER BY id DESC LIMIT 5;"

./vodou-core hosts --host=jetbrains-ai
```

## Source

- IntelliJ Platform SDK: https://plugins.jetbrains.com/docs/intellij/welcome.html
- JetBrains AI Assistant SDK: https://plugins.jetbrains.com/docs/intellij/ai-assistant.html
