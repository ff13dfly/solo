#!/bin/bash
# precheck.sh - Static autocheck gate for all services before bundling
# Runs autocheck --static on every service listed in services.json.
# Exits non-zero on first failure so build.sh can abort.

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( dirname "$SCRIPT_DIR" )"
API_DIR="$ROOT_DIR/api"
SERVICES_JSON="$SCRIPT_DIR/services.json"
AUTOCHECK="$API_DIR/autocheck/checker.js"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { printf "${GREEN}✓ %s${NC}\n" "$1"; }
log_warn()  { printf "${YELLOW}⚠ %s${NC}\n" "$1"; }
log_error() { printf "${RED}✗ %s${NC}\n" "$1"; }

echo "========================================"
echo "  Solo Pre-Deploy Static Autocheck"
echo "========================================"

if [ ! -f "$SERVICES_JSON" ]; then
    log_error "services.json not found: $SERVICES_JSON"
    exit 1
fi

if [ ! -f "$AUTOCHECK" ]; then
    log_error "autocheck.js not found: $AUTOCHECK"
    exit 1
fi

FAILED=0
PASSED=0
TOTAL=0

# Read service paths from services.json
# Only check apps/ services — core/ services intentionally deviate from the
# standard microservice pattern (they are infrastructure, not business services).
PATHS=$(node -e "
const s = require('$SERVICES_JSON');
s.filter(svc => svc.path.startsWith('apps/')).forEach(svc => {
    const dir = svc.path.replace('/index.js', '');
    console.log(svc.name + ':' + dir);
});
")

for entry in $PATHS; do
    name="${entry%%:*}"
    rel_path="${entry##*:}"
    full_path="$API_DIR/$rel_path"
    TOTAL=$((TOTAL + 1))

    if [ ! -d "$full_path" ]; then
        log_warn "$name: directory not found ($full_path) — skipping"
        continue
    fi

    # Run autocheck --static, capturing output
    output=$(node "$AUTOCHECK" "$full_path" --static 2>&1)
    exit_code=$?

    if [ $exit_code -eq 0 ]; then
        log_info "$name: OK"
        PASSED=$((PASSED + 1))
    else
        log_error "$name: FAILED"
        # Print the errors section from the output
        echo "$output" | grep -E "^   ❌" | head -20
        FAILED=$((FAILED + 1))
    fi
done

echo "========================================"
echo "  Checked: $TOTAL  Passed: $PASSED  Failed: $FAILED"
echo "========================================"

if [ $FAILED -gt 0 ]; then
    log_error "Pre-deploy check failed — fix errors before bundling."
    exit 1
fi

log_info "All services passed static autocheck."
exit 0
