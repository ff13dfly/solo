#!/bin/bash

# Solo.AI Unified Development Launcher
# Installs dependencies, starts independent Redis, and the full-stack dashboard.

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( dirname "$SCRIPT_DIR" )"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { printf "${GREEN}✓ %s${NC}\n" "$1"; }
log_warn()  { printf "${YELLOW}⚠ %s${NC}\n" "$1"; }
log_error() { printf "${RED}✗ %s${NC}\n" "$1"; }

cd "$ROOT_DIR" || exit

# ─── 1. Auto-install Dependencies ──────────────────────────────────────
echo "Checking frontend dependencies..."

FE_DIRS=(
    "portal/system"
    "portal/operator"
    "client/mobile"
    "client/desktop"
)

for dir in "${FE_DIRS[@]}"; do
    if [ -d "$dir" ] && [ -f "$dir/package.json" ] && [ ! -d "$dir/node_modules" ]; then
        log_warn "$dir: node_modules missing, installing..."
        (cd "$dir" && npm install --silent 2>&1 | tail -1)
        if [ $? -eq 0 ]; then
            log_info "$dir: dependencies installed"
        else
            log_error "$dir: install failed"
        fi
    fi
done

# Also check api/ backend dependencies
if [ -d "api" ] && [ -f "api/package.json" ] && [ ! -d "api/node_modules" ]; then
    log_warn "api: node_modules missing, installing..."
    (cd api && npm install --silent 2>&1 | tail -1)
    log_info "api: dependencies installed"
fi

echo ""

# ─── 2. Setup Independent Redis ────────────────────────────────────────
export REDIS_URL="redis://127.0.0.1:6699"
# Get Router Public Key dynamically from .keypair
export ROUTER_PUBLIC_KEY=$(node -e "try { const { loadOrGenerateKeypair, getKeypair } = require('./api/router/handlers/keypair'); loadOrGenerateKeypair(); console.log(getKeypair().publicKey.toBase58()); } catch(e) { console.log('8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji'); }" | tail -n 1)
echo "Using Router Public Key: $ROUTER_PUBLIC_KEY"
REDIS_DATA_DIR="$SCRIPT_DIR/redis_data"
mkdir -p "$REDIS_DATA_DIR"

# orchestrator + storage use redis.json.* (RedisJSON module required).
# Prefer redis-stack-server (ships with RedisJSON); fall back to plain
# redis-server with a warning (orchestrator/storage will crash on JSON.SET).
echo "Starting independent Redis on port 6699..."
lsof -ti:6699 | xargs kill -9 2>/dev/null
if command -v redis-stack-server &>/dev/null; then
    nohup redis-stack-server --port 6699 --dir "$REDIS_DATA_DIR" --dbfilename dump.rdb --save "" --loglevel warning > "$SCRIPT_DIR/redis.log" 2>&1 &
    REDIS_PID=$!
    echo "  → redis-stack-server (RedisJSON included)"
else
    echo "  ⚠️  redis-stack-server not found — falling back to plain redis-server."
    echo "     orchestrator and storage will fail (require RedisJSON)."
    echo "     Install: brew install redis-stack"
    nohup redis-server --port 6699 --dir "$REDIS_DATA_DIR" --dbfilename dump.rdb > "$SCRIPT_DIR/redis.log" 2>&1 &
    REDIS_PID=$!
fi
sleep 2

# ─── 2b. Setup local OSS server (storage provider=local) ───────────────
# The storage service migrated to a driver-based OSS provider. In dev it talks
# to this single-file local OSS server (the dev/test stand-in for Aliyun OSS).
export STORAGE_PROVIDER="local"
export LOCAL_OSS_PORT="8755"
export LOCAL_OSS_SECRET="solo-local-oss-dev-secret"
export LOCAL_OSS_ENDPOINT="http://127.0.0.1:8755"
export LOCAL_OSS_ROOT="$ROOT_DIR/uploads/assets"
echo "Starting local OSS server on port 8755..."
lsof -ti:8755 | xargs kill -9 2>/dev/null
nohup node "$ROOT_DIR/deploy/local-oss.js" > "$SCRIPT_DIR/local-oss.log" 2>&1 &
OSS_PID=$!
sleep 1

cleanup() {
    echo -e "\nShutting down independent Redis + local OSS + mock listener..."
    kill -9 $REDIS_PID 2>/dev/null
    kill -9 $(lsof -ti:6699) 2>/dev/null
    kill -9 $OSS_PID 2>/dev/null
    kill -9 $(lsof -ti:8755) 2>/dev/null
    kill $MOCK_LISTENER_PID 2>/dev/null
    kill -9 $(lsof -ti:8090) 2>/dev/null
}
trap cleanup EXIT INT TERM

# ─── 3. Pre-seed service registry ─────────────────────────────────────
# Writes stub entries for all services.json + services.dev.json into Redis
# before the router boots, so every service appears in the portal Service
# Registry on the first run without manual re-registration.
echo "Pre-seeding service registry..."
node "$SCRIPT_DIR/seed-registry.js"

# ─── 3b. Bootstrap mock webhook source ────────────────────────────────
# Creates the "mock-listener" ingress source in Redis on first run and
# saves its API key to deploy/mock/keys.env (gitignored). Idempotent.
echo "Bootstrapping mock webhook source..."
node "$SCRIPT_DIR/mock/bootstrap.js"

# Start the mock listener in the background (port 8090). It connects to the
# Router at http://127.0.0.1:8600 which starts a few seconds later; errors
# before the Router is up are silently ignored. Heartbeat fires every 30 s.
MOCK_KEY=$(grep "^SRC_mock-listener=" "$SCRIPT_DIR/mock/keys.env" 2>/dev/null | cut -d'=' -f2 | tr -d '[:space:]')
export MOCK_LISTENER_PORT="8090"
MOCK_LISTENER_PID=""
if [ -n "$MOCK_KEY" ]; then
    lsof -ti:$MOCK_LISTENER_PORT | xargs kill -9 2>/dev/null
    INGRESS_API_KEY="$MOCK_KEY" SOURCE_NAME="mock-listener" MOCK_PORT="$MOCK_LISTENER_PORT" \
        ROUTER_URL="http://127.0.0.1:8600" \
        nohup node "$SCRIPT_DIR/mock/listener.js" > "$SCRIPT_DIR/mock-listener.log" 2>&1 &
    MOCK_LISTENER_PID=$!
    log_info "Mock webhook listener started on port $MOCK_LISTENER_PORT (pid $MOCK_LISTENER_PID)"
else
    log_warn "Mock listener skipped (no API key in deploy/mock/keys.env)"
fi

# ─── 3c. Seed relay bot tokens (background) ───────────────────────────
# Waits until the Router is up AND the user service has registered its bot
# methods (up to 90 s — probes user.bot.list, not just ping: the Router answers
# HTTP before downstream handshakes finish, which used to race every RPC into
# "Method not found"), then creates the relay bots and seeds their tokens. Idempotent.
# This is what makes ingress TEST button (and fulfillment emit) work in dev
# without having to configure bot tokens manually in the portal.
node "$SCRIPT_DIR/seed-bots.js" > "$SCRIPT_DIR/seed-bots.log" 2>&1 &

# ─── 3d. Inject mock workflows (background) ────────────────────────────
# Redis has no persistence (--save ""), so workflows are lost on every restart.
# Re-inject the mock workflow set (sets status=ACTIVE, writes event-registry).
# Runs after seed-bots to avoid race with registry write; errors are non-fatal.
if [ -f "$SCRIPT_DIR/mock/inject-workflows.js" ]; then
    (sleep 5 && node "$SCRIPT_DIR/mock/inject-workflows.js" --active \
        > "$SCRIPT_DIR/inject-workflows.log" 2>&1) &
    log_info "Mock workflows queued for injection (5 s delay)"
fi

# ─── 3e. Inject fulfillment sample (background) ────────────────────────
# Seeds one realistic fulfillment profile + instances across its states (via RPC,
# walking the real engine → genuine history + EVENT:FULFILLMENT:TRANSITIONED on
# the bus). Self-probes fulfillment readiness; idempotent.
if [ -f "$SCRIPT_DIR/mock/inject-fulfillment.js" ]; then
    node "$SCRIPT_DIR/mock/inject-fulfillment.js" > "$SCRIPT_DIR/inject-fulfillment.log" 2>&1 &
    log_info "Fulfillment sample queued for injection"
fi

# ─── 4. Launch the unified dashboard ──────────────────────────────────
"$SCRIPT_DIR/dashboard_all.sh" "$@"
