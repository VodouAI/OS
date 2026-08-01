# Vodou Bridge — Chrome Web Store edition

CWS-safe cut of the memory companion. Lives at `extension/Store-vodou-bridge/`.

**Full / sideload (lenses + `act_in_tab`):** `extension/vodou-bridge/`  
**Packaged with:** `scripts/pack-vodou-bridge-store.sh` (zips this folder's contents, hard-fails on `<all_urls>`, a nested manifest, or remote-code patterns).

## What this build does

- Capture conversations from listed AI chat sites → local Vodou (localhost WS)
- Insert / auto-inject memories into those chats
- Pairing with the gateway Sources pair code
- Host-scoped `cookies_fetch` + packaged `extract_builtin` for ChatGPT/Claude import

## What this build does **not** do

- **No** `act_in_tab` / gateway-supplied script execution (CWS remote-logic policy)
- **No** freeform `extract` / arbitrary-URL session proxy
- **No** `<all_urls>` — hosts are the AI list + localhost only
- GitHub PR Approve / Request-changes and other lens actions that need the full bridge → use sideload `extension/vodou-bridge`

## Install (dev / review)

1. Open `chrome://extensions`
2. Developer mode → **Load unpacked**
3. Select this folder: `extension/Store-vodou-bridge/`
4. Run Vodou locally; click the toolbar icon to open the panel (pair under Settings if asked)

## Pack for CWS upload

```bash
./scripts/pack-vodou-bridge-store.sh
# → dist/vodou-bridge-<version>-store.zip
```

## Protocol note

`bridge_ready` includes `channel: "store"` and `store_build: true` so the gateway can distinguish this from the full sideload bridge.
