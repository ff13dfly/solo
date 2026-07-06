#!/bin/bash

# Dashboard-style Backend Runner for Solo.AI
# Interactive status board for backend services (assumes Redis is up).

# ANSI color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( dirname "$SCRIPT_DIR" )"
SERVICES_JSON="$SCRIPT_DIR/services.json"

if [ ! -f "$SERVICES_JSON" ]; then
    echo -e "${RED}Error: services.json not found${NC}"
    exit 1
fi

# SSL Configuration
SSL_ENABLED=0
SSL_SOURCE_PORT=8800
SSL_TARGET_PORT=8600

for arg in "$@"; do
    case $arg in
        --ssl) SSL_ENABLED=1; shift ;;
    esac
done

# Load services
SERVICES_DATA=$(node -e "
const fs = require('fs');
const services = JSON.parse(fs.readFileSync('$SERVICES_JSON', 'utf8'));
services.forEach(s => {
    console.log([\`name=\${s.name.toUpperCase()}\`, \`path=\${s.path}\`, \`port=\${s.port}\`].join('|'));
});
")

cd "$ROOT_DIR" || exit

# State
declare -A SERVICE_NAMES
declare -A SERVICE_PATHS
declare -A SERVICE_PORTS
declare -A SERVICE_PIDS
idx=0
while IFS='|' read -r name path port; do
    name=${name#name=}
    path=${path#path=}
    port=${port#port=}
    SERVICE_NAMES[$idx]=$name
    SERVICE_PATHS[$idx]=$path
    SERVICE_PORTS[$idx]=$port
    idx=$((idx+1))
done <<< "$SERVICES_DATA"
TOTAL_SERVICES=$idx
START_TIME=$(date +%s)

cleanup() {
    echo -e "\n${YELLOW}Stopping all backend services...${NC}"
    for i in "${!SERVICE_NAMES[@]}"; do
        pids=$(ps aux | grep "node.*api/${SERVICE_PATHS[$i]}" | grep -v grep | awk '{print $2}')
        [ -n "$pids" ] && kill $pids 2>/dev/null
        l_pid=$(lsof -ti:${SERVICE_PORTS[$i]} 2>/dev/null)
        [ -n "$l_pid" ] && kill -9 $l_pid 2>/dev/null
    done
    # Stop SSL proxy
    ssl_pid=$(lsof -ti:$SSL_SOURCE_PORT 2>/dev/null)
    [ -n "$ssl_pid" ] && kill -9 $ssl_pid 2>/dev/null
    tput cnorm # Show cursor
    exit
}

trap cleanup SIGINT SIGTERM EXIT

# Environment Check (Simplified)
clear
echo -e "${BLUE}${BOLD}=== Solo.AI Backend Dashboard (Initializing) ===${NC}"
echo "Checking dependencies..."

if ! redis-cli ping 2>/dev/null | grep -q "PONG"; then
    echo -e "${YELLOW}Redis not running. Attempting to start...${NC}"
    # Best-effort: prefer redis-stack-server (RedisJSON — orchestrator/storage/nexus
    # need it) and fall back to plain redis-server. For controlled startup use
    # deploy/dev.sh which manages its own Redis on port 6699.
    if command -v redis-stack-server &>/dev/null; then
        redis-stack-server --daemonize yes 2>/dev/null
    else
        echo -e "${YELLOW}  redis-stack-server not found — plain redis-server (orchestrator/storage/nexus will fail on JSON.SET).${NC}"
        redis-server --daemonize yes 2>/dev/null
    fi
    sleep 2
fi

# Stop existing
echo "Cleaning up ports..."
for i in "${!SERVICE_NAMES[@]}"; do
    l_pid=$(lsof -ti:${SERVICE_PORTS[$i]} 2>/dev/null)
    [ -n "$l_pid" ] && kill -9 $l_pid 2>/dev/null
done

# Start services
echo "Launching microservices..."
mkdir -p "$ROOT_DIR/api/debug"
for i in "${!SERVICE_NAMES[@]}"; do
    path=${SERVICE_PATHS[$i]}
    name=${SERVICE_NAMES[$i]}
    dir=$(dirname "api/$path")
    file=$(basename "$path")
    (cd "$dir" && nohup node "$file" > "$ROOT_DIR/api/debug/${name}_debug.log" 2>&1 &)
    SERVICE_PIDS[$i]=$!
done

if [ $SSL_ENABLED -eq 1 ]; then
    echo "Starting SSL proxy..."
    # Simplified SSL proxy launch
    SSL_CERT_DIR="$HOME/.certs"
    SSL_CERT_FILE="$SSL_CERT_DIR/localhost+2.pem"
    SSL_KEY_FILE="$SSL_CERT_DIR/localhost+2-key.pem"
    nohup local-ssl-proxy --source $SSL_SOURCE_PORT --target $SSL_TARGET_PORT \
        --cert "$SSL_CERT_FILE" --key "$SSL_KEY_FILE" > /dev/null 2>&1 &
fi

tput civis
# Dashboard Loop
while true; do
    tput cup 0 0
    echo -e "${BLUE}${BOLD}=== Solo.AI Backend Microservices Dashboard ===${NC}"
    echo -e "${CYAN}Uptime: $(($(date +%s) - START_TIME))s | Services: $TOTAL_SERVICES | SSL: $([ $SSL_ENABLED -eq 1 ] && echo -e "${GREEN}ON${NC}" || echo -e "${RED}OFF${NC}")${NC}"
    echo ""
    
    printf "${BOLD}%-15s %-6s %-12s %s${NC}\n" "SERVICE" "PORT" "STATUS" "LOG PREVIEW"
    echo "--------------------------------------------------------------------------------"
    
    for i in "${!SERVICE_NAMES[@]}"; do
        name=${SERVICE_NAMES[$i]}
        port=${SERVICE_PORTS[$i]}
        path=${SERVICE_PATHS[$i]}
        
        # Check if port is listening
        if lsof -i:$port -sTCP:LISTEN &>/dev/null; then
            STATUS="${GREEN}[ONLINE]${NC}"
        else
            STATUS="${RED}[OFFLINE]${NC}"
        fi
        
        # Get last log line
        log_file="api/debug/${name}_debug.log"
        if [ -f "$log_file" ]; then
            LAST_LOG=$(tail -n 1 "$log_file" | sed 's/^[0-9-]*T\([0-9][0-9]:[0-9][0-9]:[0-9][0-9]\)\.[0-9]*Z/\1/' | cut -c1-50)
        else
            LAST_LOG="no log"
        fi
        
        printf "%-15s %-6s %-12b ${NC}%s\n" "$name" "$port" "$STATUS" "$LAST_LOG"
    done
    
    echo "--------------------------------------------------------------------------------"
    echo -e "${YELLOW}Press Ctrl+C to stop all microservices.${NC}"
    
    sleep 2
done
