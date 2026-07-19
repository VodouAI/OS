# Open Interpreter integration

OI has `--custom_instructions` / `--instructions` flags that inject text into
the system message, but no native pre-prompt hook for per-turn recording.
This integration uses a wrapper script.

## Install

```bash
alias interpreter='/path/to/vodou/integrations/open-interpreter/oi-with-vodou.sh'
# or:
cp /path/to/vodou/integrations/open-interpreter/oi-with-vodou.sh ~/bin/oi-vodou
chmod +x ~/bin/oi-vodou
```

## How it works

The wrapper:
1. Calls `vodou-hook-bin context` for workspace bootstrap
2. Passes the bootstrap as `--custom_instructions` to OI
3. After OI exits, triggers `vodou-hook-bin sock flush` to capture the session

Per-turn recording happens via OI's session storage (`~/.config/open-interpreter/`
or `~/.openinterpreter/`), which the daemon detects as `Surface::OpenInterpreter`.

## Future work

OI's Python API is hookable in code (`interpreter.chat(message)` is a Python
call that could be wrapped). A Python module `vodou_oi.py` could subclass
the `OpenInterpreter` class and inject `record_turn` calls per chat. Out of
scope for this integration; documented as a future enhancement.

## Source

- OI custom instructions: https://docs.openinterpreter.com/settings/all-settings
- OI GitHub: https://github.com/openinterpreter/open-interpreter
