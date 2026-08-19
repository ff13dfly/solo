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

# ── 端口探测统一入口（lsof / ss 二选一）───────────────────────────────────
# macOS 必有 lsof;Debian/Ubuntu 最小安装常**没有** lsof（不是默认包），但必有
# ss(iproute2)。v1.1.14 的 fail-fast 守卫曾把 lsof 当必然存在:缺失时 `command not
# found` 被 2>/dev/null 吞掉、stdout 为空——fe_assert_port_free 静默放行(它要防的
# 正是静默失效)、fe_confirm_bound 空转 5 秒后 exit 1 打死起得好好的前端,报错文本
# 与事实相反、还指向一个空日志(docs/feedback/done/run-sh-lsof-hard-dependency.md)。
# 现在:两个工具都没有 → 启动即报**真实原因**;有其一 → 全脚本经这三个函数探测。
PORT_TOOL=""
command -v lsof >/dev/null 2>&1 && PORT_TOOL="lsof"
[ -z "$PORT_TOOL" ] && command -v ss >/dev/null 2>&1 && PORT_TOOL="ss"
if [ -z "$PORT_TOOL" ]; then
    log_error "缺少端口探测工具:lsof 与 ss 都不存在——端口守卫(fail-fast/清扫/dashboard)依赖其一。"
    log_error "Debian/Ubuntu: sudo apt-get install -y lsof   (或装 iproute2 提供 ss)"
    exit 1
fi

# port_in_use <port> — 有人在监听该 TCP 端口则返回 0
port_in_use() {
    if [ "$PORT_TOOL" = "lsof" ]; then
        lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
    else
        [ -n "$(ss -tlnH "sport = :$1" 2>/dev/null)" ]
    fi
}

# listener_pids <port> — 监听该端口的 pid,一行一个。注意:ss 无权限看别的用户的进程时
# 会有监听但拿不到 pid(输出为空)——调用方要区分「没人监听」与「查不到归属」,用
# port_in_use 交叉判断。函数本身恒返回 0(set -e 下命令替换赋值不炸)。
listener_pids() {
    if [ "$PORT_TOOL" = "lsof" ]; then
        lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
    else
        ss -tlnpH "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
    fi
}

# listener_desc <port> — 占用方的一行人读描述(报错用)。恒返回 0。
listener_desc() {
    if [ "$PORT_TOOL" = "lsof" ]; then
        lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1 || true
    else
        ss -tlnpH "sport = :$1" 2>/dev/null | head -1 || true
    fi
}

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

# Defense in depth (the real fix is in the bundle entry — deploy/gen-entry.js
# deletes these before any service config.js loads): a shell that previously
# `export`ed one of these for a DIFFERENT Solo stack, or ran another project's
# run.sh, leaves them behind for this invocation. PORT/ROUTER_URL only have a
# legitimate meaning for a standalone single-service process — section 9 below
# sets them explicitly per private-app child anyway — so a leftover value here
# can only cause harm (bundle services picking up a foreign Router or all
# colliding on one port), never fix anything. Not in this project's .env
# template, so this cannot clobber an intentional setting.
# Background: docs/feedback/done/inherited-router-url-silent-misdelivery.md
unset PORT ROUTER_URL ADMINISTRATOR_SERVICE_URL

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

declare -a SVC_NAMES SVC_PATHS SVC_PORTS SVC_ENVS
if [ -f "$SERVICES_JSON" ]; then
    _tmp_svc=$(mktemp)
    # Optional per-app `env` object, serialized as \x1f-separated K=V pairs in the 4th
    # field. WHY it exists: .env is sourced with `set -o allexport`, so anything put
    # there hits EVERY service — but "which service is exposed / how verbose is it" is a
    # per-service decision. Without this, a project that wants ONE app reachable from
    # outside has to open all of them and claw the boundary back with a machine-level
    # firewall — knowledge that lives outside the repo, silently lost on `nft flush
    # ruleset`, and never re-checked when a new service is added.
    #   { "name": "coder", "path": "apps/coder/index.js", "port": 8422,
    #     "env": { "BIND_ADDR": "0.0.0.0" } }
    # Field order matters: `env` is LAST so a value containing '|' can't break the split
    # (read's final variable absorbs the remainder).
    node -e "
const services = JSON.parse(require('fs').readFileSync('$SERVICES_JSON', 'utf8'));
services.forEach(s => {
  const env = Object.entries(s.env || {}).map(([k, v]) => k + '=' + v).join('\x1f');
  console.log([s.name, s.path, s.port, env].join('|'));
});
" > "$_tmp_svc"
    while IFS='|' read -r n p port envs; do
        SVC_NAMES+=("$n")
        SVC_PATHS+=("$p")
        SVC_PORTS+=("$port")
        SVC_ENVS+=("$envs")
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
REDIS_HOST=$(node -e "try{const u=new URL(process.env.REDIS_URL||'redis://127.0.0.1:6379');process.stdout.write(u.hostname||'127.0.0.1')}catch(e){process.stdout.write('127.0.0.1')}")

# Redis auth (production hardening): REDIS_PASSWORD comes from .env (init.sh generates it;
# older projects without the line keep running unauthenticated — only-add). The password
# also rides inside REDIS_URL (redis://:pass@host:port) for the node clients; REDISCLI_AUTH
# is how redis-cli picks it up WITHOUT -a (which would leak it into `ps` output).
if [ -z "${REDIS_PASSWORD:-}" ]; then
    REDIS_PASSWORD=$(node -e "try{const u=new URL(process.env.REDIS_URL||'');process.stdout.write(u.password||'')}catch(e){process.stdout.write('')}")
fi
[ -n "$REDIS_PASSWORD" ] && export REDISCLI_AUTH="$REDIS_PASSWORD"

cleanup() {
    # 必须是第一条语句:接住触发 trap 的那条命令/exit 的退出码。fail fast 的 exit 1
    # 曾被结尾的 `exit 0` 吃掉,start-all.command 这类按退出码判断的启动器会把
    # "拒绝启动"读成"起好了"。
    local rc=$?
    trap - SIGINT SIGTERM EXIT   # 防重入:SIGINT 路径里 exit 会再触发 EXIT trap
    echo ""
    log_warn "Stopping all services..."
    for pid in "${CHILD_PIDS[@]}"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    [ -n "$SSL_PID" ] && kill "$SSL_PID" 2>/dev/null || true
    # Belt-and-suspenders: free ports in case any child detached — 但只杀自己进程组
    # 的成员。这段清扫对两份 services.json 里的所有端口执行,而 v1.1.14 起每条
    # fail fast 路径(端口冲突/Redis 归属不符)都会经 EXIT trap 走到这里:若不看
    # 归属,同机另一个正在跑的栈(端口撞车时恰恰是它占着端口)会被连根杀掉——
    # 第二个实例没抢到任何东西,却把第一个打死了。子进程不 setsid,pgid 天然继承
    # 自本脚本,判据成立。背景:solo/docs/feedback/done/scaffold-startup-guards-fallout.md §①
    local _our_pgid _pg l
    _our_pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
    for port in "${SOLO_PORTS[@]}" "${SVC_PORTS[@]}"; do
        for l in $(listener_pids "$port"); do
            _pg=$(ps -o pgid= -p "$l" 2>/dev/null | tr -d ' ')
            [ -n "$_our_pgid" ] && [ "$_pg" = "$_our_pgid" ] && kill -9 "$l" 2>/dev/null || true
        done
    done
    [ "$REDIS_STARTED_BY_US" -eq 1 ] && redis-cli -p "$REDIS_PORT" shutdown nosave 2>/dev/null || true
    tput cnorm 2>/dev/null || true
    exit "$rc"
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
    # NOTE the `${arr[@]+"${arr[@]}"}` form used wherever this array is expanded below:
    # this script runs under `set -u` and macOS still ships bash 3.2, where a plain
    # "${EMPTY[@]}" aborts with "unbound variable" (verified). Don't "simplify" it.
    REDIS_MODULE_ARGS=()
    if command -v redis-stack-server &>/dev/null; then
        REDIS_BIN="redis-stack-server"
    elif command -v redis-server &>/dev/null; then
        REDIS_BIN="redis-server"
        # Redis 8.x on Debian/Ubuntu (packages.redis.io) ships the modules as .so files
        # under /usr/lib/redis/modules/ but does NOT load them unless the packaged
        # redis.conf says so — and we start redis with our own flags, never that conf.
        # So `redis-stack-server` is absent, this branch is taken, and JSON.SET then
        # fails with "unknown command" even though rejson.so is sitting right there.
        # Load it explicitly when we can find it, and only warn when we genuinely can't.
        # (Reported from a runner deploy on Debian 12 / redis 8.10 — 2026-08-14.)
        for _mdir in /usr/lib/redis/modules /usr/local/lib/redis/modules /opt/redis-stack/lib; do
            if [ -f "$_mdir/rejson.so" ]; then
                REDIS_MODULE_ARGS+=(--loadmodule "$_mdir/rejson.so")
                [ -f "$_mdir/redisearch.so" ] && REDIS_MODULE_ARGS+=(--loadmodule "$_mdir/redisearch.so")
                break
            fi
        done
        if [ ${#REDIS_MODULE_ARGS[@]} -gt 0 ]; then
            log_info "redis-stack-server not found — using redis-server + modules from ${_mdir}"
        else
            log_warn "redis-stack-server not found — falling back to plain redis-server."
            log_warn "  orchestrator/storage/nexus need RedisJSON and will fail on JSON.SET."
            case "$(uname -s)" in
                Darwin) log_warn "  Install: brew install redis-stack" ;;
                Linux)  log_warn "  Install: see https://redis.io/docs/latest/operate/oss_and_stack/install/ (Redis 8+ ships the modules; this script loads them from /usr/lib/redis/modules automatically once present)" ;;
                *)      log_warn "  Install a Redis build that provides the RedisJSON module." ;;
            esac
        fi
    else
        log_error "Redis not running on port $REDIS_PORT and no redis-stack-server/redis-server found"
        exit 1
    fi
    log_warn "Starting Redis ($REDIS_BIN) on port $REDIS_PORT..."
    mkdir -p "$SCRIPT_DIR/redis_data"
    # --requirepass only when a password is configured — a passwordless .env keeps the
    # old open behavior (dev / pre-upgrade projects), a populated one locks the port.
    "$REDIS_BIN" --port "$REDIS_PORT" \
        --daemonize yes \
        --dir "$SCRIPT_DIR/redis_data" \
        --logfile "$SCRIPT_DIR/redis.log" \
        ${REDIS_PASSWORD:+--requirepass "$REDIS_PASSWORD"} \
        ${REDIS_MODULE_ARGS[@]+"${REDIS_MODULE_ARGS[@]}"} \
        --save "3600 1" --save "300 100" --save "60 10000"
    for i in $(seq 1 20); do
        redis-cli -p "$REDIS_PORT" ping &>/dev/null 2>&1 && break
        sleep 0.2
    done
    redis-cli -p "$REDIS_PORT" ping &>/dev/null 2>&1 || { log_error "Redis failed to start on port $REDIS_PORT"; exit 1; }
    log_info "Redis started on port $REDIS_PORT ($REDIS_BIN)"
    REDIS_STARTED_BY_US=1
else
    # `ping` 只能证明"这个端口上有个 redis 在应答",证明不了它是谁起的。本机同时跑多个
    # Solo 栈时(各自 .env 独立、端口分配没有全局视角),撞车的后起者会静默挂到先起者的
    # 实例上,数据写进人家的 deploy/redis_data;换个启动顺序就从另一个目录加载 rdb,
    # 上一轮的数据看起来"消失"了(其实还在原目录的 rdb 里)。而且 `ping` 对 NOAUTH 同样
    # 返回退出码 0,所以带密码的别家实例也会被判成 "already running",随后业务服务连接
    # 失败报的是鉴权错误——看着像密码配错,不像端口撞车。
    #
    # `CONFIG GET dir` 一次覆盖这两层:不是本项目的目录 → 不匹配;没权限读 → 返回空
    # → 同样不匹配。REDISCLI_AUTH 已在上面导出,redis-cli 会自动带上凭证。
    # 只对本机实例校验:REDIS_URL 指向远端时 `-p` 探的本来就是本地端口,归属无从谈起。
    # 背景与实测:solo/docs/feedback/done/redis-port-ownership.md
    case "$REDIS_HOST" in
        127.0.0.1|localhost|::1|"")
            # `|| true`:同 serve_frontend,别让非零退出码撞上 set -e / pipefail。
            _redis_dir=$(redis-cli -p "$REDIS_PORT" config get dir 2>/dev/null | tail -1 || true)
            if [ "$_redis_dir" != "$SCRIPT_DIR/redis_data" ]; then
                log_error "端口 $REDIS_PORT 上的 Redis 不是本项目的实例,拒绝接管"
                log_error "  它的 dir:   ${_redis_dir:-<无权限或无应答>}"
                log_error "  本项目期望: $SCRIPT_DIR/redis_data"
                log_error "  改 .env 的 REDIS_URL 换端口,或先停掉那个实例。"
                exit 1
            fi
            ;;
    esac
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
#
# Network exposure: services call `app.listen(PORT, bindAddr('<name>'), …)`
# (api/library/ports.js). With neither BIND_ADDR nor <NAME>_BIND_ADDR set, bindAddr
# returns undefined and Node binds EVERY interface — the historical behavior, kept so
# upgrades don't cut off reverse proxies that reach a service from another host.
# To lock a deployment down, set BIND_ADDR=127.0.0.1 in .env and open exactly the apps
# that need it via the per-app `env` in services.json (see §4 above).

for i in "${!SVC_NAMES[@]}"; do
    name="${SVC_NAMES[$i]}"
    path="${SVC_PATHS[$i]}"
    port="${SVC_PORTS[$i]}"
    log_file="$DEBUG_DIR/${name}_debug.log"
    _app_env=("PORT=$port" "ROUTER_URL=http://localhost:$ROUTER_PORT")
    if [ -n "${SVC_ENVS[$i]:-}" ]; then
        # `|| true`: read hits EOF on the last field and returns 1 — with set -e that
        # would kill the script even though the array was populated correctly.
        IFS=$'\x1f' read -r -a _extra <<< "${SVC_ENVS[$i]}" || true
        _app_env+=(${_extra[@]+"${_extra[@]}"})
        log_info "  $name ← per-app env: ${_extra[*]:-}"
    fi
    env "${_app_env[@]}" node "$ROOT_DIR/api/$path" > "$log_file" 2>&1 &
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
#   branding.ts (portal/system, portal/operator) reads window.__SOLO_SYSTEM_NAME__,
#   sourced from SYSTEM_DISPLAY_NAME in .env, to disambiguate multiple deployed instances.

declare -a FE_NAMES FE_PORTS FE_LOGS

# ── 前端端口守卫(独立函数,供派生项目自有前端复用)────────────────────────
# 派生项目常有不走 serve_frontend 的前端(自有 Vite 应用直接 serve dist/ 等)。
# 抽成函数后它们在自己的启动段里调这两个,就能获得与 tarball 前端同等的保护;
# 否则那些前端仍是"端口被占 → serve 静默换随机口"的重灾区(finance/trend 均实测)。

# fe_assert_port_free <name> <port> — 启动前确认端口空闲,被占直接 fail fast。
fe_assert_port_free() {
    local name="$1" port="$2"
    if port_in_use "$port"; then
        log_error "  $name: 端口 $port 已被占用,拒绝启动(否则 serve 会静默换随机端口)"
        log_error "    占用方：$(listener_desc "$port")"
        log_error "    改 .env 里 $name 的端口,或先停掉占用方。"
        exit 1
    fi
}

# fe_confirm_bound <name> <port> <pid> <log_file> — 起动后确认监听者确实是我们
# 这个 pid——覆盖竞态(两个栈同时起)和进程自己起不来(bundle 解压坏、依赖缺失)
# 两种情形。
fe_confirm_bound() {
    local name="$1" port="$2" pid="$3" log_file="$4" bound=0 holder
    for _ in $(seq 1 25); do
        kill -0 "$pid" 2>/dev/null || break
        if listener_pids "$port" | grep -qx "$pid"; then
            bound=1; break
        fi
        sleep 0.2
    done
    if [ $bound -eq 0 ]; then
        # 「没人监听」和「有人监听但确认不了归属」必须说成两句话——后者(ss 无权限看
        # 到别的用户的进程等)如果也报「没起来」,会把人引向一个空的 serve 日志。
        if port_in_use "$port" && [ -z "$(listener_pids "$port")" ]; then
            log_error "  $name: 端口 $port 有人监听,但无法确认归属($PORT_TOOL 拿不到对方 pid)"
            log_error "    多半是别的用户/服务占着这个口——改 .env 里 $name 的端口,或先停掉占用方。"
            exit 1
        fi
        log_error "  $name: 前端没能在端口 $port 上起来"
        holder=$(listener_desc "$port")
        [ -n "$holder" ] && log_error "    端口现在的占用方：$holder"
        log_error "    serve 日志：$log_file"
        exit 1
    fi
}

# write_fe_config <dir> — 注入 config.js(Router 地址 + 品牌变量)。抽成函数:此前
# 自有前端只能把这几行复制出去,bundle 一旦增删注入项(如 v1.1.15 加的
# __SOLO_SYSTEM_DESCRIPTION__),各家的副本不会跟着更新,症状是新字段在自有前端里
# 永远读不到。现在 tarball 前端与源码前端(serve_src_frontend)共用同一份注入。
write_fe_config() {
    local dir="$1"
    if [ $SSL_ENABLED -eq 1 ]; then
        printf 'window.__SOLO_ROUTER__ = "https://localhost:8686/";\n' > "$dir/config.js"
    else
        printf 'window.__SOLO_ROUTER__ = "http://localhost:%s/";\n' "$ROUTER_PORT" > "$dir/config.js"
    fi
    local sys_name="${SYSTEM_DISPLAY_NAME:-SYSTEM}"
    printf 'window.__SOLO_SYSTEM_NAME__ = "%s";\n' "${sys_name//\"/\\\"}" >> "$dir/config.js"
    # `:-` 兜底必须有:init.sh 生成的 .env 没有这个变量,set -u 下裸引用会让
    # 全新项目在第一个前端这里直接死掉(unbound variable)。
    if [ -n "${SYSTEM_DESCRIPTION:-}" ]; then
        printf 'window.__SOLO_SYSTEM_DESCRIPTION__ = "%s";\n' "${SYSTEM_DESCRIPTION//\"/\\\"}" >> "$dir/config.js"
    fi
}

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
    write_fe_config "$serve_dir"
    # 端口冲突必须在启动前拦下:`serve` 在端口被占时会**静默换一个随机端口并报告成功**
    # (实测 serve 14.2.4:占住 39117 后日志里写的是 "Accepting connections at :51410";
    # 源码 build/main.js 是 listen 前 isPortReachable 探一下、可达就无条件 startServer
    # ({port:0}),而 --no-port-switching 只在 arg 表里声明、代码里从没被消费 = 死 flag,
    # 所以不能靠它)。后果是 run.sh 照旧打印配置的端口,dashboard 的 lsof 探到的是占用方
    # 的监听 → 一路假绿,前端其实几个月没起来过也没人发现。启动期的资源冲突一律 fail
    # fast,不 warn。背景:solo/docs/feedback/done/redis-port-ownership.md §六
    fe_assert_port_free "$name" "$port"
    local log_file="$DEBUG_DIR/fe_${name}.log"
    "$ROOT_DIR/node_modules/.bin/serve" "$serve_dir" -p "$port" -s \
        > "$log_file" 2>&1 &
    local pid=$!
    CHILD_PIDS+=($pid)
    fe_confirm_bound "$name" "$port" "$pid" "$log_file"
    FE_NAMES+=("$name"); FE_PORTS+=("$port"); FE_LOGS+=("$log_file")
    log_info "  $name → http://localhost:$port"
}

SOLO_VER=$(tr -d '[:space:]' < "$VERSION_FILE")
serve_frontend "operator" "$ROOT_DIR/portal/publish/operator.${SOLO_VER}.tar.gz" "${PORTAL_OPERATOR_PORT:-}"
serve_frontend "system"   "$ROOT_DIR/portal/publish/system.${SOLO_VER}.tar.gz"   "${PORTAL_SYSTEM_PORT:-}"
serve_frontend "mobile"   "$ROOT_DIR/client/publish/mobile.${SOLO_VER}.tar.gz"   "${CLIENT_MOBILE_PORT:-}"

# ── 派生项目自有前端(源码形态:自己的 Vite/React 应用等)──────────────────
# 此前唯一的接入方式是把启动代码写进本文件——而本文件随 bundle 升级被 upgrade.sh
# 整体覆盖,四个派生项目各抄的那段就是每次升级的必然牺牲品:轻则前端静默消失,
# 重则连带丢掉对 serve_frontend 的本地改动而 run.sh 照常打印"启动成功"
# (docs/feedback/done/run-sh-no-derived-frontend-registry.md)。现在改成声明式:
# .env 里写一对变量即接入,run.sh 零改动、升级零冲突:
#   FRONTEND_ANT_DIR=client/ant      # 相对项目根(或绝对路径);目录下须有 package.json
#   FRONTEND_ANT_PORT=3790           # 缺 PORT 的 DIR 声明会被点名警告
# 行为:缺 dist/ 自动 npm install + npm run build → 注入与 tarball 前端同源的
# config.js → 同款端口守卫(fe_assert_port_free / fe_confirm_bound)→ 进 dashboard。
serve_src_frontend() {
    local name="$1" dir="$2" port="$3"
    [ -z "$port" ] && return
    if [ ! -d "$dir" ]; then
        log_warn "  $name: 前端目录不存在($dir)— 跳过。检查 .env 里 FRONTEND_$(printf '%s' "$name" | tr 'a-z' 'A-Z')_DIR。"
        return
    fi
    if [ ! -d "$dir/dist" ]; then
        log_warn "  $name: dist/ 缺失,现场构建(npm install + npm run build,首次约 1 分钟)..."
        if ! (cd "$dir" && npm install --no-audit --no-fund --loglevel=error && npm run build) >> "$DEBUG_DIR/fe_${name}_build.log" 2>&1; then
            log_error "  $name: 构建失败 —— 见 $DEBUG_DIR/fe_${name}_build.log"
            exit 1
        fi
    fi
    write_fe_config "$dir/dist"
    fe_assert_port_free "$name" "$port"
    local log_file="$DEBUG_DIR/fe_${name}.log"
    "$ROOT_DIR/node_modules/.bin/serve" "$dir/dist" -p "$port" -s \
        > "$log_file" 2>&1 &
    local pid=$!
    CHILD_PIDS+=($pid)
    fe_confirm_bound "$name" "$port" "$pid" "$log_file"
    FE_NAMES+=("$name"); FE_PORTS+=("$port"); FE_LOGS+=("$log_file")
    log_info "  $name → http://localhost:$port (src)"
}

# 扫 .env 声明(经 allexport 已成环境变量;compgen -v 列所有已定义变量,bash 3.2 可用)
for _fev in $(compgen -v | grep '^FRONTEND_[A-Z0-9_]*_DIR$' || true); do
    _fe_name=$(printf '%s' "$_fev" | sed 's/^FRONTEND_//; s/_DIR$//')
    _fe_port_var="FRONTEND_${_fe_name}_PORT"
    _fe_dir="${!_fev}"
    _fe_port="${!_fe_port_var:-}"
    if [ -z "$_fe_port" ]; then
        log_warn "  ${_fev} 声明了但没有配套的 ${_fe_port_var} —— 该前端不会启动。"
        continue
    fi
    case "$_fe_dir" in /*) ;; *) _fe_dir="$ROOT_DIR/$_fe_dir" ;; esac
    serve_src_frontend "$(printf '%s' "$_fe_name" | tr 'A-Z' 'a-z')" "$_fe_dir" "$_fe_port"
done

# 逃生舱:注册表覆盖不了的启动逻辑(自定义 serve 命令、额外注入等)放这个文件。
# 它不随 bundle 下发、upgrade.sh 永不覆盖;文件里可直接用本脚本的函数
# (write_fe_config / fe_assert_port_free / fe_confirm_bound / port_in_use)与数组
# (CHILD_PIDS / FE_NAMES / FE_PORTS / FE_LOGS)。
[ -f "$SCRIPT_DIR/frontends.local.sh" ] && . "$SCRIPT_DIR/frontends.local.sh"

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
            if port_in_use "$port"; then
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
            if port_in_use "$port"; then
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
                if port_in_use "$fe_port"; then
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
            if port_in_use 8686; then
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
