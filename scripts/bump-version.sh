#!/usr/bin/env bash
# bump-version.sh — One-command version bump for Vodou
# Usage: ./scripts/bump-version.sh [major|minor|patch] [--tag]
#        ./scripts/bump-version.sh 0.5.37 [--tag]
#
# Bumps: Cargo.toml + Cargo.lock (scoped text edits, no cargo, no network),
# then git tags if --tag is passed.

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
# ── Bump Cargo.toml ──────────────────────────────────────────────────────────
# RC-12, part two. This was a `sed -i` with a `0,/re/{s/…/…/}` range, branched on
# $OSTYPE. GNU sed accepts `0,`; **BSD sed does not**, and the darwin branch —
# the one that runs on the machine this project is developed on — died with
#
#   sed: 1: "0,/^version = ..." : bad flag in substitute command: '}'
#
# So the script aborted at its FIRST step, before the cargo hang that gotcha #17
# blamed. `set -e` meant it left the tree untouched, which is the one mercy: the
# reason nobody noticed a second bug is that the first abort looked like the
# first bug.
#
# awk, matching the Cargo.lock edit below: portable, and it can refuse rather
# than silently doing nothing. Only the FIRST `version =` after `[package]` is
# touched — dependency versions further down are left alone.
echo "→ Updating Cargo.toml..."
awk -v old="$CURRENT_VERSION" -v new="$NEW_VERSION" '
  /^\[package\]/ { inpkg = 1 }
  /^\[/ && !/^\[package\]/ { inpkg = 0 }
  inpkg && !done && $0 == "version = \"" old "\"" {
    print "version = \"" new "\""; done = 1; next
  }
  { print }
  END { if (!done) { print "BUMP_TOML_MISS" > "/dev/stderr"; exit 1 } }
' Cargo.toml > Cargo.toml.tmp || {
  rm -f Cargo.toml.tmp
  echo "   ✗ Cargo.toml has no [package] version = \"$CURRENT_VERSION\" — not touching it." >&2
  exit 1
}
mv Cargo.toml.tmp Cargo.toml

# ── Bump Cargo.lock ──────────────────────────────────────────────────────────
# RC-12: this used to be `cargo update --workspace --precise "$NEW_VERSION"`,
# which is not a valid combination, so it always fell through to
# `cargo generate-lockfile` — a full re-resolution of every dependency, over the
# network, which is the >10-minute hang the release playbook filed as gotcha #17
# and then routed around ("bump the two files directly"). It also produced a
# lockfile diff of hundreds of unrelated lines and committed it unattended.
#
# Our own version lives in exactly one place in Cargo.lock: the `version` line
# directly under `name = "vodou-core"`. Nothing else in the file depends on it.
# So do what the playbook told a human to do, and verify it happened.
echo "→ Updating Cargo.lock..."
awk -v old="$CURRENT_VERSION" -v new="$NEW_VERSION" '
  $0 == "name = \"vodou-core\"" {
    print
    if ((getline nxt) > 0) {
      if (nxt == "version = \"" old "\"") { print "version = \"" new "\""; hits++ }
      else { print nxt }
    }
    next
  }
  { print }
  END { if (hits != 1) { print "BUMP_LOCK_MISS" > "/dev/stderr"; exit 1 } }
' Cargo.lock > Cargo.lock.tmp || {
  rm -f Cargo.lock.tmp
  echo "   ✗ Cargo.lock has no [[package]] vodou-core at $CURRENT_VERSION — not touching it." >&2
  echo "     Fix Cargo.lock by hand, then re-run." >&2
  exit 1
}
mv Cargo.lock.tmp Cargo.lock

# ── Git commit ───────────────────────────────────────────────────────────────
echo "→ Creating commit..."
# Pathspec-limited: multiple agent sessions share this worktree and therefore
# share `.git/index`. A bare `git commit` here would sweep whatever anyone else
# had staged into a commit titled "bump version" (CLAUDE.md, "Committing from
# parallel sessions"). Naming the paths on `git commit` commits those two files
# and nothing else, whatever the index holds.
git commit -m "chore: bump version $CURRENT_VERSION → $NEW_VERSION" -- Cargo.toml Cargo.lock

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
