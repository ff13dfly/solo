#!/bin/bash
[ -z "$BASH_VERSION" ] && exec bash "$0" "$@"
#
# Solo Project Runner — single entry for all start modes.
#
# Usage:
#   bash deploy/run.sh                  # dashboard + SSL proxy on 8686→router (default)
#   bash deploy/run.sh --no-ssl         # dashboard without SSL proxy
#   bash deploy/run.sh --plain          # plain mode: logs to stdout, foreground
#   bash deploy/run.sh --plain --no-ssl
#
# What it starts:
#   1. Solo bundle  (api/publish/solo.{version}.js) — Solo core services
#   2. Private apps (api/apps/*) — per deploy/services.json
#
# All processes are tracked and killed together on Ctrl+C.
#

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( dirname "$SCRIPT_DIR" )"
VERSION_FILE="$ROOT_DIR/.solo-version"
SERVICES_JSON="$SCRIPT_DIR/services.json"
DEBUG_DIR="$ROOT_DIR/api/debug"

# ANSI
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { printf "${GREEN}✓ %s${NC}\n" "$1"; }
log_warn()  { printf "${YELLOW}⚠ %s${NC}\n" "$1"; }
log_error() { printf "${RED}✗ %s${NC}\n" "$1" >&2; }

# --- Args ---

MODE="dashboard"
SSL_ENABLED=1
for arg in "$@"; do
    case $arg in
        --plain)     MODE="plain" ;;
        --no-ssl)    SSL_ENABLED=0 ;;
        *) log_error "Unknown flag: $arg"; exit 1 ;;
    esac
done

cd "$ROOT_DIR"

# --- 1. Load .env ---

if [ -f "$ROOT_DIR/.env" ]; then
    set -o allexport
    source "$ROOT_DIR/.env"
    set +o allexport
fi

# --- 2. Ensure npm dependencies ---
# Private apps require redis / @solana/web3.js / etc. via api/library. If
# node_modules is missing or out of date, install before starting anything.

if [ -f "$ROOT_DIR/package.json" ]; then
    if [ ! -d "$ROOT_DIR/node_modules" ] || [ "$ROOT_DIR/package.json" -nt "$ROOT_DIR/node_modules" ]; then
        log_warn "Installing npm dependencies (one-time, ~30s)..."
        (cd "$ROOT_DIR" && npm install --no-audit --no-fund --loglevel=error)
        log_info "Dependencies installed"
    fi
fi

# --- 3. Resolve bundle ---

[ ! -f "$VERSION_FILE" ] && { log_error ".solo-version not found"; exit 1; }
SOLO_VERSION=$(tr -d '[:space:]' < "$VERSION_FILE")
SOLO_BUNDLE="$ROOT_DIR/api/publish/solo.${SOLO_VERSION}.js"

if [ ! -f "$SOLO_BUNDLE" ]; then
    log_error "Solo bundle not found: $SOLO_BUNDLE"
    exit 1
fi

# --- 4. Load services.json (private apps) ---

declare -a SVC_NAMES SVC_PATHS SVC_PORTS
if [ -f "$SERVICES_JSON" ]; then
    _tmp_svc=$(mktemp)
    node -e "
const services = JSON.parse(require('fs').readFileSync('$SERVICES_JSON', 'utf8'));
services.forEach(s => console.log([s.name, s.path, s.port].join('|')));
" > "$_tmp_svc"
    while IFS='|' read -r n p port; do
        SVC_NAMES+=("$n")
        SVC_PATHS+=("$p")
        SVC_PORTS+=("$port")
    done < "$_tmp_svc"
    rm -f "$_tmp_svc"
fi

# --- 5. Process tracking + cleanup ---

mkdir -p "$DEBUG_DIR"
declare -a CHILD_PIDS

# Read Solo's (name, port) pairs from solo-services.json (set by init.sh at
# scaffold time). Used by cleanup() to free ports and by dashboard to display.
SOLO_SERVICES_JSON="$SCRIPT_DIR/solo-services.json"
declare -a SOLO_NAMES SOLO_PORTS
if [ -f "$SOLO_SERVICES_JSON" ]; then
    _tmp_solo=$(mktemp)
    node -e "
const services = JSON.parse(require('fs').readFileSync('$SOLO_SERVICES_JSON', 'utf8'));
services.forEach(s => console.log([s.name, s.port].join('|')));
" > "$_tmp_solo"
    while IFS='|' read -r n port; do
        SOLO_NAMES+=("$n")
        SOLO_PORTS+=("$port")
    done < "$_tmp_solo"
    rm -f "$_tmp_solo"
fi

SSL_PID=""
REDIS_STARTED_BY_US=0
REDIS_PORT=$(node -e "try{const u=new URL(process.env.REDIS_URL||'redis://127.0.0.1:6379');process.stdout.write(u.port||'6379')}catch(e){process.stdout.write('6379')}")

cleanup() {
    echo ""
    log_warn "Stopping all services..."
    for pid in "${CHILD_PIDS[@]}"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    [ -n "$SSL_PID" ] && kill "$SSL_PID" 2>/dev/null || true
    # Belt-and-suspenders: free ports in case any child detached
    for port in "${SOLO_PORTS[@]}" "${SVC_PORTS[@]}"; do
        l=$(lsof -ti:"$port" 2>/dev/null || true)
        [ -n "$l" ] && kill -9 $l 2>/dev/null || true
    done
    [ "$REDIS_STARTED_BY_US" -eq 1 ] && redis-cli -p "$REDIS_PORT" shutdown nosave 2>/dev/null || true
    tput cnorm 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# --- 6. Ensure Redis ---

if ! redis-cli -p "$REDIS_PORT" ping &>/dev/null 2>&1; then
    # orchestrator / storage / nexus persist workflow, run, and schedule docs via
    # redis.json.* (RedisJSON module). Plain redis-server lacks the module and
    # those services crash on JSON.SET, so prefer redis-stack-server (ships with
    # RedisJSON) and only fall back to plain redis-server with a loud warning.
    #
    # Note: the redis-stack-server wrapper hardcodes `--daemonize no`, but it
    # appends our args afterwards and redis config is last-wins, so the
    # `--daemonize yes` below correctly daemonizes it. Teardown uses
    # `redis-cli shutdown nosave` (below), which works regardless of binary.
    if command -v redis-stack-server &>/dev/null; then
        REDIS_BIN="redis-stack-server"
    elif command -v redis-server &>/dev/null; then
        REDIS_BIN="redis-server"
        log_warn "redis-stack-server not found — falling back to plain redis-server."
        log_warn "  orchestrator/storage/nexus need RedisJSON and will fail on JSON.SET."
        log_warn "  Install: brew install redis-stack"
    else
        log_error "Redis not running on port $REDIS_PORT and no redis-stack-server/redis-server found"
        exit 1
    fi
    log_warn "Starting Redis ($REDIS_BIN) on port $REDIS_PORT..."
    mkdir -p "$SCRIPT_DIR/redis_data"
    "$REDIS_BIN" --port "$REDIS_PORT" \
        --daemonize yes \
        --dir "$SCRIPT_DIR/redis_data" \
        --logfile "$SCRIPT_DIR/redis.log" \
        --save "3600 1" --save "300 100" --save "60 10000"
    for i in $(seq 1 20); do
        redis-cli -p "$REDIS_PORT" ping &>/dev/null 2>&1 && break
        sleep 0.2
    done
    redis-cli -p "$REDIS_PORT" ping &>/dev/null 2>&1 || { log_error "Redis failed to start on port $REDIS_PORT"; exit 1; }
    log_info "Redis started on port $REDIS_PORT ($REDIS_BIN)"
    REDIS_STARTED_BY_US=1
else
    log_info "Redis already running on port $REDIS_PORT"
fi

# --- 7. Seed initial data from deploy/seed.json (NX — skips keys that already exist) ---

_seed_file="$SCRIPT_DIR/seed.json"
if [ -f "$_seed_file" ]; then
    SEED_FILE="$_seed_file" REDIS_URL="$REDIS_URL" node -e "
const redis = require('redis');
const seeds = JSON.parse(require('fs').readFileSync(process.env.SEED_FILE, 'utf8'));
(async () => {
    const client = redis.createClient({ url: process.env.REDIS_URL });
    await client.connect();
    const now = Date.now();
    for (const s of seeds) {
        const val = { ...s.value, createdAt: now, updatedAt: now,
            items: (s.value.items || []).map(i => ({ ...i, createdAt: i.createdAt || now })) };
        const ok = await client.set(s.key, JSON.stringify(val), { NX: true });
        if (ok) {
            console.log('[Seed] Created: ' + s.key);
            // Sync category index: <SVC>:CONFIG:CATEGORY:<NAME> → <SVC>:CONFIG:CATEGORY_IDX
            const m = s.key.match(/^(.+):CONFIG:CATEGORY:(.+)$/);
            if (m) await client.sAdd(m[1] + ':CONFIG:CATEGORY_IDX', s.key);
        }
    }
    await client.quit();
})().catch(e => console.error('[Seed] Error:', e.message));
" || true
fi

# --- 7b. Seed Router service registry ---
#
# The Router boots knowing only the administrator service; every other method
# (user.register, planner.*, your private apps) returns -32601 until the service
# is registered. seed-registry.js writes stub entries into Redis `active_services`
# from solo-services.json + services.json BEFORE the bundle starts, so the Router
# loads them on boot and its updateCapabilityMap (~2 s later) fills in methods.
# Idempotent — skips services already in the registry.

if [ -f "$SCRIPT_DIR/seed-registry.js" ]; then
    REDIS_URL="$REDIS_URL" node "$SCRIPT_DIR/seed-registry.js" \
        || log_warn "seed-registry failed — services can still be added via the system portal"
fi

# --- 8. Start Solo bundle ---


BUNDLE_LOG="$DEBUG_DIR/SOLO_BUNDLE_debug.log"
log_info "Starting Solo bundle (v${SOLO_VERSION})..."
SOLO_SERVICES_JSON="$SOLO_SERVICES_JSON" node "$SOLO_BUNDLE" > "$BUNDLE_LOG" 2>&1 &
BUNDLE_PID=$!
CHILD_PIDS+=("$BUNDLE_PID")

# Give services time to bind ports before private apps connect
sleep 2

# Resolve router's actual port from solo-services.json so private apps and
# frontends can be told where to reach it. Falls back to the legacy 8484.
ROUTER_PORT="${ROUTER_PORT:-8484}"
for j in "${!SOLO_NAMES[@]}"; do
    [ "${SOLO_NAMES[$j]}" = "router" ] && ROUTER_PORT="${SOLO_PORTS[$j]}"
done

# --- 9. Start private apps ---

for i in "${!SVC_NAMES[@]}"; do
    name="${SVC_NAMES[$i]}"
    path="${SVC_PATHS[$i]}"
    port="${SVC_PORTS[$i]}"
    log_file="$DEBUG_DIR/${name}_debug.log"
    PORT="$port" ROUTER_URL="http://localhost:$ROUTER_PORT" \
        node "$ROOT_DIR/api/$path" > "$log_file" 2>&1 &
    pid=$!
    CHILD_PIDS+=("$pid")
    log_info "  $name → port $port (pid $pid)"
done

# --- 10. Frontend servers (portal + client/mobile) ---
#
# Serves pre-built tarballs from portal/publish/ and client/publish/.
# Each bundle is extracted to api/debug/serve/<name>/ and a config.js is
# injected so the SPA knows the Router URL at runtime.
#
# Convention for frontend code:
#   <script src="/config.js"></script>  (in index.html, before the main bundle)
#   routerManager.ts reads window.__SOLO_ROUTER__ as the default router URL.

declare -a FE_NAMES FE_PORTS FE_LOGS

serve_frontend() {
    local name="$1" tarball="$2" port="$3"
    [ -z "$port" ] && return
    # Port configured but no version-matched bundle: warn loudly instead of
    # silently skipping. A missing tarball here almost always means the bundle
    # version drifted from .solo-version — surface it rather than serve nothing.
    if [ ! -f "$tarball" ]; then
        log_warn "  $name: port $port set but bundle missing ($(basename "$tarball")) — skipping."
        log_warn "    Rebuild in Solo (deploy/build-frontend.sh) and ensure the version matches .solo-version ($SOLO_VER)."
        return
    fi
    local serve_dir="$DEBUG_DIR/serve/$name"
    mkdir -p "$serve_dir"
    tar -xzf "$tarball" -C "$serve_dir"
    if [ $SSL_ENABLED -eq 1 ]; then
        printf 'window.__SOLO_ROUTER__ = "https://localhost:8686/";\n' > "$serve_dir/config.js"
    else
        printf 'window.__SOLO_ROUTER__ = "http://localhost:%s/";\n' "$ROUTER_PORT" > "$serve_dir/config.js"
    fi
    local log_file="$DEBUG_DIR/fe_${name}.log"
    "$ROOT_DIR/node_modules/.bin/serve" "$serve_dir" -p "$port" -s \
        > "$log_file" 2>&1 &
    CHILD_PIDS+=($!)
    FE_NAMES+=("$name"); FE_PORTS+=("$port"); FE_LOGS+=("$log_file")
    log_info "  $name → http://localhost:$port"
}

SOLO_VER=$(tr -d '[:space:]' < "$VERSION_FILE")
serve_frontend "operator" "$ROOT_DIR/portal/publish/operator.${SOLO_VER}.tar.gz" "${PORTAL_OPERATOR_PORT:-}"
serve_frontend "system"   "$ROOT_DIR/portal/publish/system.${SOLO_VER}.tar.gz"   "${PORTAL_SYSTEM_PORT:-}"
serve_frontend "mobile"   "$ROOT_DIR/client/publish/mobile.${SOLO_VER}.tar.gz"   "${CLIENT_MOBILE_PORT:-}"

# --- 11. Optional SSL proxy ---


if [ $SSL_ENABLED -eq 1 ]; then
    # Find router's port from SOLO_NAMES/SOLO_PORTS
    ROUTER_PORT=""
    for j in "${!SOLO_NAMES[@]}"; do
        [ "${SOLO_NAMES[$j]}" = "router" ] && ROUTER_PORT="${SOLO_PORTS[$j]}"
    done
    SSL_CERT="$HOME/.certs/localhost+2.pem"
    SSL_KEY="$HOME/.certs/localhost+2-key.pem"
    if [ -z "$ROUTER_PORT" ]; then
        log_warn "SSL flag set but router port unknown — skipping"
    elif [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
        log_warn "Starting SSL proxy: 8686 → $ROUTER_PORT"
        npx local-ssl-proxy --source 8686 --target "$ROUTER_PORT" \
            --cert "$SSL_CERT" --key "$SSL_KEY" > "$DEBUG_DIR/SSL_proxy.log" 2>&1 &
        SSL_PID=$!
    else
        log_warn "SSL flag set but cert/key not found at $HOME/.certs/ — skipping"
    fi
fi

# --- 12. Output mode ---

if [ "$MODE" = "dashboard" ]; then
    # Dashboard mode — uses SOLO_NAMES / SOLO_PORTS already loaded above
    START_TIME=$(date +%s)
    tput civis 2>/dev/null || true
    clear
    while true; do
        tput cup 0 0 2>/dev/null || true
        echo -e "${BLUE}${BOLD}=== Solo Project Dashboard ===${NC}"
        echo -e "${CYAN}Bundle: ${SOLO_VERSION} | Uptime: $(($(date +%s) - START_TIME))s | SSL: $([ $SSL_ENABLED -eq 1 ] && echo "${GREEN}ON" || echo "${RED}OFF")${NC}"
        echo ""
        printf "${BOLD}%-18s %-6s %-12s %s${NC}\n" "SERVICE" "PORT" "STATUS" "INFO"
        echo "----------------------------------------------------------------------------"
        # Redis
        if redis-cli -p "$REDIS_PORT" ping &>/dev/null 2>&1; then
            _rs="${GREEN}[ONLINE]${NC}"
        else
            _rs="${RED}[OFFLINE]${NC}"
        fi
        _rdb_size=$(du -sh "$SCRIPT_DIR/redis_data/dump.rdb" 2>/dev/null | cut -f1 || echo "no snapshot")
        _rdb_path="deploy/redis_data  rdb:${_rdb_size}"
        printf "%-18s %-6s %-22b %s\n" "redis" "$REDIS_PORT" "$_rs" "$_rdb_path"
        echo "- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -"
        # Solo services
        for j in "${!SOLO_PORTS[@]}"; do
            port=${SOLO_PORTS[$j]}; name="solo:${SOLO_NAMES[$j]}"
            if lsof -i:"$port" -sTCP:LISTEN &>/dev/null; then
                status="${GREEN}[ONLINE]${NC}"
            else
                status="${RED}[OFFLINE]${NC}"
            fi
            last=$(tail -n 1 "$BUNDLE_LOG" 2>/dev/null | cut -c1-40)
            printf "%-18s %-6s %-22b %s\n" "$name" "$port" "$status" "$last"
        done
        # Private apps
        for i in "${!SVC_NAMES[@]}"; do
            name="app:${SVC_NAMES[$i]}"; port="${SVC_PORTS[$i]}"
            log_file="$DEBUG_DIR/${SVC_NAMES[$i]}_debug.log"
            if lsof -i:"$port" -sTCP:LISTEN &>/dev/null; then
                status="${GREEN}[ONLINE]${NC}"
            else
                status="${RED}[OFFLINE]${NC}"
            fi
            last=$([ -f "$log_file" ] && tail -n 1 "$log_file" | cut -c1-40 || echo "no log")
            printf "%-18s %-6s %-22b %s\n" "$name" "$port" "$status" "$last"
        done
        # Frontend servers (portal + client/mobile)
        if [ ${#FE_NAMES[@]} -gt 0 ]; then
            echo "- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -"
            for i in "${!FE_NAMES[@]}"; do
                fe_name="fe:${FE_NAMES[$i]}"; fe_port="${FE_PORTS[$i]}"
                if lsof -i:"$fe_port" -sTCP:LISTEN &>/dev/null; then
                    fe_status="${GREEN}[ONLINE]${NC}"
                else
                    fe_status="${RED}[OFFLINE]${NC}"
                fi
                printf "%-18s %-6s %-22b %s\n" "$fe_name" "$fe_port" "$fe_status" "http://localhost:$fe_port"
            done
        fi
        # SSL proxy
        if [ $SSL_ENABLED -eq 1 ]; then
            echo "- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -"
            if lsof -i:8686 -sTCP:LISTEN &>/dev/null; then
                _ssl_status="${GREEN}[ONLINE]${NC}"
            else
                _ssl_status="${RED}[OFFLINE]${NC}"
            fi
            printf "%-18s %-6s %-22b %s\n" "ssl-proxy" "8686" "$_ssl_status" "https://localhost:8686/ → router:${ROUTER_PORT}"
        fi
        echo "----------------------------------------------------------------------------"
        echo -e "${YELLOW}Ctrl+C to stop. Logs: $DEBUG_DIR/${NC}"
        sleep 2
    done
else
    # Plain mode — stream bundle log to terminal
    echo ""
    log_info "All services running. Logs: $DEBUG_DIR/"
    log_info "Ctrl+C to stop everything."
    echo ""
    tail -f "$BUNDLE_LOG" &
    CHILD_PIDS+=($!)
    wait "$BUNDLE_PID"
fi
