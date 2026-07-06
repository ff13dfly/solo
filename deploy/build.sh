#!/bin/bash
# Solo·AI Build Script - Bundles all services into solo.js

# --- Configuration ---
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( dirname "$SCRIPT_DIR" )"
SERVICES_JSON="$SCRIPT_DIR/services.json"
OUTPUT_FILE="$ROOT_DIR/api/publish/solo.js"

# ANSI colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { printf "${GREEN}✓ %s${NC}\n" "$1"; }
log_warn() { printf "${YELLOW}⚠ %s${NC}\n" "$1"; }
log_error() { printf "${RED}✗ %s${NC}\n" "$1"; }

echo "Building solo.js..."
echo "===================="

# --- Check services.json ---
if [ ! -f "$SERVICES_JSON" ]; then
    log_error "services.json not found at $SERVICES_JSON"
    exit 1
fi

# --- Optional build-time service slice ---
# Default: bundle EVERY service in services.json (only-add-not-break). Pass
#   bash deploy/build.sh --services router,user,nexus
# to compile only the named subset into solo.js (smaller bundle). gen-entry.js
# builds its REGISTRY from whatever list we hand it, and esbuild only pulls in
# the services that list require()s — so slicing the list slices the bundle.
SLICE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --services)   SLICE="$2"; shift 2 ;;
        --services=*) SLICE="${1#*=}"; shift ;;
        *) log_warn "ignoring unknown build arg: $1"; shift ;;
    esac
done

EFFECTIVE_SERVICES_JSON="$SERVICES_JSON"
SLICED_TMP=""
if [ -n "$SLICE" ]; then
    SLICED_TMP="$(mktemp -t solo-services-sliced).json"
    node -e '
        const fs = require("fs");
        const [src, slice, out] = process.argv.slice(1);
        const all = JSON.parse(fs.readFileSync(src, "utf8"));
        const want = new Set(slice.split(",").map(s => s.trim()).filter(Boolean));
        const missing = [...want].filter(n => !all.some(s => s.name === n));
        if (missing.length) { console.error("unknown service(s): " + missing.join(", ")); process.exit(1); }
        const picked = all.filter(s => want.has(s.name));
        fs.writeFileSync(out, JSON.stringify(picked, null, 2));
        console.error("sliced " + picked.length + "/" + all.length + " services: " + picked.map(s => s.name).join(", "));
    ' "$SERVICES_JSON" "$SLICE" "$SLICED_TMP" || { log_error "service slice failed"; rm -f "$SLICED_TMP"; exit 1; }
    EFFECTIVE_SERVICES_JSON="$SLICED_TMP"
    log_warn "Build-time slice active: only [$SLICE] bundled (default is all)"
fi

# --- Check esbuild ---
if ! command -v npx &> /dev/null; then
    log_error "npx not found. Please install Node.js."
    exit 1
fi

# --- Static autocheck gate ---
echo ""
echo "Running pre-deploy static checks..."
bash "$SCRIPT_DIR/precheck.sh"
if [ $? -ne 0 ]; then
    log_error "Pre-deploy check failed. Build aborted."
    exit 1
fi
echo ""

# --- Generate single entry point ---
#
# gen-entry.js produces api/_entry.js: a REGISTRY of lazy factories (every
# service in services.json gets compiled into the bundle) plus a runtime
# loader that reads SOLO_SERVICES_JSON to decide which factories to invoke
# and what ports to assign. See deploy/gen-entry.js for details.
#
# No more "patch source then restore" dance — config.js files read ports
# from global.__SOLO_PORTS__ via api/library/ports.js at runtime.
ENTRY_FILE="$ROOT_DIR/api/_entry.js"
node "$SCRIPT_DIR/gen-entry.js" "$EFFECTIVE_SERVICES_JSON" "$ENTRY_FILE"

# --- Build with esbuild ---
log_info "Bundling services into single file..."
mkdir -p "$ROOT_DIR/api/publish"

npx esbuild "$ENTRY_FILE" \
    --bundle \
    --platform=node \
    --format=cjs \
    --outfile="$OUTPUT_FILE" \
    --minify=false \
    --sourcemap \
    --external:sharp \
    --external:proxy-agent \
    --loader:.md=empty \
    --loader:.yaml=empty \
    --loader:.yml=empty \
    --loader:.txt=empty \
    --loader:.log=empty

BUILD_EXIT=$?
rm -f "$ENTRY_FILE"
[ -n "$SLICED_TMP" ] && rm -f "$SLICED_TMP"

if [ $BUILD_EXIT -eq 0 ]; then
    SIZE=$(ls -lh "$OUTPUT_FILE" | awk '{print $5}')
    log_info "solo.js built successfully ($SIZE)"
else
    log_error "Build failed"
    exit 1
fi

# --- Copy side-files that must stay outside the bundle ---
# Node Worker threads (`new Worker(filePath)`) require a real file on disk;
# they cannot resolve a module that exists only inside the esbuild output.
WORKER_SOURCES=(
    "api/apps/storage/logic/worker.js"
)
for w in "${WORKER_SOURCES[@]}"; do
    if [ -f "$ROOT_DIR/$w" ]; then
        cp "$ROOT_DIR/$w" "$ROOT_DIR/api/publish/$(basename "$w")"
        log_info "Side-file copied: $w → api/publish/$(basename "$w")"
    else
        log_error "Side-file missing: $ROOT_DIR/$w"
        exit 1
    fi
done

echo "===================="
log_info "Done! Output: $OUTPUT_FILE"
