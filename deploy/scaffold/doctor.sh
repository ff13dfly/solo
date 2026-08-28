#!/bin/bash
#
# doctor.sh — 按需体检:检查这套 SOLO 栈自己的不变量,不做通用监控。
#
# 用法:  bash deploy/doctor.sh        (只读,不改任何状态,无常驻进程,跑完即走)
# 时机:  部署后 / 排查时 / 派生项目自己的循环定期调
# 退出码: 0 = 无 ✗;1 = 至少一个 ✗(⚠ 不影响退出码)
#
# 查什么:五类历史事故都发生在「栈自己报 ok」的视野之外——孤儿 bundle 进程在
# systemd unit 外面 100% CPU 烧了三天(还共享生产 Redis);前端端口被挤占后静默
# 漂移几个月;版本三处不对齐;数据没跟着代码迁移。这些落差全是 SOLO 自己的契约,
# 通用监控(netdata/node_exporter)不知道该查;反过来 CPU/内存曲线那种通用监控
# 这里也刻意不做,只报一行现状。背景:solo/docs/feedback/done/deploy-doctor-out-of-the-box.md
#
set -u

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( dirname "$SCRIPT_DIR" )"
VERSION_FILE="$ROOT_DIR/.solo-version"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; WARN=0; FAIL=0
ok()      { printf "${GREEN}  ✓ %s${NC}\n" "$1"; PASS=$((PASS+1)); }
warn()    { printf "${YELLOW}  ⚠ %s${NC}\n" "$1"; WARN=$((WARN+1)); }
bad()     { printf "${RED}  ✗ %s${NC}\n" "$1"; FAIL=$((FAIL+1)); }
note()    { printf "  · %s\n" "$1"; }
hint()    { printf "      %s\n" "$1"; }
section() { printf "\n${BOLD}%s${NC}\n" "$1"; }

# ── 端口探测统一入口(lsof / ss 二选一;与 run.sh 同款,原因见那边注释)──────
PORT_TOOL=""
command -v lsof >/dev/null 2>&1 && PORT_TOOL="lsof"
[ -z "$PORT_TOOL" ] && command -v ss >/dev/null 2>&1 && PORT_TOOL="ss"
if [ -z "$PORT_TOOL" ]; then
    printf "${RED}✗ 缺少端口探测工具:lsof 与 ss 都不存在。Debian/Ubuntu: apt-get install -y lsof${NC}\n" >&2
    exit 1
fi
port_in_use() {
    if [ "$PORT_TOOL" = "lsof" ]; then
        lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
    else
        [ -n "$(ss -tlnH "sport = :$1" 2>/dev/null)" ]
    fi
}
listener_pids() {
    if [ "$PORT_TOOL" = "lsof" ]; then
        lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
    else
        ss -tlnpH "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
    fi
}

# ── .env(与 run.sh 同款加载;doctor 只读它,不启动任何东西)─────────────────
if [ -f "$ROOT_DIR/.env" ]; then
    set -o allexport
    # shellcheck disable=SC1091
    source "$ROOT_DIR/.env"
    set +o allexport
fi

printf "${BOLD}SOLO doctor — %s${NC}\n" "$ROOT_DIR"

# ═══ 1/5 版本对齐 ═══════════════════════════════════════════════════════════
# 事故原型:tag / package.json / 线上进程三处不对齐反复发生;「发了没重启」「升了
# 一半」的落差在 bundle 文件名 vs 运行中进程的 cmdline 里当场可见。
section "[1/5] 版本对齐"

SOLO_VERSION=""; STACK_UP=0; OUR_ROOT_COUNT=0
if [ -f "$VERSION_FILE" ]; then
    SOLO_VERSION=$(tr -d '[:space:]' < "$VERSION_FILE")
    if [ -f "$ROOT_DIR/api/publish/solo.${SOLO_VERSION}.js" ]; then
        ok ".solo-version = $SOLO_VERSION,bundle 在位"
    else
        bad ".solo-version = $SOLO_VERSION,但 api/publish/solo.${SOLO_VERSION}.js 不存在(升级到一半?)"
    fi
    NEWEST=$(node -e '
const fs=require("fs");
try{
  const vs=fs.readdirSync(process.argv[1]).map(f=>/^solo\.(v\d+\.\d+\.\d+)\.js$/.exec(f)).filter(Boolean).map(m=>m[1]);
  vs.sort((a,b)=>{const A=a.slice(1).split(".").map(Number),B=b.slice(1).split(".").map(Number);return (A[0]-B[0])||(A[1]-B[1])||(A[2]-B[2]);});
  process.stdout.write(vs.pop()||"");
}catch(e){}' "$ROOT_DIR/api/publish" 2>/dev/null)
    if [ -n "$NEWEST" ] && [ "$NEWEST" != "$SOLO_VERSION" ]; then
        warn "api/publish 里最新的 bundle 是 $NEWEST,.solo-version 却钉在 $SOLO_VERSION"
        hint "拷了新 bundle 没改 .solo-version?run.sh 严格按 .solo-version 拼文件名。"
    fi
else
    bad ".solo-version 不存在——这不是一个完整的 Solo 脚手架部署"
fi

# 全机 solo bundle 进程清单(这里采集一次,第 2/3 节共用)。
# 判「本栈」的依据是 cmdline 里的 bundle 绝对路径(run.sh 用绝对路径起它)。
# 只认可执行文件是 node 的进程:编辑器/grep/shell 的参数里也常出现 bundle 路径,
# 不过滤会把它们当成 bundle 进程;而 N100 那次的孤儿(node -e 'require(bundle)')
# 恰好能被 node + 路径这两个条件同时命中。
BUNDLE_PROCS=$(ps axo pid=,pcpu=,command= 2>/dev/null | awk '$3 ~ /(^|\/)node[0-9]*$/ && $0 ~ /api\/publish\/solo\./' || true)
RUNNING_VER=""
if [ -n "$BUNDLE_PROCS" ]; then
    while read -r _pid _pcpu _cmd; do
        [ -z "${_pid:-}" ] && continue
        case "$_cmd" in
            *"$ROOT_DIR/"*)
                STACK_UP=1; OUR_ROOT_COUNT=$((OUR_ROOT_COUNT+1))
                RUNNING_VER=$(printf '%s' "$_cmd" | sed -n 's|.*solo\.\(v[0-9][0-9.]*\)\.js.*|\1|p')
                ;;
        esac
    done <<EOF
$(printf '%s\n' "$BUNDLE_PROCS" | awk '{pid=$1;pcpu=$2;$1="";$2="";print pid, pcpu, $0}')
EOF
fi
if [ "$STACK_UP" = "1" ]; then
    if [ -n "$RUNNING_VER" ] && [ -n "$SOLO_VERSION" ] && [ "$RUNNING_VER" != "$SOLO_VERSION" ]; then
        bad "运行中的 bundle 是 $RUNNING_VER,.solo-version 是 ${SOLO_VERSION}——发了没重启,或回滚了文件没回滚进程"
    else
        ok "运行中的 bundle 版本 = ${RUNNING_VER:-?} = .solo-version"
    fi
else
    note "本栈 bundle 当前没有在跑(这台机器本来就该跑它的话,这本身就是发现)"
fi

# 项目自己的版本节奏(tag vs package.json)——只提醒,不定罪:不是每个项目都打 tag。
PKG_V=$(node -e 'try{process.stdout.write(require(process.argv[1]).version||"")}catch(e){}' "$ROOT_DIR/package.json" 2>/dev/null)
TAG=$(git -C "$ROOT_DIR" describe --tags --abbrev=0 2>/dev/null || true)
if [ -n "$TAG" ] && [ -n "$PKG_V" ]; then
    if [ "${TAG#v}" = "${PKG_V#v}" ]; then
        ok "git tag ($TAG) = package.json ($PKG_V)"
    else
        warn "git tag ($TAG) ≠ package.json ($PKG_V)——发版后忘了对齐?"
    fi
elif [ -n "$PKG_V" ]; then
    note "项目未打过 tag,跳过 tag/package.json 对齐(package.json = $PKG_V)"
fi

# ═══ 2/5 端口:声明 vs 实际绑定 vs 归属 ══════════════════════════════════════
# 事故原型:前端端口被别人占住,serve 静默漂到随机端口,配置里的端口上趴着的是
# 占用方——dashboard 的 lsof 一路假绿几个月。所以三件事一起查:声明的端口有没有
# 人听、听的人是不是本栈的进程。
section "[2/5] 端口(声明 vs 实际绑定 vs 归属)"

PORTS_LIST=$(node -e '
const fs=require("fs");const [solo,svc]=process.argv.slice(1);const out=[];
try{JSON.parse(fs.readFileSync(solo,"utf8")).forEach(s=>{if(s.port!=null)out.push(["solo:"+s.name,s.port])})}catch(e){}
try{JSON.parse(fs.readFileSync(svc,"utf8")).forEach(s=>{if(s.port!=null)out.push(["app:"+s.name,s.port])})}catch(e){}
const env=process.env;
[["fe:operator","PORTAL_OPERATOR_PORT"],["fe:system","PORTAL_SYSTEM_PORT"],["fe:mobile","CLIENT_MOBILE_PORT"]]
  .forEach(([n,k])=>{if(env[k])out.push([n,env[k]])});
Object.keys(env).filter(k=>/^FRONTEND_[A-Z0-9_]+_PORT$/.test(k))
  .forEach(k=>out.push(["fe:"+k.replace(/^FRONTEND_|_PORT$/g,"").toLowerCase(),env[k]]));
out.forEach(([n,p])=>console.log(n+"|"+p));
' "$SCRIPT_DIR/solo-services.json" "$SCRIPT_DIR/services.json" 2>/dev/null)

if [ -z "$PORTS_LIST" ]; then
    warn "没有任何端口声明(solo-services.json / services.json / .env 前端口都空)"
else
    while IFS='|' read -r name port; do
        [ -z "$name" ] && continue
        pids=$(listener_pids "$port")
        if [ -z "$pids" ]; then
            if port_in_use "$port"; then
                warn "$name:$port 有监听但拿不到 pid(权限不够)——无法核对归属,换 root/sudo 再跑"
            elif [ "$STACK_UP" = "1" ]; then
                bad "$name:$port 无人监听——栈在跑,这个服务却没起来(看 api/debug/ 下它的日志)"
            else
                note "$name:$port 未监听(栈未运行)"
            fi
            continue
        fi
        foreign=""
        for p in $pids; do
            cmd=$(ps -o command= -p "$p" 2>/dev/null || true)
            case "$cmd" in *"$ROOT_DIR"*) ;; *) foreign="$p" ;; esac
        done
        if [ -z "$foreign" ]; then
            ok "$name:$port ← pid $(printf '%s' "$pids" | tr '\n' ',' | sed 's/,$//')(本栈)"
        else
            bad "$name:$port 被外来进程占用:$(ps -o pid=,command= -p "$foreign" 2>/dev/null | head -1 | cut -c1-120)"
            hint "它不在 $ROOT_DIR 下。先确认它是谁的(孤儿?别的栈?),再决定停谁、或改本栈端口。"
        fi
    done <<EOF
$PORTS_LIST
EOF
fi

# ═══ 3/5 全机 solo bundle 进程(孤儿排查)═══════════════════════════════════
# 事故原型:一条「看一眼 bundle 导出」的调试命令活了三天——不属任何 systemd unit,
# 100% CPU,与正式栈共享生产 Redis。systemd 全绿、ping 全 ok,对它零感知。
section "[3/5] 全机 solo bundle 进程(孤儿排查)"

if [ -z "$BUNDLE_PROCS" ]; then
    note "机器上没有任何 solo bundle 进程"
else
    if [ "$OUR_ROOT_COUNT" -gt 1 ]; then
        bad "本栈 ($ROOT_DIR) 起了 $OUR_ROOT_COUNT 个 bundle 进程——正常只该有一个,多出来的就是孤儿"
    fi
    while read -r _pid _pcpu _cmd; do
        [ -z "${_pid:-}" ] && continue
        _root=$(printf '%s' "$_cmd" | sed -n 's|.* \([^ ]*\)/api/publish/solo\..*|\1|p')
        _etime=$(ps -o etime= -p "$_pid" 2>/dev/null | tr -d ' ' || true)
        _who="别家栈"
        case "$_cmd" in *"$ROOT_DIR/"*) _who="本栈" ;; esac
        if awk -v c="$_pcpu" 'BEGIN{exit !(c+0>=90)}'; then
            warn "pid $_pid ($_who, ${_root:-?}) CPU ${_pcpu}%,已运行 ${_etime:-?} —— 空转嫌疑,先看它归不归 systemd 管"
            hint "Linux 查归属:cat /proc/$_pid/cgroup;孤儿的典型形态 = 已消亡的 ssh session scope"
        else
            note "pid $_pid ($_who) ${_root:-?} CPU ${_pcpu}% 已运行 ${_etime:-?}"
        fi
    done <<EOF
$(printf '%s\n' "$BUNDLE_PROCS" | awk '{pid=$1;pcpu=$2;$1="";$2="";print pid, pcpu, $0}')
EOF
fi

# ═══ 4/5 Redis 归属与认证 ═══════════════════════════════════════════════════
# 事故原型:① 撞端口的后起栈静默挂到先起栈的实例上,数据写进别家目录;② 配了
# REDIS_PASSWORD 但老实例还活着,requirepass 从未生效;③ 代码迁了机器、数据没跟
# 上——「剧本消失」表象指向插件坏了,判据其实是 key 前缀计数。
section "[4/5] Redis 归属与认证"

if [ -z "${REDIS_URL:-}" ]; then
    note ".env 没有 REDIS_URL——跳过(无库的栈这是正常的)"
elif ! command -v redis-cli >/dev/null 2>&1; then
    warn "redis-cli 不存在,Redis 检查全部跳过(apt-get install -y redis-tools)"
else
    _rinfo=$(node -e 'try{const u=new URL(process.env.REDIS_URL);process.stdout.write((u.hostname||"127.0.0.1")+"|"+(u.port||"6379")+"|"+(u.password||""))}catch(e){process.stdout.write("||")}')
    RHOST=${_rinfo%%|*}; _rest=${_rinfo#*|}; RPORT=${_rest%%|*}; RPASS=${_rest#*|}
    [ -z "$RPASS" ] && RPASS="${REDIS_PASSWORD:-}"
    case "$RHOST" in
        127.0.0.1|localhost|::1|"")
            [ -n "$RPASS" ] && export REDISCLI_AUTH="$RPASS"
            if [ "$(redis-cli -p "$RPORT" ping 2>/dev/null)" = "PONG" ]; then
                ok "Redis :$RPORT 应答正常"
                if [ -n "$RPASS" ]; then
                    if [ "$(env -u REDISCLI_AUTH redis-cli -p "$RPORT" ping 2>/dev/null)" = "PONG" ]; then
                        bad "配置了 REDIS_PASSWORD,但 :$RPORT 不带密码也能进——requirepass 没生效"
                        hint "多半是上一轮遗留的常驻实例。先 bgsave 确认落盘,再 redis-cli shutdown save 关掉它,然后重启栈。"
                    else
                        ok "requirepass 生效(未认证连接被拒)"
                    fi
                else
                    note "未配置 REDIS_PASSWORD(生产环境建议补上,见 .env 模板)"
                fi
                _rdir=$(redis-cli -p "$RPORT" config get dir 2>/dev/null | tail -1 || true)
                if [ "$_rdir" = "$SCRIPT_DIR/redis_data" ]; then
                    ok "实例归属本栈(dir = deploy/redis_data)"
                else
                    bad ":$RPORT 上的 Redis 不是本栈的实例(dir = ${_rdir:-<无权限或无应答>},期望 $SCRIPT_DIR/redis_data)"
                    hint "本栈的数据正写进别人的目录/别人的数据写进本栈。改 .env 的 REDIS_URL 换端口,或先停掉那个实例。"
                fi
                _keys=$(redis-cli -p "$RPORT" dbsize 2>/dev/null | tr -dc '0-9')
                if [ -n "$_keys" ] && [ "$_keys" -le 800000 ]; then
                    note "key 总数 $_keys,前缀分布(服务桶,数据在不在一眼可见):"
                    redis-cli -p "$RPORT" --scan 2>/dev/null | awk -F: 'NF{c[$1]++} END{for(k in c) printf "%8d  %s:*\n", c[k], k}' | sort -rn | head -8 | while read -r l; do hint "$l"; done
                else
                    note "key 总数 ${_keys:-?},超过 80 万,跳过前缀扫描"
                fi
            else
                if [ "$STACK_UP" = "1" ]; then
                    bad "Redis :$RPORT 无应答或认证失败——栈在跑,库却不可用"
                else
                    note "Redis :$RPORT 未运行(栈未运行)"
                fi
            fi
            ;;
        *)
            note "REDIS_URL 指向远端 $RHOST:${RPORT}——归属检查只对本机实例有意义,跳过"
            ;;
    esac
fi

# ═══ 5/5 宿主一行 ═══════════════════════════════════════════════════════════
# 只此一节碰通用指标,且只报一行现状——曲线、告警、面板是 netdata/node_exporter
# 的领域,SOLO 不重造。
section "[5/5] 宿主"

_load=$(uptime 2>/dev/null | sed 's/.*load average[s]*: *//')
_disk=$(df -h "$ROOT_DIR" 2>/dev/null | awk 'NR==2{print $5" 已用, "$4" 可用"}')
if command -v free >/dev/null 2>&1; then
    _mem=$(free -m 2>/dev/null | awk '/^Mem:/{print $7" MB 可用"}')
else
    _mem="(macOS,跳过内存)"
fi
note "load: ${_load:-?} | 磁盘: ${_disk:-?} | 内存: ${_mem:-?}"
_top=$(ps -Ao pcpu=,pid=,comm= 2>/dev/null | sort -rn | head -1 | sed 's/^ *//')
_topcpu=$(printf '%s' "$_top" | awk '{print $1}')
if [ -n "$_topcpu" ] && awk -v c="$_topcpu" 'BEGIN{exit !(c+0>=90)}'; then
    warn "最吃 CPU 的进程:$_top —— ≥90%,顺手看一眼它是谁(孤儿空转就是这个形态)"
else
    note "最吃 CPU 的进程:${_top:-?}"
fi

# ═══ 汇总 ═══════════════════════════════════════════════════════════════════
printf "\n${BOLD}结果:${NC} ${GREEN}✓ %d${NC}  ${YELLOW}⚠ %d${NC}  ${RED}✗ %d${NC}\n" "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
