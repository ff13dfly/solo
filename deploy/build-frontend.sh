#!/bin/bash
#
# Build frontend bundles for portal and client/mobile.
# Outputs tarballs to portal/publish/ and client/publish/.
#
# Usage (run from solo root):
#   bash deploy/build-frontend.sh
#
# Targets:
#   portal/operator  → portal/publish/operator.v{version}.tar.gz
#   portal/system    → portal/publish/system.v{version}.tar.gz
#   client/mobile    → client/publish/mobile.v{version}.tar.gz
#

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( dirname "$SCRIPT_DIR" )"
VERSION=$(node -e "process.stdout.write(require('$ROOT_DIR/package.json').version)")

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log_info()  { printf "${GREEN}✓ %s${NC}\n" "$1"; }
log_warn()  { printf "${YELLOW}⚠ %s${NC}\n" "$1"; }
log_error() { printf "${RED}✗ %s${NC}\n" "$1"; exit 1; }

cd "$ROOT_DIR"

build_frontend() {
    local label="$1"   # e.g. "portal/operator"
    local out_dir="$2" # e.g. "portal/publish"
    local name="$3"    # e.g. "operator"
    local tarball="$out_dir/$name.v$VERSION.tar.gz"

    [ -d "$label" ] || log_error "Source dir not found: $label"

    log_warn "Building $label..."
    (cd "$label" && npm install --silent && npx vite build --base /)
    mkdir -p "$out_dir"
    # Prune older-version tarballs of THIS target before writing the new one.
    # Otherwise portal/publish accumulates stale versions and init.sh / run.sh
    # can ship or serve an old bundle (exactly how v1.0.0 lingered next to v1.1.0).
    rm -f "$out_dir/$name".v*.tar.gz
    tar -czf "$tarball" -C "$label/dist" .
    local size
    size=$(du -sh "$tarball" | cut -f1)
    log_info "$tarball  ($size)"
}

mkdir -p portal/publish client/publish

build_frontend "portal/operator" "portal/publish" "operator"
build_frontend "portal/system"   "portal/publish" "system"
build_frontend "client/mobile"   "client/publish" "mobile"

echo ""
log_info "All frontend bundles built (v$VERSION)"
echo ""
echo "Next: run  bash deploy/scaffold/init.sh <project>  to scaffold a new project with these bundles."
