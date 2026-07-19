#!/usr/bin/env bash
# bump-version.sh — One-command version bump for Vodou
# Usage: ./scripts/bump-version.sh [major|minor|patch] [--tag]
#        ./scripts/bump-version.sh 0.5.37 [--tag]
#
# Bumps: Cargo.toml + Cargo.lock (via cargo), then git tags if --tag is passed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# ── Helpers ─────────────────────────────────────────────────────────────────
usage() {
  echo "Usage: $0 [major|minor|patch|X.Y.Z] [--tag] [--push]"
  echo ""
  echo "  major    Bump major version (1.2.3 → 2.0.0)"
  echo "  minor    Bump minor version (1.2.3 → 1.3.0)"
  echo "  patch    Bump patch version (1.2.3 → 1.2.4)  [default]"
  echo "  X.Y.Z    Set exact version"
  echo ""
  echo "  --tag    Create git tag after bump"
  echo "  --push   Push commits + tag to remote"
  exit 1
}

semver_bump() {
  local current="$1"
  local part="$2"
  IFS='.' read -r major minor patch <<< "$current"
  case "$part" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
    *) echo "$part" ;;  # Exact version passed
  esac
}

# ── Parse args ───────────────────────────────────────────────────────────────
BUMP_ARG="${1:-patch}"
DO_TAG=false
DO_PUSH=false

shift || true
for arg in "$@"; do
  case "$arg" in
    --tag)  DO_TAG=true ;;
    --push) DO_PUSH=true; DO_TAG=true ;;
    *)      echo "Unknown flag: $arg"; usage ;;
  esac
done

# ── Get current version from Cargo.toml ─────────────────────────────────────
CURRENT_VERSION=$(grep '^version = ' Cargo.toml | head -1 | sed 's/version = "//;s/"//')
echo "Current version: $CURRENT_VERSION"

# ── Compute new version ──────────────────────────────────────────────────────
NEW_VERSION=$(semver_bump "$CURRENT_VERSION" "$BUMP_ARG")

# Validate semver format
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid version: $NEW_VERSION"
  usage
fi

echo "New version:     $NEW_VERSION"
echo ""

# Confirm
read -r -p "Bump $CURRENT_VERSION → $NEW_VERSION? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# ── Bump Cargo.toml ──────────────────────────────────────────────────────────
echo "→ Updating Cargo.toml..."
# Use sed to update only the [package] version (first occurrence)
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "0,/^version = \"$CURRENT_VERSION\"/{s/^version = \"$CURRENT_VERSION\"/version = \"$NEW_VERSION\"/}" Cargo.toml
else
  sed -i "0,/^version = \"$CURRENT_VERSION\"/{s/^version = \"$CURRENT_VERSION\"/version = \"$NEW_VERSION\"/}" Cargo.toml
fi

# Update Cargo.lock (no network, just rewrites the lock entry)
if command -v cargo &>/dev/null; then
  echo "→ Updating Cargo.lock..."
  cargo update --workspace --precise "$NEW_VERSION" 2>/dev/null || \
    cargo generate-lockfile 2>/dev/null || \
    echo "   (cargo not in PATH or failed — Cargo.lock may need manual update)"
fi

# ── Git commit ───────────────────────────────────────────────────────────────
echo "→ Staging changes..."
git add Cargo.toml Cargo.lock 2>/dev/null || git add Cargo.toml

echo "→ Creating commit..."
git commit -m "chore: bump version $CURRENT_VERSION → $NEW_VERSION"

# ── Git tag ──────────────────────────────────────────────────────────────────
if $DO_TAG; then
  TAG="v$NEW_VERSION"
  echo "→ Creating tag $TAG..."
  git tag -a "$TAG" -m "Release $TAG"
fi

# ── Push ─────────────────────────────────────────────────────────────────────
if $DO_PUSH; then
  echo "→ Pushing to remote..."
  git push
  if $DO_TAG; then
    git push --tags
  fi
fi

echo ""
echo "Done! Vodou is now version $NEW_VERSION"
if $DO_TAG; then
  echo "Tagged: v$NEW_VERSION"
fi
