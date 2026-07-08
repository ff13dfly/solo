#!/bin/bash
#
# start.sh — launch one mock listener per source configured in keys.env (DEV ONLY).
#
# Reads deploy/mock/keys.env (SRC_<name>=ingk_...), starts a listener.js per source
# on auto-assigned ports (8090, 8091, ...), in the background, and cleans them all up
# on Ctrl+C. The realistic path: external sample → listener → raw-archive → Router →
# ingress. (For quick multi-source firing without listeners, use simulate.js --direct.)
#
# Usage:
#   bash deploy/mock/start.sh                 # start listeners for every SRC_* in keys.env
#   then in another shell:
#   node deploy/mock/simulate.js github       # fires at the github listener (auto-routed)
#
# Env:
#   MOCK_PORT_BASE   first port (default 8090)
#   ROUTER_URL       router base for listeners (default https://127.0.0.1:8800)
#
set -e
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"
KEYS="$SCRIPT_DIR/keys.env"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

if [ ! -f "$KEYS" ]; then
    printf "${RED}✗ no keys.env${NC}\n"
    printf "  cp deploy/mock/keys.env.example deploy/mock/keys.env, then fill SRC_<name>=<key>\n"
    printf "  (create sources in Portal → Ingress to get the one-time keys)\n"
    exit 1
fi

BASE_PORT="${MOCK_PORT_BASE:-8090}"
export ROUTER_URL="${ROUTER_URL:-https://127.0.0.1:8800}"
LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"

PORTS_FILE="$SCRIPT_DIR/.ports"
: > "$PORTS_FILE"   # simulate.js reads this to auto-route <source> → its listener port

PIDS=()
cleanup() {
    printf "\n${YELLOW}stopping listeners...${NC}\n"
    for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
    rm -f "$PORTS_FILE"
}
trap cleanup EXIT INT TERM

printf "${GREEN}Starting mock listeners (router: %s)${NC}\n\n" "$ROUTER_URL"
printf "${CYAN}%-14s %-7s %-30s %s${NC}\n" "SOURCE" "PORT" "HOOK URL" "LOG"
printf -- "--------------------------------------------------------------------------------\n"

port=$BASE_PORT
count=0
while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    case "$line" in SRC_*=*) ;; *) continue ;; esac
    name="${line%%=*}"; name="${name#SRC_}"
    key="${line#*=}"
    [ -z "$name" ] && continue
    [ -z "$key" ] && continue

    log="$LOG_DIR/mock-listener-$name.log"
    SOURCE_NAME="$name" INGRESS_API_KEY="$key" MOCK_PORT="$port" \
        node "$SCRIPT_DIR/listener.js" > "$log" 2>&1 &
    PIDS+=("$!")
    echo "$name=$port" >> "$PORTS_FILE"
    printf "%-14s %-7s %-30s %s\n" "$name" "$port" "http://localhost:$port/hook" "logs/mock-listener-$name.log"
    port=$((port + 1)); count=$((count + 1))
done < "$KEYS"

if [ "$count" -eq 0 ]; then
    printf "${RED}✗ no SRC_* entries in keys.env${NC}\n"
    exit 1
fi

printf -- "--------------------------------------------------------------------------------\n"
printf "${GREEN}%d listener(s) up.${NC}  Fire samples from another shell:\n" "$count"
printf "  ${CYAN}node deploy/mock/simulate.js <source>${NC}              # via its listener\n"
printf "  ${CYAN}node deploy/mock/simulate.js <source> --id x -n 3${NC}  # dedup test\n"
printf "${YELLOW}Ctrl+C to stop all.${NC}\n"

wait
