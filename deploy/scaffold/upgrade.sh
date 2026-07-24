#!/bin/bash
#
# Solo Scaffold Upgrade
#
# Upgrades an EXISTING Solo-scaffolded project's [Solo] artifacts to the current
# Solo version, leaving [Project] files untouched. This is the scripted form of
# docs/runbook/upgrade-v1.0-to-v1.1.md §1 (mechanical replace) + the frontend
# bundle step. Run from INSIDE the Solo source directory.
#
# Usage:
#   bash deploy/scaffold/upgrade.sh <project-dir> [--dry-run] [--force-scripts]
#
# Env:
#   FRONTEND_BUILD=auto|force|skip   (default auto) — same semantics as init.sh:
#       auto  build system+mobile tarballs only if the current-version one is missing
#       force always rebuild   |   skip never build (ship existing current-version tarballs)
#
# Overwrites ([Solo]-owned, whole-artifact replace):
#   api/publish/solo.v{ver}.js   .solo-version
#   api/library  api/sample  api/autocheck      (whole-dir replace)
#   docs/  (README index + authoring/{service,events,workflows}.md + workflow-examples/)
#       (version-pinned authoring contracts — re-templated, engine-accurate; stale = wrong.
#        Pre-docs/ projects' old api/AUTHORING.*.md + workflows/ are migrated here and removed.)
#   .claude/skills/solo-service/SKILL.md   (Solo-owned authoring guardrail skill — re-templated)
#   portal/publish/system.v{ver}.tar.gz   client/publish/mobile.v{ver}.tar.gz
#       (stale-version tarballs of these two pruned first)
#
# NEVER touches ([Project]-owned):
#   .env  .keypair  api/seed.json  api/apps/  portal/operator/  client/plugin/
#   deploy/services.json  deploy/solo-services.json  deploy/seed.json  e2e/
#   portal/publish/operator.*.tar.gz  (operator is source-distributed — team's)
#
# [Solo->Project] deploy scripts (run.sh precheck.sh admin-up.sh seed-registry.js):
#   DETECTED, not blindly overwritten. If the project's copy diverges from stock
#   (i.e. the team customized it, like wavely's run.sh), the new stock is staged
#   alongside as <name>.solo-{ver}.new for a manual diff — the live file is left
#   alone. A missing file (e.g. seed-registry.js on a v1.0 project) is added.
#   --force-scripts overwrites diverged scripts with stock (use with care).
#
set -euo pipefail

# --- Args ---
if [ -z "${1:-}" ]; then
    echo "Usage: bash deploy/scaffold/upgrade.sh <project-dir> [--dry-run] [--force-scripts]"
    exit 1
fi
PROJ_ARG="$1"; shift
DRY=0; FORCE_SCRIPTS=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)       DRY=1 ;;
        --force-scripts) FORCE_SCRIPTS=1 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
    shift
done

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SOLO_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log_info()  { printf "${GREEN}✓ %s${NC}\n" "$1"; }
log_warn()  { printf "${YELLOW}⚠ %s${NC}\n" "$1"; }
log_step()  { printf "${CYAN}▸ %s${NC}\n" "$1"; }
log_error() { printf "${RED}✗ %s${NC}\n" "$1"; exit 1; }

# --- 1. Detect: is the target an upgradable Solo-scaffolded project? ---
PROJ="$( cd "$PROJ_ARG" 2>/dev/null && pwd )" || log_error "Project dir not found: $PROJ_ARG"
[ "$PROJ" = "$SOLO_DIR" ] && log_error "Refusing to run against the Solo source repo itself"
[ -f "$PROJ/.solo-version" ] || log_error "$PROJ has no .solo-version — not a Solo-scaffolded project (use init.sh for new projects)"
{ [ -d "$PROJ/api/publish" ] && [ -d "$PROJ/deploy" ]; } || log_error "$PROJ missing api/publish or deploy — not a Solo-scaffolded project"

OLD_VER="$(tr -d '[:space:]' < "$PROJ/.solo-version")"
SOLO_VERSION="$(node -e "console.log(require('$SOLO_DIR/package.json').version)" 2>/dev/null)" || log_error "cannot read Solo package.json version"
NEW_VER="v${SOLO_VERSION}"

echo "Solo Scaffold Upgrade"
echo "====================="
echo "  project    : $PROJ"
echo "  .solo-version : $OLD_VER  →  $NEW_VER"
[ $DRY -eq 1 ] && echo "  mode       : DRY-RUN (no writes)"
echo ""
if [ "$OLD_VER" = "$NEW_VER" ]; then
    log_warn "Already on $NEW_VER — re-syncing artifacts anyway (catches stale-bundle drift, e.g. .solo-version says $NEW_VER but tarballs are older)."
fi

REPORT=()       # human report lines
DIVERGED=0      # any [Solo->Project] script diverged?

# --- 2. Build [Solo] artifacts fresh ---
# bundle
if [ $DRY -eq 0 ]; then
    log_step "Building Solo bundle (deploy/build.sh)..."
    BUILD_LOG="$(mktemp)"
    set +e; bash "$SOLO_DIR/deploy/build.sh" > "$BUILD_LOG" 2>&1; bx=$?; set -e
    if [ $bx -ne 0 ]; then tail -25 "$BUILD_LOG"; rm -f "$BUILD_LOG"; log_error "Bundle build failed — project not modified"; fi
    rm -f "$BUILD_LOG"
    log_info "Bundle built (api/publish/solo.js)"
else
    log_step "[dry-run] would build deploy/build.sh"
fi

# frontend tarballs (system + mobile; operator is source-distributed)
FRONTEND_BUILD="${FRONTEND_BUILD:-auto}"
_sy="$SOLO_DIR/portal/publish/system.v${SOLO_VERSION}.tar.gz"
_mo="$SOLO_DIR/client/publish/mobile.v${SOLO_VERSION}.tar.gz"
_need_build=0
case "$FRONTEND_BUILD" in
    force) _need_build=1 ;;
    skip)  _need_build=0 ;;
    auto)  for _t in "$_sy" "$_mo"; do [ -f "$_t" ] || _need_build=1; done ;;
    *)     log_error "FRONTEND_BUILD must be auto|force|skip (got: $FRONTEND_BUILD)" ;;
esac
if [ "$_need_build" -eq 1 ]; then
    if [ $DRY -eq 0 ]; then
        log_step "Building frontend bundles (deploy/build-frontend.sh, FRONTEND_BUILD=$FRONTEND_BUILD)..."
        set +e; bash "$SOLO_DIR/deploy/build-frontend.sh" >/dev/null 2>&1; fx=$?; set -e
        [ $fx -ne 0 ] && log_error "Frontend build failed — fix it, or rerun with FRONTEND_BUILD=skip"
        log_info "Frontend bundles built"
    else
        log_step "[dry-run] would build deploy/build-frontend.sh (current-version tarball missing)"
    fi
fi

# --- 3. Replace [Solo]-owned files in the project ---
log_step "Replacing [Solo] artifacts in project..."

# 3a. bundle + version marker (prune older bundles after the new one lands)
if [ $DRY -eq 0 ]; then
    cp "$SOLO_DIR/api/publish/solo.js" "$PROJ/api/publish/solo.v${SOLO_VERSION}.js"
    echo "$NEW_VER" > "$PROJ/.solo-version"
    find "$PROJ/api/publish" -maxdepth 1 -name 'solo.v*.js' ! -name "solo.v${SOLO_VERSION}.js" -delete 2>/dev/null || true
fi
REPORT+=("bundle      → api/publish/solo.v${SOLO_VERSION}.js  + .solo-version=$NEW_VER")

# 3b. whole-dir replace of the shared source libs (rm+cp so upstream deletions propagate)
for d in library sample autocheck; do
    if [ -d "$SOLO_DIR/api/$d" ]; then
        if [ $DRY -eq 0 ]; then
            rm -rf "$PROJ/api/$d"
            cp -r "$SOLO_DIR/api/$d" "$PROJ/api/$d"
        fi
        REPORT+=("source dir  → api/$d/  (whole-dir replace)")
    fi
done

# 3d. Authoring / contract docs pack (docs/) — version-pinned, engine-accurate; re-template + replace.
#     Distilled contracts that track the execution engine, so a stale copy is WRONG; re-sync the
#     WHOLE docs/ pack every upgrade. PROJECT_NAME is derived from the project to re-apply the
#     {{PROJECT_NAME}} substitution (package.json name, else dir basename).
PROJECT_NAME="$(node -e "try{process.stdout.write(String(require('$PROJ/package.json').name||''))}catch(e){}" 2>/dev/null || true)"
[ -z "$PROJECT_NAME" ] && PROJECT_NAME="$(basename "$PROJ")"
if [ $DRY -eq 0 ]; then
    mkdir -p "$PROJ/docs/authoring/workflow-examples"
    sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" -e "s|{{SOLO_VERSION}}|$SOLO_VERSION|g" \
        "$SCRIPT_DIR/docs/README.md" > "$PROJ/docs/README.md"
    for _doc in service.md events.md workflows.md; do
        sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" -e "s|{{SOLO_VERSION}}|$SOLO_VERSION|g" \
            "$SCRIPT_DIR/docs/authoring/$_doc" > "$PROJ/docs/authoring/$_doc"
    done
    cp "$SCRIPT_DIR/docs/authoring/workflow-examples/"*.json "$PROJ/docs/authoring/workflow-examples/"
fi
REPORT+=("authoring   → docs/ (README + authoring/{service,events,workflows}.md + examples)  (version-pinned)")

# 3d-migrate. Pre-docs/ projects shipped these Solo-owned authoring files at api/AUTHORING.*.md
#     and workflows/. Now consolidated under docs/ (above), so upgrade would otherwise leave the
#     OLD copies behind to rot (never re-synced again). Remove ONLY the files Solo itself shipped
#     — never a whole dir (a team may have added their own workflows/); rmdir only if left empty.
_migrated=0
for _old in "api/AUTHORING.service.md" "api/AUTHORING.events.md" "workflows/AUTHORING.md" \
            "workflows/examples/01-sync-minimal.json" "workflows/examples/02-sync-multistep-condition.json" \
            "workflows/examples/03-event-webhook.json"; do
    if [ -e "$PROJ/$_old" ]; then
        if [ $DRY -eq 0 ]; then rm -f "$PROJ/$_old"; fi
        _migrated=1
    fi
done
if [ $_migrated -eq 1 ]; then
    if [ $DRY -eq 0 ]; then rmdir "$PROJ/workflows/examples" "$PROJ/workflows" 2>/dev/null || true; fi
    REPORT+=("authoring   ⤳ migrated old api/AUTHORING.*.md + workflows/ → docs/ (stale copies removed)")
fi

# 3e. Agent skill (solo-service) — Solo-owned authoring guardrail; re-template + replace like the
#     docs pack (it points at docs/authoring + api/sample and wraps the autocheck gate, so a stale
#     copy would teach the old contract). PROJECT_NAME reused from 3d above.
if [ $DRY -eq 0 ]; then
    mkdir -p "$PROJ/.claude/skills/solo-service"
    sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" -e "s|{{SOLO_VERSION}}|$SOLO_VERSION|g" \
        "$SCRIPT_DIR/.claude/skills/solo-service/SKILL.md" > "$PROJ/.claude/skills/solo-service/SKILL.md"
fi
REPORT+=("skill       → .claude/skills/solo-service/SKILL.md  (version-pinned)")

# 3c. frontend tarballs: system + mobile, pinned to current version, stale pruned.
#     operator is source-distributed (team owns portal/operator/) → never touched.
_fe_pairs=("portal/publish:system:$_sy" "client/publish:mobile:$_mo")
for _p in "${_fe_pairs[@]}"; do
    _dir="${_p%%:*}"; _rest="${_p#*:}"; _name="${_rest%%:*}"; _src="${_rest#*:}"
    if [ -f "$_src" ]; then
        if [ $DRY -eq 0 ]; then
            mkdir -p "$PROJ/$_dir"
            rm -f "$PROJ/$_dir/${_name}.v"*.tar.gz
            cp "$_src" "$PROJ/$_dir/"
        fi
        REPORT+=("frontend    → $_dir/${_name}.v${SOLO_VERSION}.tar.gz  (stale ${_name}.v* pruned)")
    else
        REPORT+=("frontend    ⚠ MISSING ${_name}.v${SOLO_VERSION}.tar.gz in Solo — rerun with FRONTEND_BUILD=force")
    fi
done

# --- 4. [Solo->Project] deploy scripts: detect divergence, don't clobber ---
log_step "Checking [Solo→Project] deploy scripts..."
for s in run.sh precheck.sh admin-up.sh seed-registry.js; do
    stock="$SCRIPT_DIR/$s"; proj="$PROJ/deploy/$s"
    [ -f "$stock" ] || continue
    if [ ! -f "$proj" ]; then
        if [ $DRY -eq 0 ]; then cp "$stock" "$proj"; case "$s" in *.sh) chmod +x "$proj";; esac; fi
        REPORT+=("script      + deploy/$s  (was missing — added stock)")
    elif cmp -s "$stock" "$proj"; then
        REPORT+=("script      = deploy/$s  (already stock, unchanged)")
    elif [ $FORCE_SCRIPTS -eq 1 ]; then
        if [ $DRY -eq 0 ]; then cp "$stock" "$proj"; case "$s" in *.sh) chmod +x "$proj";; esac; fi
        REPORT+=("script      ! deploy/$s  (DIVERGED — force-replaced with stock)")
        DIVERGED=1
    else
        if [ $DRY -eq 0 ]; then cp "$stock" "$proj.solo-${NEW_VER}.new"; fi
        REPORT+=("script      ! deploy/$s  (DIVERGED — NOT overwritten; stock staged as deploy/$s.solo-${NEW_VER}.new)")
        DIVERGED=1
    fi
done

# --- 5. Report ---
echo ""
echo "Changes:"
for line in "${REPORT[@]}"; do echo "   • $line"; done
echo ""
echo "Left untouched ([Project]-owned): .env .keypair api/seed.json api/apps/ portal/operator/"
echo "   client/plugin/ deploy/services.json deploy/solo-services.json deploy/seed.json e2e/"

# --- 6. Post-upgrade self-check (only when actually written) ---
if [ $DRY -eq 0 ]; then
    echo ""
    log_step "Post-upgrade self-check..."
    fail=0
    NOW_VER="$(tr -d '[:space:]' < "$PROJ/.solo-version")"
    [ "$NOW_VER" = "$NEW_VER" ] && log_info ".solo-version = $NEW_VER" || { log_warn ".solo-version is $NOW_VER, expected $NEW_VER"; fail=1; }
    [ -f "$PROJ/api/publish/solo.v${SOLO_VERSION}.js" ] && log_info "bundle solo.v${SOLO_VERSION}.js present" || { log_warn "bundle solo.v${SOLO_VERSION}.js MISSING"; fail=1; }
    # frontend version consistency: the only system/mobile tarball present must match .solo-version
    for pair in "portal/publish:system" "client/publish:mobile"; do
        d="${pair%%:*}"; n="${pair##*:}"
        got=$(ls "$PROJ/$d/${n}.v"*.tar.gz 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ')
        if [ -z "$got" ]; then
            log_warn "$n: no tarball present (run.sh will skip/serve nothing for it)"
        elif [ "$got" = "${n}.v${SOLO_VERSION}.tar.gz " ]; then
            log_info "$n: ${n}.v${SOLO_VERSION}.tar.gz (matches .solo-version, no stale)"
        else
            log_warn "$n: version mismatch / stale present → [$got] (expected only ${n}.v${SOLO_VERSION}.tar.gz)"; fail=1
        fi
    done
    [ $fail -eq 0 ] && log_info "Self-check passed" || log_warn "Self-check found issues (above)"
fi

# --- 6b. Surface downstream ACTION-REQUIRED / BREAKING notices (CHANGELOG-driven) ---
# Overwriting the bundle is silent; a consumer who just re-runs this won't learn they
# must ALSO change their own code. Convention (docs/planning/CHANGELOG.md): every
# version section ends with a "下游 action：" line. Scan every section strictly newer
# than the project's previous .solo-version and loudly surface any non-"无" action /
# BREAKING marker, so a maintainer can't miss it.
CHANGELOG_FILE="$SOLO_DIR/docs/planning/CHANGELOG.md"
if [ -f "$CHANGELOG_FILE" ] && [ "$OLD_VER" != "$NEW_VER" ]; then
    _shown=0
    while IFS='|' read -r _nver _ntxt; do
        [ -z "$_nver" ] && continue
        if [ $_shown -eq 0 ]; then
            echo ""
            printf "${RED}============== ⚠  ACTION REQUIRED  ⚠ ==============${NC}\n"
            printf "${RED}下游需手动处理（重跑本脚本不够）:${NC}\n"
            _shown=1
        fi
        printf "${RED}  [%s] %s${NC}\n" "$_nver" "$_ntxt"
    done < <(awk -v old="$OLD_VER" '
        function vnum(v,   a) { gsub(/^v/, "", v); split(v, a, "."); return (a[1]+0)*1000000 + (a[2]+0)*1000 + (a[3]+0) }
        BEGIN { oldn = vnum(old) }
        /^## \[v[0-9]+\.[0-9]+\.[0-9]+\]/ { match($0, /v[0-9]+\.[0-9]+\.[0-9]+/); ver = substr($0, RSTART, RLENGTH); vern = vnum(ver); next }
        # Only the actual field line "下游 action：<...>" is a signal — not prose that
        # merely mentions the words. Skip when the value is the "无" sentinel (matched as
        # a token so "无法"/"无需" in a real action text are NOT mistaken for "none").
        ver && vern > oldn && /下游[[:space:]]*action[[:space:]]*：/ {
            if ($0 ~ /：[[:space:]]*无([[:space:]]|[[:punct:]]|$)/) next
            line = $0
            sub(/^[ >*-]+/, "", line)
            print ver "|" line
        }
    ' "$CHANGELOG_FILE")
    if [ $_shown -eq 1 ]; then
        printf "${RED}  ↳ 详情见 docs/planning/CHANGELOG.md 对应版本条目 + docs/runbook/${NC}\n"
    fi
fi

# --- 7. Next steps ---
echo ""
echo "Next:"
echo "   1. Restart the project:  (cd $PROJ && bash deploy/run.sh)"
if [ $DIVERGED -eq 1 ] && [ $FORCE_SCRIPTS -eq 0 ]; then
    echo "   2. Review diverged deploy scripts — diff each against its *.solo-${NEW_VER}.new and merge"
    echo "      (e.g. the seed-registry wiring / frontend-serve logic from the new stock run.sh)"
fi
echo "   • portal/operator/ is source-distributed and was NOT touched — diff it manually vs Solo if you want the new operator UI"
echo "   • v1.0→v1.1 first-time: ensure Redis is redis-stack-server (RedisJSON) — see docs/runbook/upgrade-v1.0-to-v1.1.md §2"
[ $DRY -eq 1 ] && { echo ""; log_warn "DRY-RUN — nothing was written. Re-run without --dry-run to apply."; }
log_info "Done."
