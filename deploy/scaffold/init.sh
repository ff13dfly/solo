#!/bin/bash
#
# Solo Scaffold Init
#
# Creates a new Solo-based project from scratch.
# Run this from inside the Solo source directory.
#
# Usage:
#   bash deploy/scaffold/init.sh <project-name> [output-dir]
#
# Examples:
#   bash deploy/scaffold/init.sh runner
#   bash deploy/scaffold/init.sh runner /path/to/projects/runner
#
# What it does:
#   1. Builds solo.{version}.js (all 13 services; storage is local-OSS now)
#   2. Generates router keypair → writes ROUTER_PUBLIC_KEY into .env
#   3. Generates initial admin password → writes api/seed.json
#   4. Copies api/{autocheck,library,sample}, docs/ (authoring contract pack),
#      .claude/skills (solo-service guardrail), portal/operator (source),
#      e2e (API) + e2e/ui (Playwright)
#   5. Creates deploy/ with run.sh, services.json, .env
#   6. Creates package.json, .solo-version, .gitignore
#   7. Writes SETUP.md with all initial credentials (keep safe, do not commit)
#

set -euo pipefail

# --- Args ---

if [ -z "${1:-}" ]; then
    echo "Usage: bash deploy/scaffold/init.sh <project-name> [output-dir]"
    exit 1
fi

PROJECT_NAME="$1"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SOLO_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"
SOLO_VERSION=$(node -e "console.log(require('$SOLO_DIR/package.json').version)" 2>/dev/null || echo "1.0.0")

DEFAULT_OUT="$( dirname "$SOLO_DIR" )/$PROJECT_NAME"
NEW_DIR="${2:-$DEFAULT_OUT}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
log_info()  { printf "${GREEN}✓ %s${NC}\n" "$1"; }
log_warn()  { printf "${YELLOW}⚠ %s${NC}\n" "$1"; }
log_error() { printf "${RED}✗ %s${NC}\n" "$1"; exit 1; }

echo "Solo Scaffold Init"
echo "=================="
echo "  project : $PROJECT_NAME"
echo "  version : v$SOLO_VERSION"
echo "  output  : $NEW_DIR"
echo ""

if [ -e "$NEW_DIR" ]; then
    log_error "Output directory already exists: $NEW_DIR"
fi

# --- 1. Build Solo bundle ---
#
# The bundle is a generic "one artifact, many projects" loader. It bundles
# every Solo service into a REGISTRY of lazy factories; at runtime it reads
# SOLO_SERVICES_JSON (passed by deploy/run.sh) to decide which services to
# instantiate and on which ports. No build-time port injection, no source
# patching — same bundle works for every scaffolded project.

log_warn "Building solo.v${SOLO_VERSION}.js..."

set +e
bash "$SOLO_DIR/deploy/build.sh"
BUILD_EXIT=$?
set -e

[ $BUILD_EXIT -ne 0 ] && log_error "Build failed — new project not created"
log_info "Bundle built: api/publish/solo.js"

# --- 2. Create project skeleton ---

mkdir -p "$NEW_DIR/api/publish"
mkdir -p "$NEW_DIR/api/apps"
mkdir -p "$NEW_DIR/deploy"
mkdir -p "$NEW_DIR/portal/publish"
mkdir -p "$NEW_DIR/portal/operator"
mkdir -p "$NEW_DIR/portal/system"
mkdir -p "$NEW_DIR/client/publish"
mkdir -p "$NEW_DIR/client/mobile"
mkdir -p "$NEW_DIR/client/plugin"
mkdir -p "$NEW_DIR/client/extension"
mkdir -p "$NEW_DIR/client/extension-kit"

log_info "Directory structure created"

# --- 3. Copy Solo bundle ---

cp "$SOLO_DIR/api/publish/solo.js" "$NEW_DIR/api/publish/solo.v${SOLO_VERSION}.js"
echo "v${SOLO_VERSION}" > "$NEW_DIR/.solo-version"
log_info "Bundle copied: api/publish/solo.v${SOLO_VERSION}.js"

# --- 4. Generate router keypair ---
#
# Router signs every forwarded request with Ed25519. All downstream services
# verify the signature via ROUTER_PUBLIC_KEY. Generating it here means .env
# is ready before first run — no manual key-copy step.

log_warn "Generating router keypair..."

# tweetnacl + bs58, NOT @solana/web3.js. @why The runtime dropped the ~14MB
# @solana dep (api/router/handlers/keypair.js — "it was the last consumer"), but
# this build-time caller was not counted and kept requiring it out of solo's own
# node_modules. It only survived on machines carrying a stale orphan copy of the
# package: on a fresh clone (or after any `npm ci`) this line died with
# `Cannot find module .../@solana/web3.js` and no project could be scaffolded.
# See docs/feedback/done/scaffold-init-stale-solana-dep.md.
# The 64-byte secretKey layout (32 seed + 32 public) is identical either way, so
# .keypair files stay byte-compatible with projects scaffolded before this change.
KEYPAIR_JSON=$(node -e "
const nacl = require('$SOLO_DIR/api/node_modules/tweetnacl');
const bs58 = require('$SOLO_DIR/api/node_modules/bs58');
const kp = nacl.sign.keyPair();
process.stdout.write(JSON.stringify({
  pub: (bs58.default || bs58).encode(kp.publicKey),
  sec: Array.from(kp.secretKey)
}));
")

ROUTER_PUBLIC_KEY=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).pub)" "$KEYPAIR_JSON")
ROUTER_SECRET_KEY=$(node -e "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).sec))" "$KEYPAIR_JSON")

echo "$ROUTER_SECRET_KEY" > "$NEW_DIR/.keypair"
log_info "Keypair written → .keypair  (public: $ROUTER_PUBLIC_KEY)"

# --- 5. Generate admin seed (initial password) ---
#
# administrator service reads api/seed.json on first boot (path resolves to
# api/seed.json when running from the esbuild bundle in api/publish/).
# After the admin calls admin.password.reset, seed.json is auto-deleted and
# the hashed password lives in Redis only.

log_warn "Generating initial admin credentials..."

ADMIN_USER="admin"
ADMIN_PASS=$(node -e "process.stdout.write(require('crypto').randomBytes(12).toString('hex'))")
JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
# gateway 用它派生 AES 密钥加密 SMTP 账号密码（logic/smtp.js）。不设则
# gateway.smtp.create 直接抛 'GATEWAY_SECRET_KEY is not set' → SMTP 账号功能不可用。
GATEWAY_SECRET_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
# storage 的本地对象存储密钥（provider=local 时同时是 presign HMAC 密钥与 Bearer 令牌）。
# 不生成就会落到框架里那个公开的 dev 常量 'solo-local-oss-dev-secret'——那等于把
# 「伪造任意资产 URL」和「列桶/批量删对象」的能力公开出去。纯 hex，天生避开 # $ 空格 反引号。
LOCAL_OSS_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")
# Redis 口令（生产硬化）：run.sh 起 redis 时 --requirepass，客户端从 REDIS_URL 内嵌密码连。
REDIS_PASSWORD=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")

node -e "
const crypto = require('crypto');
const fs = require('fs');
const username = process.argv[1];
const password = process.argv[2];
const dest     = process.argv[3];
const salt       = crypto.randomBytes(16).toString('hex');
const iterations = 200000;
const loginHash  = crypto.pbkdf2Sync(
  password + username,
  Buffer.from(salt, 'hex'),
  iterations, 32, 'sha256'
).toString('hex');
const seed = { username, salt, iterations, login_hash: loginHash, role: 'admin', permit: { allow_all: true } };
fs.writeFileSync(dest, JSON.stringify(seed, null, 2));
" "$ADMIN_USER" "$ADMIN_PASS" "$NEW_DIR/api/seed.json"

log_info "Admin seed written → api/seed.json  (user: $ADMIN_USER)"

# --- 6. Copy autocheck / library / sample ---

cp -r "$SOLO_DIR/api/autocheck" "$NEW_DIR/api/autocheck"
cp -r "$SOLO_DIR/api/library"   "$NEW_DIR/api/library"
cp -r "$SOLO_DIR/api/sample"    "$NEW_DIR/api/sample"
log_info "Copied: autocheck, library, sample"

# --- 6a. Authoring / contract docs pack (docs/) ---
# The downstream contract pack — engine-accurate guides so a downstream dev or AI can write a
# wire-compatible service / events / workflow from scaffold info ALONE. Consolidated under one
# discoverable home, docs/, with docs/README.md as the manual index (the method VOCABULARY is
# already discoverable at runtime via the Router capability catalog in Redis; these supply the
# GRAMMAR). Version-pinned + re-templated, so upgrade.sh re-syncs the whole docs/ as one unit.
mkdir -p "$NEW_DIR/docs/authoring/workflow-examples"
sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" -e "s|{{SOLO_VERSION}}|$SOLO_VERSION|g" \
    "$SCRIPT_DIR/docs/README.md" > "$NEW_DIR/docs/README.md"
for _doc in modeling.md service.md events.md workflows.md; do
    sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" -e "s|{{SOLO_VERSION}}|$SOLO_VERSION|g" \
        "$SCRIPT_DIR/docs/authoring/$_doc" > "$NEW_DIR/docs/authoring/$_doc"
done
cp "$SCRIPT_DIR/docs/authoring/workflow-examples/"*.json "$NEW_DIR/docs/authoring/workflow-examples/"
log_info "Copied: docs/ (README index + authoring/{modeling,service,events,workflows}.md + $(ls "$SCRIPT_DIR/docs/authoring/workflow-examples/"*.json | wc -l | tr -d ' ') workflow examples)"

# --- 6b. Agent skill: solo-service (the contract, ENFORCED) ---
# The authoring docs (6a) are the readable contract; this Claude Code skill makes it executable.
# A downstream AI editing api/apps/ auto-discovers it: it points at docs/authoring/ + api/sample/,
# states the red lines, and ends on the `autocheck --static` gate — so the contract is checked, not
# just hoped for. Solo-owned + re-templated, so upgrade.sh re-syncs it like the docs pack.
mkdir -p "$NEW_DIR/.claude/skills/solo-service"
sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" -e "s|{{SOLO_VERSION}}|$SOLO_VERSION|g" \
    "$SCRIPT_DIR/.claude/skills/solo-service/SKILL.md" > "$NEW_DIR/.claude/skills/solo-service/SKILL.md"
log_info "Copied: .claude/skills/solo-service (authoring guardrail skill — wraps autocheck)"

# --- 7. Portal & client scaffolds ---

sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" -e "s|{{SOLO_VERSION}}|$SOLO_VERSION|g" \
    "$SCRIPT_DIR/README.portal.md" > "$NEW_DIR/portal/README.md"
sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" -e "s|{{SOLO_VERSION}}|$SOLO_VERSION|g" \
    "$SCRIPT_DIR/README.client.md" > "$NEW_DIR/client/README.md"

# operator portal: copy source (Vite/React) so teams can customize the UI directly.
# Excludes node_modules, dist, and yarn/npm lock files — run `npm install` in the new copy.
rsync -a \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='yarn.lock' \
  --exclude='package-lock.json' \
  "$SOLO_DIR/portal/operator/" "$NEW_DIR/portal/operator/"
log_info "Copied: portal/operator (source — run  npm install  to set up)"

# Browser-extension kit + sample: [Solo]-owned, whole-dir replaced by upgrade.sh.
# The project's OWN extension goes in client/extension/ (never touched); client/plugin/
# is a different thing entirely (desktop-client view plugins). Ship the kit at init so a
# project that later wants an extension already has the upgradeable half in place.
# sample/kit/ is a sync product (gitignored in Solo) — never carry the source tree's copy:
# a fresh Solo clone has none at all, which would ship a silently broken sample. Regenerate
# it from the destination's own lib/ so it is correct regardless of Solo's working-tree state.
rsync -a --exclude='node_modules' --exclude='sample/kit' \
  --exclude='test-results' --exclude='playwright-report' \
  "$SOLO_DIR/client/extension-kit/" "$NEW_DIR/client/extension-kit/"
mkdir -p "$NEW_DIR/client/extension-kit/sample/kit"
cp "$NEW_DIR/client/extension-kit"/lib/*.js "$NEW_DIR/client/extension-kit/sample/kit/"
log_info "Copied: client/extension-kit (Solo-owned kit + runnable sample — your extension goes in client/extension/)"

touch "$NEW_DIR/portal/system/.gitkeep"
touch "$NEW_DIR/client/mobile/.gitkeep"
touch "$NEW_DIR/client/plugin/.gitkeep"
touch "$NEW_DIR/client/extension/.gitkeep"
log_info "Created: portal/README.md, client/README.md (with placeholder subdirs)"

# --- 8. Frontend bundles (build-is-source-of-truth) ---
#
# Frontend artifacts are version-pinned to the Solo bundle (.solo-version), so a
# scaffold must ship the bundle built from the SAME source it ships everything
# else from — not whatever stale tarball happened to be left in portal/publish
# from an older build. So init (re)builds them from current source by default:
#
#   FRONTEND_BUILD=auto  (default) build only if the current-version tarball is missing
#   FRONTEND_BUILD=force            always rebuild all three from source
#   FRONTEND_BUILD=skip             never build (ship whatever current-version tarballs exist)
#
# build-frontend.sh prunes old-version tarballs, so only the current version is
# ever present; step 8b copies that version explicitly (never a glob — a glob
# copied every accumulated version, which is how an old bundle shipped).

FRONTEND_BUILD="${FRONTEND_BUILD:-auto}"
_op_tar="$SOLO_DIR/portal/publish/operator.v${SOLO_VERSION}.tar.gz"
_sy_tar="$SOLO_DIR/portal/publish/system.v${SOLO_VERSION}.tar.gz"
_mo_tar="$SOLO_DIR/client/publish/mobile.v${SOLO_VERSION}.tar.gz"

_need_build=0
case "$FRONTEND_BUILD" in
    force) _need_build=1 ;;
    skip)  _need_build=0 ;;
    auto)  for _t in "$_op_tar" "$_sy_tar" "$_mo_tar"; do [ -f "$_t" ] || _need_build=1; done ;;
    *)     log_error "FRONTEND_BUILD must be auto|force|skip (got: $FRONTEND_BUILD)" ;;
esac

if [ "$_need_build" -eq 1 ]; then
    log_warn "Building frontend bundles from source (FRONTEND_BUILD=$FRONTEND_BUILD)..."
    set +e
    bash "$SOLO_DIR/deploy/build-frontend.sh"
    _fe_build_exit=$?
    set -e
    [ $_fe_build_exit -ne 0 ] && log_error "Frontend build failed — fix the build, or rerun with FRONTEND_BUILD=skip to scaffold without bundles"
fi

# 8b. Copy ONLY the current-version tarballs.
_fe_copied=0
for _pair in "portal/publish:operator" "portal/publish:system" "client/publish:mobile"; do
    _dir="${_pair%%:*}"; _name="${_pair##*:}"
    _src="$SOLO_DIR/$_dir/${_name}.v${SOLO_VERSION}.tar.gz"
    if [ -f "$_src" ]; then
        cp "$_src" "$NEW_DIR/$_dir/"
        _fe_copied=$((_fe_copied+1))
    else
        log_warn "Missing bundle: ${_name}.v${SOLO_VERSION}.tar.gz — rerun with FRONTEND_BUILD=force to build it"
    fi
done
if [ "$_fe_copied" -gt 0 ]; then
    log_info "Copied $_fe_copied/3 frontend bundle(s) (v${SOLO_VERSION}) → portal/publish/ client/publish/"
else
    log_warn "No frontend bundles shipped — set FRONTEND_BUILD=force or run  bash deploy/build-frontend.sh  in Solo"
fi

# --- 9. Deploy scripts ---

cp "$SCRIPT_DIR/run.sh"                "$NEW_DIR/deploy/run.sh"
cp "$SCRIPT_DIR/precheck.sh"           "$NEW_DIR/deploy/precheck.sh"
cp "$SCRIPT_DIR/admin-up.sh"           "$NEW_DIR/deploy/admin-up.sh"
cp "$SCRIPT_DIR/doctor.sh"             "$NEW_DIR/deploy/doctor.sh"
cp "$SCRIPT_DIR/seed-registry.js"      "$NEW_DIR/deploy/seed-registry.js"
# Needed the day a project adds cursor pagination to an EXISTING *.list (docs/authoring/
# service.md §6.5): entities written before the cursor ZSET existed make list({cursor})
# throw until this has run once. Shipping it here so nobody has to hand-write it.
cp "$SCRIPT_DIR/migrate-cursor-index.js" "$NEW_DIR/deploy/migrate-cursor-index.js"
cp "$SCRIPT_DIR/services.json.example" "$NEW_DIR/deploy/services.json"
cp "$SCRIPT_DIR/seed.json"             "$NEW_DIR/deploy/seed.json"
chmod +x "$NEW_DIR/deploy/run.sh" "$NEW_DIR/deploy/precheck.sh" "$NEW_DIR/deploy/admin-up.sh" "$NEW_DIR/deploy/doctor.sh"

# Scan a contiguous free port range for Solo internal services. Each
# scaffolded project gets its own range so two projects on the same machine
# don't collide. services.solo.json is the *which services* template; ports
# in it are ignored and rewritten here.
# 三处端口扫描都靠 lsof;它缺失时 `command not found` 会被吞掉、所有端口判成空闲。
# 与其静默错配,不如当场点破(run.sh 侧已有 lsof/ss 双轨,这里只提醒)。
if ! command -v lsof >/dev/null 2>&1; then
    log_warn "lsof 不存在——下面三处端口扫描将探不到任何占用(全部判空闲)。"
    log_warn "请显式传入 SOLO_PORT_BASE= / FE_PORT_BASE= / REDIS_PORT=,或先装 lsof。"
fi
SOLO_TEMPLATE="$SCRIPT_DIR/services.solo.json"
SOLO_COUNT=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('$SOLO_TEMPLATE','utf8')).length))")
# 与 FE_PORT_BASE 同款可覆盖(见下方 §10 的大段注释——那段推理对本文件三处端口扫描
# 一字不差地成立,此前却只有前端那处开了口子):探测只看"此刻谁在监听",看不到兄弟
# 项目已声明未启动的号段,更看不到"整栈已迁去别的机器、本机只剩声明"的永久空窗
# (2026-08-15 实测:colony/trend 迁走后,scaffold 把它们的 8465-8477 与 6383 判成空闲)。
# 知道答案的人(端口台账)直接传进来:SOLO_PORT_BASE=8520 REDIS_PORT=6385 bash init.sh …
SOLO_PORT_BASE=${SOLO_PORT_BASE:-8400}
while :; do
    _conflict=0
    for ((i=0;i<SOLO_COUNT;i++)); do
        if lsof -i:"$((SOLO_PORT_BASE + i))" &>/dev/null 2>&1; then
            _conflict=1; break
        fi
    done
    [ $_conflict -eq 0 ] && break
    SOLO_PORT_BASE=$((SOLO_PORT_BASE + SOLO_COUNT))
    [ $SOLO_PORT_BASE -gt 9000 ] && log_error "No free $SOLO_COUNT-port range found below 9000"
done
log_info "Solo internal services → ports ${SOLO_PORT_BASE}-$((SOLO_PORT_BASE + SOLO_COUNT - 1)) (runtime probe only — does NOT see other projects' declared-but-idle ranges; cross-check your port ledger, or pass SOLO_PORT_BASE=<n>)"

node -e "
const fs = require('fs');
const template = JSON.parse(fs.readFileSync('$SOLO_TEMPLATE','utf8'));
const base = $SOLO_PORT_BASE;
const out = template.map((s, i) => ({ ...s, port: base + i }));
fs.writeFileSync('$NEW_DIR/deploy/solo-services.json', JSON.stringify(out, null, 2));
"
log_info "Copied: deploy/run.sh, deploy/precheck.sh, deploy/admin-up.sh, deploy/doctor.sh, deploy/seed-registry.js, deploy/migrate-cursor-index.js, deploy/services.json, deploy/seed.json"
log_info "Generated: deploy/solo-services.json (per-project port range, owned by this project)"

# --- 10. .env ---

# Frontend ports (operator/system/mobile): same self-avoidance as the Solo
# internal service range above. Left hardcoded, two projects scaffolded on
# the same machine land on identical defaults — a real collision (multiple
# derived projects ended up sharing 3650/3700, and run.sh's pre-v1.1.14
# "warn only" port handling let it go silently unnoticed for months). Each
# project's own trio still keeps the documented 50-apart spacing
# (operator/system/mobile).
#
# This probe only sees "is anyone listening right now" — it has no way to see
# a sibling project's declared-but-not-yet-started port (its .env exists but
# the stack isn't up). Port allocation across projects on one machine needs a
# global view this script structurally can't have; the port ledger
# (overview/mind/ref/ports.md) is that global view. So: allow the caller to
# hand in the answer directly (FE_PORT_BASE=3640 bash init.sh ...), same
# convention as FRONTEND_BUILD. And retry in steps of 10 rather than 150 — a
# 150 stride only ever lands on 3600/3750/3900/4050/…, skipping every
# in-between slot the ledger might actually have free (e.g. 3640/3690/3740).
FE_PORT_BASE=${FE_PORT_BASE:-3600}
while :; do
    _fe_conflict=0
    for _off in 0 50 100; do
        lsof -i:"$((FE_PORT_BASE + _off))" &>/dev/null 2>&1 && { _fe_conflict=1; break; }
    done
    [ $_fe_conflict -eq 0 ] && break
    FE_PORT_BASE=$((FE_PORT_BASE + 10))
    [ $FE_PORT_BASE -gt 5000 ] && log_error "No free frontend port trio found below 5000"
done
PORTAL_OPERATOR_PORT=$FE_PORT_BASE
PORTAL_SYSTEM_PORT=$((FE_PORT_BASE + 50))
CLIENT_MOBILE_PORT=$((FE_PORT_BASE + 100))
log_info "Frontend ports: operator=$PORTAL_OPERATOR_PORT system=$PORTAL_SYSTEM_PORT mobile=$CLIENT_MOBILE_PORT (auto-selected by runtime probe — does NOT check other projects' .env declarations; cross-check your port ledger, or pass FE_PORT_BASE=<n> to pick explicitly)"

# Find an available Redis port starting from 6380 — overridable, same reasoning as
# SOLO_PORT_BASE/FE_PORT_BASE above (a sibling's declared-but-idle Redis port scans as free).
REDIS_PORT=${REDIS_PORT:-6380}
while lsof -i:"$REDIS_PORT" &>/dev/null 2>&1; do
    REDIS_PORT=$((REDIS_PORT + 1))
done
log_info "Redis port: $REDIS_PORT (runtime probe only — does NOT see declared-but-idle ports; cross-check your port ledger, or pass REDIS_PORT=<n>)"

# This heredoc is intentionally unquoted (`<< EOF`, not `<< 'EOF'`) — it interpolates
# $REDIS_PASSWORD/$JWT_SECRET/$ROUTER_PUBLIC_KEY/$PROJECT_NAME/the three frontend port
# vars. That means any backtick or $(...) in the template body below gets executed as a
# command substitution (silently — exit code stays 0, only stderr shows `command not
# found`, and the substituted text quietly comes out empty). Escape backticks as \` and
# don't write bare $(...) in comments.
cat > "$NEW_DIR/.env" << EOF
# Solo Core
# Redis 带口令（run.sh 起 redis 时 --requirepass；改/删密码要与 redis_data 里已持久化的
# 实例一致，否则连不上）。REDIS_PASSWORD 单独一行给 run.sh / redis-cli(REDISCLI_AUTH) 用。
REDIS_URL=redis://:$REDIS_PASSWORD@127.0.0.1:$REDIS_PORT
REDIS_PASSWORD=$REDIS_PASSWORD
JWT_SECRET=$JWT_SECRET

# CORS（生产建议设置）：不设 = 全开（dev 行为）；none = 拒绝所有跨域；
# 或逗号分隔的精确 origin 白名单。全部服务经 library/cors.js 统一吃这一个开关。
# CORS_ORIGINS=https://yourapp.example.com

# 🔴 监听网卡（挂公网/局域网前务必看一眼）：不设 = 每个服务绑**所有网卡**（Node 默认，
# 也是历史行为）。也就是说这台机器的任何一个可达 IP 上，Router、user（账号）、storage
# 都是能连的——本机开发无感，一旦机器有公网网卡就等于全部对外。
# 设成 127.0.0.1 = 全部只听本机（反向代理同机时的推荐姿态）；要单独放行某个服务，
# 用 <服务名大写>_BIND_ADDR 覆盖，或在 deploy/services.json 里给该 app 写 env（见下）：
#   BIND_ADDR=127.0.0.1
#   CODER_BIND_ADDR=0.0.0.0
# services.json 的等价写法（只对私有 app 生效，跟着 git 走、不依赖机器上的防火墙规则）：
#   { "name": "coder", "path": "apps/coder/index.js", "port": 8422,
#     "env": { "BIND_ADDR": "0.0.0.0" } }
# BIND_ADDR=127.0.0.1

# Router Identity
SOLO_KEYPAIR_PATH=$NEW_DIR/.keypair
ROUTER_PUBLIC_KEY=$ROUTER_PUBLIC_KEY

# Router 静态资源（走 OSS，关闭本地文件服务）
ENABLE_STATIC_ASSETS=false

# Frontend servers (run.sh serves pre-built bundles from portal/publish & client/publish)
PORTAL_OPERATOR_PORT=$PORTAL_OPERATOR_PORT
PORTAL_SYSTEM_PORT=$PORTAL_SYSTEM_PORT
CLIENT_MOBILE_PORT=$CLIENT_MOBILE_PORT

# 自有前端（源码形态，v1.1.16+）：声明即接入，不用改 run.sh（它属只读区，改了会被
# upgrade 覆盖）。目录相对项目根；缺 dist/ 自动 npm install + npm run build；
# config.js 注入与 tarball 前端同源；端口守卫同款（占用 fail fast）。
# 更复杂的启动逻辑放 deploy/frontends.local.sh（不随 bundle 下发、upgrade 永不覆盖）。
# FRONTEND_MYAPP_DIR=client/myapp
# FRONTEND_MYAPP_PORT=3790

# 门户品牌（可选，v1.1.13+）：system/operator 侧边栏与登录页标题、system Overview 说明卡。
# 多实例同时打开时用来一眼分清是哪个部署；不配 = 显示通用文案。
# SYSTEM_DISPLAY_NAME=$PROJECT_NAME
# SYSTEM_DESCRIPTION=

# --- Outbound gateway (gateway service) ---

# 加密 SMTP 账号密码用（gateway.smtp.* 的前置条件，已随机生成）。
# ⚠️ 换掉它 = 存量 SMTP 账号密码解不开（需重新录入），不要随手改。
GATEWAY_SECRET_KEY=$GATEWAY_SECRET_KEY

# --- Object storage (storage service) ---

# provider=local（默认）时字节由 storage 进程内挂载的对象存储提供（无独立端口、
# 无独立进程；端口就是 storage 自己的，路径 /_oss）。本密钥同时是签名 URL 的 HMAC
# 密钥与 Bearer 令牌，已随机生成——⚠️ 换掉它 = 存量签名 URL 立即失效（字节本身不受影响）。
# 要把对象存储放到独立进程/独立机器：起 deploy/local-oss.js 并设 LOCAL_OSS_ENDPOINT
# （设了它就不再进程内挂载）。生产上云走 STORAGE_PROVIDER=aliyun + OSS_* 那组。
LOCAL_OSS_SECRET='$LOCAL_OSS_SECRET'

# Email —— channel: auto | smtp | api | mock
# auto = api if EMAIL_API_KEY set, smtp if EMAIL_SMTP_HOST set, else mock
# ⚠️ 落到 mock = 什么都没真发出去（返回 provider:'mock' + 随机 messageId）。
# EMAIL_CHANNEL=auto
# EMAIL_FROM=noreply@example.com
#
# SMTP channel（也可不配这里，改用 gateway.smtp.create 建多账号、发送时传 smtpId）:
# 换邮箱厂商只改下面三行即可，不需要写任何适配器 —— SMTP 是标准协议，各家说同一套话。
#   Gmail   smtp.gmail.com   587 + SECURE=false（或 465 + true）
#   163     smtp.163.com     465 + SECURE=true
#   QQ      smtp.qq.com      465 + SECURE=true
#   Outlook smtp.office365.com 587 —— 基本认证已被微软停用，只剩 OAuth2，当前不支持
# EMAIL_SMTP_HOST=smtp.example.com
# EMAIL_SMTP_PORT=587
# EMAIL_SMTP_SECURE=false
# EMAIL_SMTP_USER=user@example.com
#
# ⚠️ PASS 多半不是你的登录密码：Gmail 要"应用专用密码"（须先开两步验证），
#    163/QQ 要"授权码"（在邮箱设置里单独开 SMTP 服务）。填错的报错是
#    535-5.7.8 Username and Password not accepted —— 它和"密码失效""被风控"
#    完全同一个症状，不指向具体哪里错。
#    Gmail 的应用专用密码全是小写字母，抄的时候当心 l(小写L) / I(大写i) / 1 同形。
# EMAIL_SMTP_PASS=应用专用密码或授权码
#
# 可选：透传给 nodemailer 的其余 transport 选项（JSON 对象，解析失败会当场报错）。
# 用于 host/port/secure 表达不了的开关：requireTLS、tls 的 rejectUnauthorized/ciphers、
# pool + rateLimit（各家限速不同）、name（EHLO 名）、各类 timeout。
# ⚠️ 它覆盖不了 host/port/secure/auth —— 显式字段永远优先（安全边界）。
# ⚠️ 必须用单引号包住：本文件有两类消费者，run.sh 走 shell source 会把裸值里的双引号
#    剥掉（变成 {requireTLS:true}，不再是合法 JSON），而 dotenv 不会 —— 两边解析不一致。
#    加单引号后两条路拿到的都是原样 JSON。
# EMAIL_SMTP_OPTIONS='{"requireTLS":true}'
#
# HTTP API channel —— body 形状 = Resend 兼容（{from,to,subject,text,html}）。
# 这里与 SMTP 相反：每家 body 形状不兼容，SendGrid / SES 需要在 logic/email.js 的
# API_PROVIDERS 加适配器并设 EMAIL_API_PROVIDER，光改 URL 不通。
# EMAIL_API_KEY=re_xxxx
# EMAIL_API_URL=https://api.resend.com/emails
# EMAIL_API_PROVIDER=resend

# SMS —— channel: auto | aliyun | twilio | mock
# auto = aliyun if SMS_ALIYUN_KEY_ID set, twilio if SMS_TWILIO_SID set, else mock
# ⚠️ 短信只能套模版：先 gateway.sms.template.create 建模版，providerCode 必须是
#    提供商侧已审批的模版码；随手发自由文本会被运营商拒。
# SMS_CHANNEL=auto
#
# 阿里云（签名走 ACS3-HMAC-SHA256，无需装官方 SDK）:
# SMS_ALIYUN_KEY_ID=LTAI_xxxx
# SMS_ALIYUN_KEY_SECRET=xxxx
# SMS_ALIYUN_SIGN_NAME=YourSignName
# SMS_ALIYUN_ENDPOINT=https://dysmsapi.aliyuncs.com
#
# Twilio（providerCode = Content SID \`HXxxxx\`；模版实体建议同时声明 variableOrder，
#         否则命名变量无法映射成 Twilio 要求的位置键 {"1":…}）:
# SMS_TWILIO_SID=ACxxxx
# SMS_TWILIO_TOKEN=xxxx
# SMS_TWILIO_FROM=+15551234567

# Optional
# LOG_LEVEL=info
# NODE_ENV=production
EOF
log_info "Created: .env"

# --- 11. E2E test framework ---
#
# Copies the e2e skeleton (jest + redis, no SOLO source dependency) into the
# new project.  Run `npm install` inside e2e/ then `npm test` against a running
# stack.  suites/00-sample.e2e.test.js is the starting template.

mkdir -p "$NEW_DIR/e2e"
find "$SCRIPT_DIR/e2e" -type f | while IFS= read -r f; do
    relpath="${f#$SCRIPT_DIR/e2e/}"
    destdir="$NEW_DIR/e2e/$(dirname "$relpath")"
    mkdir -p "$destdir"
    sed "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" "$f" > "$NEW_DIR/e2e/$relpath"
done
log_info "Copied: e2e/ (harness + lib + sample suite — cd e2e && npm install)"

# --- 11b. UI E2E (Playwright — operator portal) ---
#
# The operator portal source ships into portal/operator/ (step 7) for teams to customize, so a
# Playwright smoke starter ships alongside it. Lands at e2e/ui/ (mirrors SOLO's own e2e/ui layout).
mkdir -p "$NEW_DIR/e2e/ui"
find "$SCRIPT_DIR/e2e-ui" -type f \
     -not -path '*/node_modules/*' -not -path '*/playwright-report/*' -not -path '*/test-results/*' \
     | while IFS= read -r f; do
    relpath="${f#$SCRIPT_DIR/e2e-ui/}"
    mkdir -p "$NEW_DIR/e2e/ui/$(dirname "$relpath")"
    sed "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" "$f" > "$NEW_DIR/e2e/ui/$relpath"
done
log_info "Copied: e2e/ui/ (Playwright operator smoke — cd e2e/ui && npm install && npx playwright install chromium)"

# --- 12. package.json (root, with npm deps for private apps) ---

sed "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" "$SCRIPT_DIR/package.json" > "$NEW_DIR/package.json"
log_info "Created: package.json (npm install will run on first start)"

# --- 13. .gitignore ---

cp "$SCRIPT_DIR/.gitignore" "$NEW_DIR/.gitignore"
log_info "Copied: .gitignore"

# --- 14. SETUP.md — one-time credential reference ---

CREATED_AT=$(date '+%Y-%m-%d %H:%M:%S')

sed \
  -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" \
  -e "s|{{CREATED_AT}}|$CREATED_AT|g" \
  -e "s|{{ADMIN_USER}}|$ADMIN_USER|g" \
  -e "s|{{ADMIN_PASS}}|$ADMIN_PASS|g" \
  -e "s|{{ROUTER_PUBLIC_KEY}}|$ROUTER_PUBLIC_KEY|g" \
  -e "s|{{SOLO_VERSION}}|$SOLO_VERSION|g" \
  "$SCRIPT_DIR/SETUP.template.md" > "$NEW_DIR/SETUP.md"

log_info "Created: SETUP.md (credentials reference — keep safe, do not commit)"

# --- 15. Git init ---

git -C "$NEW_DIR" init -q
git -C "$NEW_DIR" add \
  api/publish/ api/autocheck/ api/library/ api/sample/ api/apps/ \
  docs/ .claude/ \
  deploy/ \
  portal/ client/ \
  e2e/ \
  package.json .solo-version .gitignore
git -C "$NEW_DIR" commit -q -m "chore: init $PROJECT_NAME scaffold (Solo v$SOLO_VERSION)"
log_info "Git repo initialized with initial commit"

# Self-check: the deploy/ files this step just added are enumerated by hand at
# copy-time (line ~277-279) and here separately — nothing guarantees the two
# lists stay in sync (that's exactly how deploy/seed-registry.js went missing
# for one release: copied but never added, so it worked on the scaffolding
# machine and vanished on clone). Catch any future drift immediately instead
# of silently shipping a broken clone.
_untracked=$(git -C "$NEW_DIR" status --porcelain --untracked-files=all)
if [ -n "$_untracked" ]; then
    log_warn "Untracked files remain after initial commit (check if they should have been added):"
    echo "$_untracked"
fi

# --- Done ---

echo ""
log_info "Scaffold ready: $NEW_DIR"
echo ""
printf "${YELLOW}  !! Review SETUP.md for initial credentials before starting services !!${NC}\n"
echo ""
echo "Next steps:"
echo "  1. cd $NEW_DIR"
echo "  2. 端口核对（上面三处自动分配只看运行时监听，看不到别家 .env / solo-services.json 的声明，"
echo "     整栈迁去别的机器后本机遗留的声明更是永久盲区）："
echo "       Solo 内部 ${SOLO_PORT_BASE}-$((SOLO_PORT_BASE + SOLO_COUNT - 1)) · 前端 ${PORTAL_OPERATOR_PORT}/${PORTAL_SYSTEM_PORT}/${CLIENT_MOBILE_PORT} · Redis ${REDIS_PORT}"
echo "     → 与端口台账对一遍；要改：deploy/solo-services.json（Solo 内部）与 .env（前端端口/REDIS_URL）"
echo "  3. bash deploy/run.sh"
echo "  4. Log in, call admin.password.reset, then delete SETUP.md"
echo ""
echo "Operator portal:"
echo "  cd $NEW_DIR/portal/operator && npm install && npm run dev"
echo ""
echo "E2E tests (after stack is running):"
echo "  API:  cd $NEW_DIR/e2e && npm install && npm test"
echo "  UI:   cd $NEW_DIR/e2e/ui && npm install && npx playwright install chromium && npm test  (serve portal/operator first)"
