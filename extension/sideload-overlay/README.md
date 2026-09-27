# Sideload overlay

`extension/vodou-bridge/` and `extension/sideload-only-vodou-bridge/` are
**generated**. Do not edit their code; edit the Store build
(`extension/Store-vodou-bridge/`) or this folder, then run:

```sh
python3 scripts/build-sideload-bridge.py          # regenerate both
python3 scripts/build-sideload-bridge.py --check  # exit 1 if either is stale
```

Commit both regenerated folders with the change that caused them.

## What the full build adds to the Store build

| Where | What | Source |
|---|---|---|
| `manifest.json` | `<all_urls>` in place of the 35 chat hosts; `version_name` names the build | generator |
| `background.js` | channel `full`; no host allowlist; `extract`, `act_in_tab`, `cache_get`/`cache_set`, `open_url`; `gmail.unread` and `chatgpt_conversation` extractors | `background.full.js` + generator |
| `inject.js` | network body-rewrite block in place of the `maybeInjectArgs` stub | `inject.network-rewrite.js` |
| `sites.js`, `content.js` | ChatGPT's Ctrl+B arms that block (invisible attach on send), not a composer insert | generator |

Everything else is the Store build, byte for byte. Each sideload folder keeps
its own `README.md` and `test/`.

Every patch in the generator must match its anchor **exactly once**. If the
Store build moves an anchor, the generator stops with the file and anchor
rather than silently skipping the patch. Update the anchor there.
