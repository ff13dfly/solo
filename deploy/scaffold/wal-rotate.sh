#!/bin/bash
# wal-rotate.sh — WAL 归档轮转 + Redis 快照留存（两件事，分开做）
#
# 为什么是两件事、为什么节奏不同：
#   · WAL 归档（logs/wal/{year}/{date}.log）是**只增不删的审计流水**。每天一个文件，
#     过了那天就不再被写入 → 可以安全压缩（实测 gzip 13:1）。它的目标是「留住历史」，
#     丢一天就是审计断档，所以只压缩/搬走、默认永不删除。
#   · Redis 快照（RDB）是**当前状态的备份**。它的目标是「能恢复到最近一刻」，
#     所以频率该按你能接受的丢失窗口来定（日级起步），跟 WAL 的月度归档不是一回事。
#     ⚠️ 按月备份 Redis = 最多丢一个月的业务数据，多数场景都太粗。
#
# 用法：
#   deploy/wal-rotate.sh                      # 压缩 7 天前的日志（干跑看看会做什么用 --dry-run）
#   deploy/wal-rotate.sh --days 30            # 改保留窗口
#   deploy/wal-rotate.sh --dest /mnt/cold     # 压缩后搬到冷存（搬走才真正释放本盘）
#   deploy/wal-rotate.sh --redis              # 顺带做一次 Redis RDB 快照
#   deploy/wal-rotate.sh --redis-only         # 只做 Redis 快照
#   deploy/wal-rotate.sh --dry-run            # 只打印，不动文件
#
# 定时：Linux（N100/VPS）用 systemd timer；
#   🔴 macOS 不要用 cron/launchd —— TCC 会静默拦掉后台任务访问 ~/Desktop，
#      把它挂在某个从终端启动的常驻栈的生命周期里（见全局 CLAUDE.md）。
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( dirname "$SCRIPT_DIR" )"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log_info()  { printf "${GREEN}✓ %s${NC}\n" "$1"; }
log_warn()  { printf "${YELLOW}⚠ %s${NC}\n" "$1"; }
log_error() { printf "${RED}✗ %s${NC}\n" "$1"; }

RETAIN_DAYS=7
DEST=""
DO_REDIS=0
REDIS_ONLY=0
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --days)       RETAIN_DAYS="$2"; shift 2 ;;
        --dest)       DEST="$2"; shift 2 ;;
        --redis)      DO_REDIS=1; shift ;;
        --redis-only) DO_REDIS=1; REDIS_ONLY=1; shift ;;
        --dry-run)    DRY_RUN=1; shift ;;
        -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
        *) log_error "未知参数: $1"; exit 2 ;;
    esac
done

# .env 的值按约定是单引号包裹（见全局 CLAUDE.md 红线）——手写解析必须剥引号，
# 否则会把引号连着值一起当密码用（症状是 NOAUTH，看起来像密码错）。
env_get() {
    local key="$1" file="$ROOT_DIR/.env"
    [ -f "$file" ] || return 0
    sed -n "s/^${key}=//p" "$file" | tail -1 | sed "s/^\(['\"]\)\(.*\)\1$/\2/"
}

# LOG_DIR 与 api/library/logger.js 的解析顺序保持一致：env > 仓库根 logs/
LOG_DIR="${LOG_DIR:-$(env_get LOG_DIR)}"
LOG_DIR="${LOG_DIR:-$ROOT_DIR/logs}"
WAL_DIR="$LOG_DIR/wal"

run() { if [ "$DRY_RUN" = "1" ]; then echo "   [dry-run] $*"; else eval "$@"; fi; }

echo "========================================"
echo "  Solo WAL 轮转 / 快照"
echo "  归档目录 : $LOG_DIR"
echo "  保留窗口 : ${RETAIN_DAYS} 天（更老的压缩）"
[ -n "$DEST" ] && echo "  冷存目标 : $DEST"
[ "$DRY_RUN" = "1" ] && echo "  模式     : DRY-RUN（不改动任何文件）"
echo "========================================"

# ── 1. WAL 日志压缩 ─────────────────────────────────────────────────────────
if [ "$REDIS_ONLY" = "0" ]; then
    if [ ! -d "$WAL_DIR" ]; then
        log_warn "没有 $WAL_DIR，跳过 WAL 轮转（栈还没写过账本？）"
    else
        TODAY=$(date +%Y-%m-%d)
        COMPRESSED=0; SKIPPED=0; FREED_KB=0

        # -mtime +N：最后修改早于 N 天。今天的文件正在被追加写，绝不碰。
        while IFS= read -r f; do
            base=$(basename "$f" .log)
            if [ "$base" = "$TODAY" ]; then
                SKIPPED=$((SKIPPED+1)); continue      # 当天文件仍在写入
            fi
            before_kb=$(du -k "$f" | cut -f1)
            echo "→ 压缩 $base.log ($(( before_kb / 1024 )) MB)"
            if [ "$DRY_RUN" = "0" ]; then
                # gzip -k 保留原件；先验完整性再删原件——压坏了宁可不删。
                gzip -kf "$f"
                if gzip -t "$f.gz" 2>/dev/null; then
                    rm -f "$f"
                    after_kb=$(du -k "$f.gz" | cut -f1)
                    FREED_KB=$((FREED_KB + before_kb - after_kb))
                else
                    log_error "  gzip 校验失败，保留原件：$f"
                    rm -f "$f.gz"
                    continue
                fi
            fi
            COMPRESSED=$((COMPRESSED+1))
        done < <(find "$WAL_DIR" -name '*.log' -type f -mtime +"$RETAIN_DAYS" 2>/dev/null)

        # 索引文件同理（它占总量约 1/3，别漏）
        while IFS= read -r f; do
            base=$(basename "$f" .index)
            [ "$base" = "$TODAY" ] && continue
            echo "→ 压缩 $base.index"
            if [ "$DRY_RUN" = "0" ]; then
                gzip -kf "$f" && gzip -t "$f.gz" 2>/dev/null && rm -f "$f" || log_error "  索引压缩失败：$f"
            fi
        done < <(find "$WAL_DIR" -name '*.index' -type f -mtime +"$RETAIN_DAYS" 2>/dev/null)

        log_info "压缩 $COMPRESSED 个日志文件，跳过 $SKIPPED 个（当天在写），释放约 $((FREED_KB / 1024)) MB"

        # ── 2. 搬到冷存（只有搬走才真正释放本盘）──────────────────────────
        if [ -n "$DEST" ]; then
            run "mkdir -p '$DEST'"
            # --remove-source-files 只搬已压缩的，原始 .log 永远不参与
            if [ "$DRY_RUN" = "0" ]; then
                rsync -a --remove-source-files --include='*/' --include='*.gz' --exclude='*' \
                    "$WAL_DIR/" "$DEST/" && log_info "已搬运压缩文件到 $DEST"
            else
                echo "   [dry-run] rsync *.gz → $DEST/"
            fi
        fi
    fi

    # ── 3. 磁盘水位（与 archiver 的告警同源，这里给人看）────────────────────
    if [ -d "$LOG_DIR" ]; then
        AVAIL=$(df -Pk "$LOG_DIR" | tail -1 | awk '{print $4}')
        PCT=$(df -Pk "$LOG_DIR" | tail -1 | awk '{print $5}' | tr -d '%')
        FREE_PCT=$((100 - PCT))
        USED_MB=$(du -sk "$LOG_DIR" | cut -f1); USED_MB=$((USED_MB / 1024))
        echo "   归档现占 ${USED_MB} MB，所在盘剩余 $((AVAIL / 1024)) MB（${FREE_PCT}%）"
        [ "$FREE_PCT" -le 15 ] && log_warn "磁盘余量低——WAL 与 Redis 持久化、服务日志同盘，满盘会拖垮整栈"
        [ "$FREE_PCT" -le 5 ]  && log_error "磁盘余量危急，立即处理"
    fi
fi

# ── 4. Redis 快照（可选，节奏应比 WAL 归档快得多）─────────────────────────
if [ "$DO_REDIS" = "1" ]; then
    echo ""
    echo "── Redis 快照 ──"
    REDIS_URL_VAL="${REDIS_URL:-$(env_get REDIS_URL)}"
    REDIS_PASSWORD_VAL="${REDIS_PASSWORD:-$(env_get REDIS_PASSWORD)}"
    PORT=$(echo "$REDIS_URL_VAL" | sed -n 's#.*:\([0-9]\{4,5\}\).*#\1#p')
    PORT="${PORT:-6379}"
    SNAP_DIR="${DEST:-$ROOT_DIR/backup}/redis"

    # 密码从 .env 直取、只进本进程环境；别用 redis-cli -a（会把密码泄进 ps）
    [ -n "$REDIS_PASSWORD_VAL" ] && export REDISCLI_AUTH="$REDIS_PASSWORD_VAL"

    if ! redis-cli -p "$PORT" ping >/dev/null 2>&1; then
        log_error "连不上 Redis :$PORT，跳过快照"
    else
        run "mkdir -p '$SNAP_DIR'"
        RDB_PATH=$(redis-cli -p "$PORT" CONFIG GET dir | tail -1)/$(redis-cli -p "$PORT" CONFIG GET dbfilename | tail -1)
        echo "→ BGSAVE（源 RDB: $RDB_PATH）"
        if [ "$DRY_RUN" = "0" ]; then
            LAST=$(redis-cli -p "$PORT" LASTSAVE)
            redis-cli -p "$PORT" BGSAVE >/dev/null
            # 等落盘：LASTSAVE 变化才算数（rdb_changes_since_last_save 归零同理）
            for _ in $(seq 1 120); do
                sleep 1
                NOW=$(redis-cli -p "$PORT" LASTSAVE)
                [ "$NOW" != "$LAST" ] && break
            done
            if [ "$NOW" = "$LAST" ]; then
                log_error "BGSAVE 120s 未完成，快照可能不完整——请手工检查"
            else
                STAMP=$(date +%Y%m%d-%H%M%S)
                cp "$RDB_PATH" "$SNAP_DIR/dump-$STAMP.rdb"
                gzip -f "$SNAP_DIR/dump-$STAMP.rdb"
                log_info "快照 → $SNAP_DIR/dump-$STAMP.rdb.gz ($(du -h "$SNAP_DIR/dump-$STAMP.rdb.gz" | cut -f1))"
            fi
        fi
    fi
fi

echo "========================================"
