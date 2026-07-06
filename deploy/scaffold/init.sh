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

KEYPAIR_JSON=$(node -e "
const { Keypair } = require('$SOLO_DIR/api/node_modules/@solana/web3.js');
const kp = Keypair.generate();
process.stdout.write(JSON.stringify({
  pub: kp.publicKey.toBase58(),
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
for _doc in service.md events.md workflows.md; do
    sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" -e "s|{{SOLO_VERSION}}|$SOLO_VERSION|g" \
        "$SCRIPT_DIR/docs/authoring/$_doc" > "$NEW_DIR/docs/authoring/$_doc"
done
cp "$SCRIPT_DIR/docs/authoring/workflow-examples/"*.json "$NEW_DIR/docs/authoring/workflow-examples/"
log_info "Copied: docs/ (README index + authoring/{service,events,workflows}.md + $(ls "$SCRIPT_DIR/docs/authoring/workflow-examples/"*.json | wc -l | tr -d ' ') workflow examples)"

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

touch "$NEW_DIR/portal/system/.gitkeep"
touch "$NEW_DIR/client/mobile/.gitkeep"
touch "$NEW_DIR/client/plugin/.gitkeep"
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
cp "$SCRIPT_DIR/seed-registry.js"      "$NEW_DIR/deploy/seed-registry.js"
cp "$SCRIPT_DIR/services.json.example" "$NEW_DIR/deploy/services.json"
cp "$SCRIPT_DIR/seed.json"             "$NEW_DIR/deploy/seed.json"
chmod +x "$NEW_DIR/deploy/run.sh" "$NEW_DIR/deploy/precheck.sh" "$NEW_DIR/deploy/admin-up.sh"

# Scan a contiguous free port range for Solo internal services. Each
# scaffolded project gets its own range so two projects on the same machine
# don't collide. services.solo.json is the *which services* template; ports
# in it are ignored and rewritten here.
SOLO_TEMPLATE="$SCRIPT_DIR/services.solo.json"
SOLO_COUNT=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('$SOLO_TEMPLATE','utf8')).length))")
SOLO_PORT_BASE=8400
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
log_info "Solo internal services → ports ${SOLO_PORT_BASE}-$((SOLO_PORT_BASE + SOLO_COUNT - 1)) (auto-selected, contiguous free range)"

node -e "
const fs = require('fs');
const template = JSON.parse(fs.readFileSync('$SOLO_TEMPLATE','utf8'));
const base = $SOLO_PORT_BASE;
const out = template.map((s, i) => ({ ...s, port: base + i }));
fs.writeFileSync('$NEW_DIR/deploy/solo-services.json', JSON.stringify(out, null, 2));
"
log_info "Copied: deploy/run.sh, deploy/precheck.sh, deploy/admin-up.sh, deploy/seed-registry.js, deploy/services.json, deploy/seed.json"
log_info "Generated: deploy/solo-services.json (per-project port range, owned by this project)"

# --- 10. .env ---

# Find an available Redis port starting from 6380
REDIS_PORT=6380
while lsof -i:"$REDIS_PORT" &>/dev/null 2>&1; do
    REDIS_PORT=$((REDIS_PORT + 1))
done
log_info "Redis port: $REDIS_PORT (auto-selected, not currently in use)"

cat > "$NEW_DIR/.env" << EOF
# Solo Core
REDIS_URL=redis://127.0.0.1:$REDIS_PORT
JWT_SECRET=$JWT_SECRET

# Router Identity
SOLO_KEYPAIR_PATH=$NEW_DIR/.keypair
ROUTER_PUBLIC_KEY=$ROUTER_PUBLIC_KEY

# Router 静态资源（走 OSS，关闭本地文件服务）
ENABLE_STATIC_ASSETS=false

# Frontend servers (run.sh serves pre-built bundles from portal/publish & client/publish)
PORTAL_OPERATOR_PORT=3600
PORTAL_SYSTEM_PORT=3650
CLIENT_MOBILE_PORT=3700

# Email Gateway (gateway service)
# channel: auto | smtp | api | mock  (auto = api if key set, smtp if host set, else mock)
# EMAIL_CHANNEL=auto
# EMAIL_FROM=noreply@example.com
#
# SMTP channel:
# EMAIL_SMTP_HOST=smtp.example.com
# EMAIL_SMTP_PORT=587
# EMAIL_SMTP_SECURE=false
# EMAIL_SMTP_USER=user@example.com
# EMAIL_SMTP_PASS=yourpassword
#
# HTTP API channel (Resend by default; set EMAIL_API_URL for other providers):
# EMAIL_API_KEY=re_xxxx
# EMAIL_API_URL=https://api.resend.com/emails

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
  deploy/run.sh deploy/precheck.sh deploy/admin-up.sh deploy/services.json deploy/solo-services.json deploy/seed.json \
  portal/ client/ \
  e2e/ \
  package.json .solo-version .gitignore
git -C "$NEW_DIR" commit -q -m "chore: init $PROJECT_NAME scaffold (Solo v$SOLO_VERSION)"
log_info "Git repo initialized with initial commit"

# --- Done ---

echo ""
log_info "Scaffold ready: $NEW_DIR"
echo ""
printf "${YELLOW}  !! Review SETUP.md for initial credentials before starting services !!${NC}\n"
echo ""
echo "Next steps:"
echo "  1. cd $NEW_DIR"
echo "  2. Confirm REDIS_URL in .env"
echo "  3. bash deploy/run.sh"
echo "  4. Log in, call admin.password.reset, then delete SETUP.md"
echo ""
echo "Operator portal:"
echo "  cd $NEW_DIR/portal/operator && npm install && npm run dev"
echo ""
echo "E2E tests (after stack is running):"
echo "  API:  cd $NEW_DIR/e2e && npm install && npm test"
echo "  UI:   cd $NEW_DIR/e2e/ui && npm install && npx playwright install chromium && npm test  (serve portal/operator first)"
