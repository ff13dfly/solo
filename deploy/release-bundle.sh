#!/bin/bash
#
# Solo Release Bundle Materializer
#
# Builds the immutable solo.js bundle for one or more RELEASE TAGS and collects
# them under release/ (which is .gitignored — bundles are NEVER committed).
#
# Why this exists: the bundle is byte-for-byte reproducible from a tag
# (git checkout <tag> && deploy/build.sh → identical output). So git itself,
# via tags, already stores every version — as reproducible source, not 7.7MB
# binaries in history. This script just *materializes* those binaries on demand
# into a folder you can browse / diff / upload to a GitHub Release / object store.
#
# Usage:
#   bash deploy/release-bundle.sh v1.1.2
#   bash deploy/release-bundle.sh v1.1.0 v1.1.1 v1.1.2
#
# For each tag: checkout (detached) → deploy/build.sh → copy to
# release/solo.<tag>.js → restore your original branch. A clean working tree is
# required (the script moves HEAD); an EXIT/INT trap always puts HEAD back.
#
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( dirname "$SCRIPT_DIR" )"
REL_DIR="$ROOT_DIR/release"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log_info()  { printf "${GREEN}✓ %s${NC}\n" "$1"; }
log_warn()  { printf "${YELLOW}⚠ %s${NC}\n" "$1"; }
log_step()  { printf "${CYAN}▸ %s${NC}\n" "$1"; }
log_error() { printf "${RED}✗ %s${NC}\n" "$1"; exit 1; }

[ $# -ge 1 ] || { echo "Usage: bash deploy/release-bundle.sh <tag> [<tag>...]  (e.g. v1.1.0 v1.1.1 v1.1.2)"; exit 1; }

cd "$ROOT_DIR"

# --- Guard: refuse on a dirty tree (we move HEAD; untracked files are fine) ---
if ! git diff --quiet || ! git diff --cached --quiet; then
    log_error "Working tree has uncommitted tracked changes — commit/stash first (this script checks out tags)."
fi

# Remember where to return: branch name if on one, else the bare commit.
ORIG_REF="$(git symbolic-ref --quiet --short HEAD || git rev-parse HEAD)"
restore() { git checkout --quiet "$ORIG_REF" 2>/dev/null || true; }
trap restore EXIT INT TERM

mkdir -p "$REL_DIR"

for TAG in "$@"; do
    if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
        log_warn "skip $TAG — no such tag"; continue
    fi
    log_step "Materializing $TAG ..."
    git checkout --quiet "$TAG"

    # Sanity: package.json version should equal the tag (vX.Y.Z).
    PKGV="v$(node -e "console.log(require('$ROOT_DIR/package.json').version)" 2>/dev/null || echo '?')"
    [ "$PKGV" = "$TAG" ] || log_warn "$TAG: package.json says $PKGV (tag/version mismatch — building anyway)"

    BLOG="$(mktemp)"
    if ! bash "$ROOT_DIR/deploy/build.sh" >"$BLOG" 2>&1; then
        tail -20 "$BLOG"; rm -f "$BLOG"; log_error "$TAG: build failed (HEAD will be restored)"
    fi
    rm -f "$BLOG"

    cp "$ROOT_DIR/api/publish/solo.js" "$REL_DIR/solo.$TAG.js"
    log_info "$TAG → release/solo.$TAG.js ($(ls -lh "$REL_DIR/solo.$TAG.js" | awk '{print $5}'))"
done

restore
trap - EXIT INT TERM

# Refresh checksums for everything currently staged in release/.
( cd "$REL_DIR" && shasum -a 256 solo.v*.js 2>/dev/null | sort -k2 > SHA256SUMS || true )

echo ""
log_info "Back on: $(git rev-parse --abbrev-ref HEAD)"
log_info "release/ (gitignored — upload these to GitHub Release / object storage; do not commit):"
ls -lh "$REL_DIR" | sed 's/^/   /'
