#!/usr/bin/env bash
# deploy/check-upgrade-path.sh — 升级路径端到端门禁（CI `upgrade-path` job；本地也能跑）
#
# 干什么：用当前源码 scaffold 一个一次性消费者项目 → 在 [Project] / [Solo] / [Solo→Project] 三个
#   区各放一枚哨兵 → 把它伪装成上一个 patch 版本 → 跑 upgrade.sh（先 --dry-run，再真跑，再跑一次验幂等）
#   → 逐条断言三区语义 → 项目自己的 doctor.sh / precheck.sh 必须 ✗ 0。
#
# 为什么值得单列一道门（2026-09-04）：
#   - init.sh / upgrade.sh 此前 **零测试覆盖**，没有任何 CI job 调用过它们；唯一一次人工验证是
#     v1.1.1→v1.1.2（docs/runbook/upgrade-patch.md §3，8/8 断言）。
#   - v1.2.8 的教训：下游把公开方法表注册进 [Solo] 只读区，升级整体覆盖后安全评审结论静默消失，
#     CI 下一轮才红——「升级只动 [Solo]、不动 [Project]、[Solo→Project] 有分歧只暂存不覆盖」
#     这三条是 upgrade.sh 头注写死的合同，却从没被机器核过。
#   - 八个消费项目的 bundle 从 v1.0.0 到 v1.2.11 不齐，每次升级都是跳版。
#   - upgrade.sh 的自检与 ACTION REQUIRED 横幅**只打印、不改退出码**（见其 §6），断言只能在外面做。
#
# 用法：bash deploy/check-upgrade-path.sh            （solo 仓库任意位置调用；api/ 须已 npm ci）
#   需要：node、npx（esbuild 由 build.sh 经 npx 拉取）、git（要有 user.name/email，否则这里补一个
#   一次性身份）、rsync、lsof 或 ss（doctor.sh 硬前置）。
#   端口：init.sh 会用 lsof 往上扫空闲口；这里给的起点刻意避开项目段（PROBE_* 可覆盖）。
#   耗时：build.sh 跑三次（init + dry-run + 真升级 + 幂等再跑 = 4 次），本机 1–3 分钟。
set -euo pipefail

SOLO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VER="$(node -p "require('$SOLO_DIR/package.json').version")"
# 伪装的「旧版本」：上一个 patch 号（x.y.0 时退到 x.(y-1).99——只要比现在小就行，upgrade.sh 只比大小）
PREV_VER="$(node -e "const [a,b,c]=process.argv[1].split('.').map(Number); console.log(c>0?[a,b,c-1].join('.'):[a,b-1,99].join('.'))" "$VER")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/solo-upgrade-probe.XXXXXX")"
PROJ="$WORK/probe"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()  { echo "  ✓ $*"; pass=$((pass+1)); }
bad() { echo "  ✗ $*"; fail=$((fail+1)); }
assert_file()    { [ -f "$1" ] && ok "exists: ${1#$PROJ/}" || bad "MISSING: ${1#$PROJ/}"; }
assert_absent()  { [ ! -e "$1" ] && ok "gone: ${1#$PROJ/}" || bad "STILL PRESENT: ${1#$PROJ/}"; }
assert_eq()      { [ "$1" = "$2" ] && ok "$3 = $2" || bad "$3: got '$1', expected '$2'"; }
assert_grep()    { grep -qF -- "$1" "$2" && ok "$3" || bad "$3 (pattern '$1' not in ${2#$PROJ/})"; }
assert_nogrep()  { grep -qF -- "$1" "$2" && bad "$3 (pattern '$1' found in ${2#$PROJ/})" || ok "$3"; }
assert_same()    { cmp -s "$1" "$2" && ok "$3" || bad "$3 (differs)"; }
assert_dir_same(){ if diff -rq "$1" "$2" >/dev/null; then ok "$3"; else bad "$3"; diff -rq "$1" "$2" | head -10 | sed 's/^/      /'; fi; }
md5f()           { node -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('md5').update(f.readFileSync(process.argv[1])).digest('hex'))" "$1"; }
# 整树指纹（内容 + 相对路径，不含 .git；不含 mtime，所以「重新拷了一份同样的字节」不算变化）
tree_hash() {
    (cd "$1" && find . -type f -not -path './.git/*' -print0 | sort -z \
      | while IFS= read -r -d '' f; do printf '%s  %s\n' "$(md5f "$f")" "$f"; done) \
      | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(require('crypto').createHash('md5').update(s).digest('hex')))"
}
tree_list() { (cd "$1" && find . -type f -not -path './.git/*' -print0 | sort -z | while IFS= read -r -d '' f; do printf '%s  %s\n' "$(md5f "$f")" "$f"; done); }

# init.sh 会 git commit 脚手架；CI 容器没有身份时补一个一次性的（不写全局配置）
if ! git config user.email >/dev/null 2>&1; then
    export GIT_AUTHOR_NAME=solo-upgrade-probe GIT_AUTHOR_EMAIL=probe@solo.invalid
    export GIT_COMMITTER_NAME=solo-upgrade-probe GIT_COMMITTER_EMAIL=probe@solo.invalid
fi
command -v rsync >/dev/null || { echo "rsync missing (init.sh needs it)"; exit 1; }
{ command -v lsof || command -v ss; } >/dev/null || { echo "need lsof or ss (doctor.sh hard prerequisite)"; exit 1; }

echo "▶ solo $VER · probe pretends to be $PREV_VER · work dir $WORK"

# ── 1. scaffold ────────────────────────────────────────────────────────────────
echo "▶ 1/6 init.sh (frontend skipped)"
if ! FRONTEND_BUILD=skip SOLO_PORT_BASE="${PROBE_PORT_BASE:-8900}" FE_PORT_BASE="${PROBE_FE_BASE:-3900}" \
     REDIS_PORT="${PROBE_REDIS_PORT:-6390}" bash "$SOLO_DIR/deploy/scaffold/init.sh" probe "$PROJ" > "$WORK/init.log" 2>&1; then
    tail -40 "$WORK/init.log"; echo "init.sh failed"; exit 1
fi
assert_eq "$(tr -d '[:space:]' < "$PROJ/.solo-version")" "v$VER" ".solo-version after init"
assert_file "$PROJ/api/publish/solo.v$VER.js"
assert_same "$PROJ/api/publish/solo.v$VER.js" "$SOLO_DIR/api/publish/solo.js" "shipped bundle is byte-identical to the fresh build"
assert_same "$PROJ/deploy/run.sh" "$SOLO_DIR/deploy/scaffold/run.sh" "deploy/run.sh starts as stock"
assert_eq "$(ls -A "$PROJ/api/apps" | wc -l | tr -d ' ')" "0" "api/apps starts empty"
assert_grep '<!-- solo:begin -->' "$PROJ/docs/README.md" "docs/README.md carries the solo:begin marker"
assert_grep '<!-- solo:end -->'   "$PROJ/docs/README.md" "docs/README.md carries the solo:end marker"

# ── 2. plant sentinels in each ownership zone ──────────────────────────────────
echo "▶ 2/6 planting sentinels"
#   [Project] — must survive byte-for-byte
printf "\n# probe\nPROBE_SENTINEL='keep-me'\n" >> "$PROJ/.env"
mkdir -p "$PROJ/api/apps/probe" && echo "module.exports = 'probe-project-zone';" > "$PROJ/api/apps/probe/index.js"
printf "\n## Probe section\n\nkeep-me (project-owned, below solo:end)\n" >> "$PROJ/docs/README.md"
M_SOLOSVC="$(md5f "$PROJ/deploy/solo-services.json")"; M_KEYPAIR="$(md5f "$PROJ/.keypair")"; M_SEED="$(md5f "$PROJ/api/seed.json")"
M_SERVICES="$(md5f "$PROJ/deploy/services.json")"; M_ENV_HEAD="$(head -c 4096 "$PROJ/.env" | md5f /dev/stdin 2>/dev/null || true)"
#   [Solo] — must be restored to stock; a stale file upstream no longer ships must disappear
echo "// probe-tamper: must be reverted by upgrade" >> "$PROJ/api/library/logger.js"
echo "module.exports = 'stale-file-upstream-deleted';" > "$PROJ/api/library/probe-stale.js"
#   [Solo→Project] — customized deploy script: must NOT be clobbered, stock must be staged alongside
echo "# probe-customized: team edit, upgrade must not clobber" >> "$PROJ/deploy/run.sh"
#   pretend the project is one patch behind
echo "v$PREV_VER" > "$PROJ/.solo-version"
mv "$PROJ/api/publish/solo.v$VER.js" "$PROJ/api/publish/solo.v$PREV_VER.js"
HASH_BEFORE_DRY="$(tree_hash "$PROJ")"

# ── 3. dry run must not touch the tree ─────────────────────────────────────────
echo "▶ 3/6 upgrade.sh --dry-run"
if ! FRONTEND_BUILD=skip bash "$SOLO_DIR/deploy/scaffold/upgrade.sh" "$PROJ" --dry-run > "$WORK/dry.log" 2>&1; then
    tail -40 "$WORK/dry.log"; bad "upgrade.sh --dry-run exited non-zero"
fi
assert_eq "$(tree_hash "$PROJ")" "$HASH_BEFORE_DRY" "--dry-run leaves the project tree untouched (tree hash)"
assert_eq "$(tr -d '[:space:]' < "$PROJ/.solo-version")" "v$PREV_VER" ".solo-version untouched by --dry-run"

# ── 4. real upgrade ────────────────────────────────────────────────────────────
echo "▶ 4/6 upgrade.sh"
if ! FRONTEND_BUILD=skip bash "$SOLO_DIR/deploy/scaffold/upgrade.sh" "$PROJ" > "$WORK/up.log" 2>&1; then
    tail -60 "$WORK/up.log"; echo "upgrade.sh failed"; exit 1
fi
echo "  — version / bundle"
assert_eq "$(tr -d '[:space:]' < "$PROJ/.solo-version")" "v$VER" ".solo-version bumped"
assert_file   "$PROJ/api/publish/solo.v$VER.js"
assert_absent "$PROJ/api/publish/solo.v$PREV_VER.js"
assert_eq "$(ls "$PROJ"/api/publish/solo.v*.js | wc -l | tr -d ' ')" "1" "exactly one bundle left in api/publish"
assert_same "$PROJ/api/publish/solo.v$VER.js" "$SOLO_DIR/api/publish/solo.js" "new bundle byte-identical to fresh build"
echo "  — [Project] zone survives"
assert_grep "PROBE_SENTINEL='keep-me'" "$PROJ/.env" ".env sentinel intact"
assert_eq "$(head -c 4096 "$PROJ/.env" | md5f /dev/stdin 2>/dev/null || true)" "$M_ENV_HEAD" ".env head unchanged"
assert_eq "$(cat "$PROJ/api/apps/probe/index.js")" "module.exports = 'probe-project-zone';" "api/apps/probe/index.js intact"
assert_eq "$(md5f "$PROJ/deploy/solo-services.json")" "$M_SOLOSVC" "deploy/solo-services.json untouched"
assert_eq "$(md5f "$PROJ/deploy/services.json")"      "$M_SERVICES" "deploy/services.json untouched"
assert_eq "$(md5f "$PROJ/.keypair")"                  "$M_KEYPAIR"  ".keypair untouched"
assert_eq "$(md5f "$PROJ/api/seed.json")"             "$M_SEED"     "api/seed.json untouched"
assert_grep "## Probe section" "$PROJ/docs/README.md" "docs/README.md project section (below solo:end) kept"
assert_grep '<!-- solo:begin -->' "$PROJ/docs/README.md" "docs/README.md solo block still marked (spliced, not replaced)"
assert_absent "$PROJ/docs/README.md.solo-v$VER.new"
echo "  — [Solo] zone is replaced wholesale"
assert_same "$PROJ/api/library/logger.js" "$SOLO_DIR/api/library/logger.js" "tampered api/library/logger.js reverted to stock"
assert_absent "$PROJ/api/library/probe-stale.js"
assert_dir_same "$PROJ/api/library"   "$SOLO_DIR/api/library"   "api/library == upstream (whole-dir)"
assert_dir_same "$PROJ/api/autocheck" "$SOLO_DIR/api/autocheck" "api/autocheck == upstream (whole-dir)"
assert_dir_same "$PROJ/api/sample"    "$SOLO_DIR/api/sample"    "api/sample == upstream (whole-dir)"
echo "  — [Solo→Project] deploy scripts: diverged copy kept, stock staged"
assert_grep "# probe-customized" "$PROJ/deploy/run.sh" "customized deploy/run.sh NOT clobbered"
assert_file "$PROJ/deploy/run.sh.solo-v$VER.new"
assert_same "$PROJ/deploy/run.sh.solo-v$VER.new" "$SOLO_DIR/deploy/scaffold/run.sh" "staged stock run.sh matches upstream"
assert_grep "DIVERGED" "$WORK/up.log" "upgrade report flags the divergence"
for s in precheck.sh admin-up.sh doctor.sh seed-registry.js migrate-cursor-index.js; do
    assert_same "$PROJ/deploy/$s" "$SOLO_DIR/deploy/scaffold/$s" "deploy/$s == stock (unchanged)"
    assert_absent "$PROJ/deploy/$s.solo-v$VER.new"
done
echo "  — upgrade.sh's own report"
assert_grep "Post-upgrade self-check" "$WORK/up.log" "self-check ran"
assert_grep ".solo-version = v$VER" "$WORK/up.log" "self-check saw the new version"

# ── 5. idempotency: a second upgrade is a no-op ────────────────────────────────
echo "▶ 5/6 upgrade.sh again (must be a no-op)"
HASH_AFTER_FIRST="$(tree_hash "$PROJ")"; tree_list "$PROJ" > "$WORK/tree1.txt"
if ! FRONTEND_BUILD=skip bash "$SOLO_DIR/deploy/scaffold/upgrade.sh" "$PROJ" > "$WORK/up2.log" 2>&1; then
    tail -40 "$WORK/up2.log"; bad "second upgrade.sh exited non-zero"
fi
if [ "$(tree_hash "$PROJ")" = "$HASH_AFTER_FIRST" ]; then ok "second upgrade changed nothing (tree hash)"; else
    bad "second upgrade changed the tree:"; tree_list "$PROJ" > "$WORK/tree2.txt"; diff "$WORK/tree1.txt" "$WORK/tree2.txt" | head -12 | sed 's/^/      /'; fi
assert_nogrep "was missing" "$WORK/up2.log" "no deploy script reported as missing on re-run"

# ── 6. the project's own health tools must be green ────────────────────────────
echo "▶ 6/6 doctor.sh + precheck.sh on the upgraded project"
if bash "$PROJ/deploy/doctor.sh" > "$WORK/doctor.log" 2>&1; then ok "doctor.sh exit 0 (✗ 0)"; else bad "doctor.sh reported ✗:"; grep -E '✗' "$WORK/doctor.log" | head -8 | sed 's/^/      /'; fi
if bash "$PROJ/deploy/precheck.sh" > "$WORK/precheck.log" 2>&1; then ok "precheck.sh exit 0"; else bad "precheck.sh failed"; tail -10 "$WORK/precheck.log" | sed 's/^/      /'; fi

echo ""
echo "upgrade-path: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
