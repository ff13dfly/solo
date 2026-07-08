#!/bin/bash

# Solo.AI Unified Full-Stack Dashboard
# Manages both Backend Microservices and Frontend Development services.

# Colors & Formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( dirname "$SCRIPT_DIR" )"
SERVICES_JSON="$SCRIPT_DIR/services.json"
# Dev-only overlay: extra services started in dev but NOT bundled (build.sh /
# gen-entry.js / check-doc-drift.js read services.json only). Used for business
# test fixtures (collection, market) — keeps the framework bundle business-free.
DEV_SERVICES_JSON="$SCRIPT_DIR/services.dev.json"

# Arguments
MODE="browser"
SSL_ENABLED=0
for arg in "$@"; do
    case $arg in
        native) MODE="native" ;;
        --ssl)  SSL_ENABLED=1 ;;
    esac
done

cd "$ROOT_DIR" || exit

# --- 1. DATA INITIALIZATION ---

# Load Backend Services (services.json + optional dev-only overlay services.dev.json)
BACKEND_DATA=$(node -e "
const fs = require('fs');
let services = JSON.parse(fs.readFileSync('$SERVICES_JSON', 'utf8'));
const dev = '$DEV_SERVICES_JSON';
if (fs.existsSync(dev)) {
    try { services = services.concat(JSON.parse(fs.readFileSync(dev, 'utf8'))); }
    catch (e) { console.error('bad services.dev.json:', e.message); }
}
services.forEach(s => {
    console.log([\`name=\${s.name.toUpperCase()}\`, \`path=\${s.path}\`, \`port=\${s.port}\`].join('|'));
});
")

declare -A BE_NAMES BE_PATHS BE_PORTS
idx=0
while IFS='|' read -r name path port; do
    BE_NAMES[$idx]=${name#name=}
    BE_PATHS[$idx]=${path#path=}
    BE_PORTS[$idx]=${port#port=}
    idx=$((idx+1))
done <<< "$BACKEND_DATA"
TOTAL_BE=$idx

# Frontend Services
DESKTOP_CMD=$([ "$MODE" == "native" ] && echo "npx tauri dev" || echo "npm run dev")
FE_SERVICES=(
    "Portal System|portal/system|9200|npm run dev"
    "Portal Operator|portal/operator|9300|npm run dev"
    "Solo Mobile|client/mobile|9500|npm run dev"
    "Solo Desktop|client/desktop|9600|$DESKTOP_CMD"
)

# --- 2. STARTUP ---

cleanup() {
    printf "\n${YELLOW}Shutting down all services...${NC}\n"
    # Kill backends
    for i in "${!BE_NAMES[@]}"; do
        pids=$(ps aux | grep "node.*api/${BE_PATHS[$i]}" | grep -v grep | awk '{print $2}')
        [ -n "$pids" ] && kill $pids 2>/dev/null
        l_pid=$(lsof -ti:${BE_PORTS[$i]} 2>/dev/null)
        [ -n "$l_pid" ] && kill -9 $l_pid 2>/dev/null
    done
    # Kill frontends
    kill $(jobs -p) 2>/dev/null
    # Kill SSL proxy
    [ $SSL_ENABLED -eq 1 ] && kill -9 $(lsof -ti:8800) 2>/dev/null
    tput cnorm; exit
}
trap cleanup SIGINT SIGTERM EXIT

clear
printf "${BLUE}${BOLD}=== Solo.AI Unified Startup ===${NC}\n"

# Get Router Public Key dynamically from .keypair
export ROUTER_PUBLIC_KEY=$(node -e "try { const { loadOrGenerateKeypair, getKeypair } = require('./api/router/handlers/keypair'); loadOrGenerateKeypair(); console.log(getKeypair().publicKey.toBase58()); } catch(e) { console.log('8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji'); }" | tail -n 1)

# Backend
printf "Launching Backends...\r"
mkdir -p "$ROOT_DIR/api/debug"
for i in "${!BE_NAMES[@]}"; do
    path=${BE_PATHS[$i]}
    dir=$(dirname "api/$path"); file=$(basename "$path")
    lsof -ti:${BE_PORTS[$i]} | xargs kill -9 2>/dev/null
    (cd "$dir" && nohup node "$file" > "$ROOT_DIR/api/debug/${BE_NAMES[$i]}_debug.log" 2>&1 &)
done

# Frontend
printf "Launching Frontends...\r"
FE_PIDS=()
FE_START_TIMES=()
for i in "${!FE_SERVICES[@]}"; do
    IFS='|' read -r name path port cmd <<< "${FE_SERVICES[$i]}"
    if [ -d "$path/node_modules" ]; then
        (cd "$path" && eval "$cmd" > /dev/null 2>&1) &
        FE_PIDS[$i]=$!
        FE_START_TIMES[$i]=$(date +%s)
    else
        FE_PIDS[$i]=-1
    fi
done

if [ $SSL_ENABLED -eq 1 ]; then
    nohup local-ssl-proxy --source 8800 --target 8600 --cert "$HOME/.certs/localhost+2.pem" --key "$HOME/.certs/localhost+2-key.pem" > /dev/null 2>&1 &
fi

START_TOTAL=$(date +%s)
tput civis

# --- 3. DASHBOARD LOOP ---
while true; do
    tput cup 0 0
    printf -- "${BLUE}${BOLD}=== Solo.AI FULL-STACK DASHBOARD ===${NC}\n"
    printf -- "${CYAN}Uptime: $(($(date +%s) - START_TOTAL))s | Backends: $TOTAL_BE | Frontends: ${#FE_SERVICES[@]} | Mode: $MODE${NC}\n\n"

    # Backend Table
    printf -- "${BOLD}%-15s %-6s %-10s %s${NC}\n" "BACKEND" "PORT" "STATUS" "LOG PREVIEW"
    printf -- "--------------------------------------------------------------------------------\n"
    for i in "${!BE_NAMES[@]}"; do
        port=${BE_PORTS[$i]}
        path=${BE_PATHS[$i]}
        STATUS=$(lsof -i:$port -sTCP:LISTEN &>/dev/null && printf -- "${GREEN}[ON]${NC}" || printf -- "${RED}[OFF]${NC}")
        log_file="api/debug/${BE_NAMES[$i]}_debug.log"
        # Clean log line: keep only printable characters, remove CR/LF
        LAST_LOG=$([ -f "$log_file" ] && tail -n 1 "$log_file" | tr -cd '[:print:]' | sed 's/^[0-9-]*T\([0-9][0-9]:[0-9][0-9]:[0-9][0-9]\)\.[0-9]*Z/\1/' | cut -c1-50 || echo "-")
        printf -- "%-15s %-6s %-10b %s\n" "${BE_NAMES[$i]}" "$port" "$STATUS" "$LAST_LOG"
    done
    printf -- "\n"

    # Frontend Table
    printf -- "${BOLD}%-20s %-6s %-10s %-8s %s${NC}\n" "FRONTEND" "PORT" "STATUS" "UPTIME" "URL"
    printf -- "--------------------------------------------------------------------------------\n"
    for i in "${!FE_SERVICES[@]}"; do
        IFS='|' read -r name path port cmd <<< "${FE_SERVICES[$i]}"
        pid=${FE_PIDS[$i]}
        if [ "$pid" == "-1" ]; then STATUS="${RED}[NO_DEP]${NC}"; UP="-"; URL="-";
        elif kill -0 "$pid" 2>/dev/null; then STATUS="${GREEN}[ON]${NC}"; UP="$(($(date +%s) - FE_START_TIMES[$i]))s"; URL="http://localhost:$port"
        else STATUS="${RED}[OFF]${NC}"; UP="-"; URL="-"; fi
        printf -- "%-20s %-6s %-10b %-8s ${GREEN}%s${NC}\n" "$name" "$port" "$STATUS" "$UP" "$URL"
    done

    # Aux Services Table
    printf -- "\n${BOLD}%-16s %-6s %-10s %s${NC}\n" "AUX" "PORT" "STATUS" "INFO"
    printf -- "--------------------------------------------------------------------------------\n"

    REDIS_ST=$(lsof -i:6699 -sTCP:LISTEN &>/dev/null && printf "${GREEN}[ON]${NC}" || printf "${RED}[OFF]${NC}")
    printf -- "%-16s %-6s %-10b %s\n" "Redis" "6699" "$REDIS_ST" "${REDIS_URL:-redis://127.0.0.1:6699}  data: deploy/redis_data/"

    OSS_ST=$(lsof -i:8755 -sTCP:LISTEN &>/dev/null && printf "${GREEN}[ON]${NC}" || printf "${RED}[OFF]${NC}")
    printf -- "%-16s %-6s %-10b %s\n" "Local OSS" "8755" "$OSS_ST" "${LOCAL_OSS_ENDPOINT:-http://127.0.0.1:8755}  uploads: uploads/assets/"

    if [ -n "$MOCK_LISTENER_PORT" ]; then
        MOCK_ST=$(lsof -i:$MOCK_LISTENER_PORT -sTCP:LISTEN &>/dev/null && printf "${GREEN}[ON]${NC}" || printf "${RED}[OFF]${NC}")
        printf -- "%-16s %-6s %-10b %s\n" "Mock Listener" "$MOCK_LISTENER_PORT" "$MOCK_ST" "http://localhost:$MOCK_LISTENER_PORT/hook  source: mock-listener  /health"
    fi

    if [ $SSL_ENABLED -eq 1 ]; then
        SSL_ST=$(lsof -i:8800 -sTCP:LISTEN &>/dev/null && printf "${GREEN}[ON]${NC}" || printf "${RED}[OFF]${NC}")
        printf -- "%-16s %-6s %-10b %s\n" "SSL Proxy" "8800" "$SSL_ST" "https://127.0.0.1:8800  →  Router 8600"
    fi

    # Dev Seeds Table — shows non-production data injected at startup.
    # Redis has no persistence (--save ""), so these are re-seeded each run.
    # ⚠ All items here are DEV-ONLY and must never reach a production instance.
    printf -- "\n${YELLOW}${BOLD}%-16s %-22s %-10s %s${NC}\n" "DEV SEEDS ⚠" "KEY" "STATUS" "DETAIL"
    printf -- "--------------------------------------------------------------------------------\n"

    DEV_SEED_DATA=$(node --no-warnings -e "
const { createClient } = require('./api/node_modules/redis');
async function main() {
    const r = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6699' });
    r.on('error', () => {});
    await r.connect().catch(() => { console.log('REDIS_DOWN'); process.exit(0); });

    // Dev admin session
    const sess = await r.get('session:solo-dev-admin').catch(() => null);
    console.log('SESSION|session:solo-dev-admin|' + (sess ? 'present' : 'missing') + '|uid=dev-admin  permit=allow_all  (never use in prod)');

    // Relay bot tokens
    for (const svc of ['ingress', 'fulfillment', 'orchestrator']) {
        const raw = await r.get('RELAY:TOKEN:' + svc).catch(() => null);
        if (!raw) { console.log('RELAY|RELAY:TOKEN:' + svc + '|missing|bot token not seeded'); continue; }
        try {
            const t = JSON.parse(raw);
            const expiresIn = Math.round((t.expiresAt - Date.now()) / 1000 / 60);
            const ok = expiresIn > 0;
            console.log('RELAY|RELAY:TOKEN:' + svc + '|' + (ok ? 'valid' : 'expired') + '|sub=' + t.sub + '  expires in ' + (ok ? expiresIn + 'm' : 'EXPIRED'));
        } catch { console.log('RELAY|RELAY:TOKEN:' + svc + '|bad_json|-'); }
    }

    // Mock ingress source
    const srcId = await r.get('INGRESS:NAME:mock-listener').catch(() => null);
    if (srcId) {
        const src = await r.get('INGRESS:SOURCE:' + srcId).catch(() => null);
        const s = src ? JSON.parse(src) : null;
        console.log('SOURCE|INGRESS:SOURCE:' + srcId + '|' + (s?.enabled ? 'enabled' : 'disabled') + '|name=mock-listener  key in deploy/mock/keys.env  dedupTtl=' + (s?.dedupTtlSec || '?') + 's');
    } else {
        console.log('SOURCE|INGRESS:NAME:mock-listener|missing|run: node deploy/mock/bootstrap.js');
    }

    // Mock workflows
    const wfIds = await r.sMembers('ORCHESTRATOR:WORKFLOW_INDEX').catch(() => []);
    const mockWfs = [];
    for (const id of wfIds) {
        const doc = await r.json.get('ORCHESTRATOR:WORKFLOW:' + id).catch(() => null);
        if (doc?.category === 'mock' || id.startsWith('wf-')) mockWfs.push(id + '(' + (doc?.status || '?') + ')');
    }
    const wfStatus = mockWfs.length > 0 ? 'injected' : 'missing';
    const preview = mockWfs.slice(0, 3).join(' ') + (mockWfs.length > 3 ? ' +' + (mockWfs.length - 3) + ' more' : '');
    const wfDetail = mockWfs.length > 0
        ? preview
        : 'run: node deploy/mock/inject-workflows.js --active';
    console.log('WORKFLOW|ORCHESTRATOR:WORKFLOW_INDEX|' + wfStatus + '|' + wfDetail);

    await r.quit().catch(() => {});
}
main().catch(() => console.log('ERROR|-|-|-'));
" 2>/dev/null)

    if [ "$DEV_SEED_DATA" = "REDIS_DOWN" ]; then
        printf -- "%-16s %-22s %-10s %s\n" "(redis down)" "-" "-" "cannot read seed state"
    else
        while IFS='|' read -r kind key status detail; do
            [ -z "$kind" ] && continue
            case "$status" in
                present|valid|enabled|injected) ST="${GREEN}[${status}]${NC}" ;;
                missing|expired|disabled)       ST="${RED}[${status}]${NC}" ;;
                *)                              ST="${YELLOW}[${status}]${NC}" ;;
            esac
            printf -- "%-16s %-22s %-10b %s\n" "$kind" "$key" "$ST" "$detail"
        done <<< "$DEV_SEED_DATA"
    fi

    printf -- "\n${YELLOW}Press Ctrl+C to stop everything.${NC}\n"
    sleep 2
done
