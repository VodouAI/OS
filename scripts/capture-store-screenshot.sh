#!/usr/bin/env bash
# Capture a Chrome Web Store screenshot at exactly 1280x800.
#
# Usage:
#   ./scripts/capture-store-screenshot.sh 01-hero-remembers
#   ./scripts/capture-store-screenshot.sh 02-save-chat --delay 8
#   ./scripts/capture-store-screenshot.sh 03-pick --region 100,100,1280,800
#
# Why this exists rather than just using Cmd-Shift-4:
#   * CWS accepts ONLY 1280x800 or 640x400. Anything else is rejected at upload.
#   * On a Retina display `screencapture -R 0,0,1280,800` writes a 2560x1600 file —
#     the right framing at the wrong pixel size. This downsamples it back to 1280x800,
#     which also makes text *sharper* than capturing 1280x800 natively on a 1x display.
#   * It fails loudly if the result isn't exactly 1280x800, so a bad asset can't reach
#     the dashboard.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/extension/Store-vodou-bridge/store-assets"
TARGET_W=1280
TARGET_H=800

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "usage: $0 <name-without-extension> [--delay N] [--region x,y,w,h]" >&2
  echo "example: $0 01-hero-remembers --delay 8" >&2
  exit 1
fi
shift

DELAY=5
REGION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --delay)  DELAY="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/${NAME}.png"
TMP="$(mktemp -t vodou-shot).png"
trap 'rm -f "$TMP"' EXIT

if [ -n "$REGION" ]; then
  echo "Capturing region $REGION in ${DELAY}s — arrange the screen now…"
  for i in $(seq "$DELAY" -1 1); do printf "\r  %2ds " "$i"; sleep 1; done; printf "\r        \r"
  screencapture -x -R "$REGION" "$TMP"
else
  echo "Interactive capture: drag the area you want (aim for a 16:10 shape)."
  echo "Tip: hold SPACE after starting the drag to move the selection."
  screencapture -i "$TMP"
fi

if [ ! -s "$TMP" ]; then
  echo "ERROR: capture cancelled or empty — nothing written." >&2
  exit 1
fi

W=$(sips -g pixelWidth  "$TMP" | awk '/pixelWidth/{print $2}')
H=$(sips -g pixelHeight "$TMP" | awk '/pixelHeight/{print $2}')
echo "  captured ${W}x${H}"

# Fit INSIDE 1280x800 preserving aspect, then pad out to exactly 1280x800.
#
# Getting this order wrong silently destroys the shot: `sips -p` CROPS when the image is
# larger than the pad box, it does not shrink to fit. Verified 2026-07-26 — running
# `--resampleHeightWidthMax 1280` on a 543x1024 portrait produced 679x1280, and the pad
# step then cut the popup's header and version footer clean off while still reporting a
# healthy "1280x800". So: constrain by whichever dimension is the binding one FIRST, so
# both dims are <= target and `-p` can only ever add padding.
ASPECT_NUM=$(( W * TARGET_H ))     # compare W/H against TARGET_W/TARGET_H without floats
ASPECT_DEN=$(( H * TARGET_W ))
if [ "$ASPECT_NUM" -gt "$ASPECT_DEN" ]; then
  # wider than 16:10 -> width is binding
  sips --resampleWidth "$TARGET_W" "$TMP" --out "$TMP" >/dev/null 2>&1
else
  # taller than (or equal to) 16:10 -> height is binding
  sips --resampleHeight "$TARGET_H" "$TMP" --out "$TMP" >/dev/null 2>&1
fi

# Now pad. Dark grey blends with the dark UI, so letterboxing a portrait popup shot reads
# as deliberate framing rather than a mistake.
sips -p "$TARGET_H" "$TARGET_W" --padColor 141414 "$TMP" --out "$TMP" >/dev/null 2>&1

# Force PNG regardless of what the source format was — the current store-assets are
# JPEGs wearing a .png extension, which is exactly the mismatch that fails upload.
sips -s format png "$TMP" --out "$OUT" >/dev/null 2>&1

FW=$(sips -g pixelWidth  "$OUT" | awk '/pixelWidth/{print $2}')
FH=$(sips -g pixelHeight "$OUT" | awk '/pixelHeight/{print $2}')
FMT=$(sips -g format "$OUT" | awk '/format:/{print $2}')

if [ "$FW" != "$TARGET_W" ] || [ "$FH" != "$TARGET_H" ]; then
  echo "ERROR: result is ${FW}x${FH}, need ${TARGET_W}x${TARGET_H} — NOT usable for the store." >&2
  exit 1
fi
if [ "$FMT" != "png" ]; then
  echo "ERROR: result format is '$FMT', expected png." >&2
  exit 1
fi

echo "  ✓ wrote $OUT  (${FW}x${FH}, $FMT)"
echo
echo "Now look at it at thumbnail size — if you can't tell what it shows, restage and reshoot:"
echo "  qlmanage -p \"$OUT\" >/dev/null 2>&1 &"
