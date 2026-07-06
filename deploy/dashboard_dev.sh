#!/bin/bash
# Solo.AI Frontend (Development) Dashboard
MODE="browser"
if [ "$1" == "native" ]; then
    MODE="native"
fi

DESKTOP_CMD="npm run dev"
if [ "$MODE" == "native" ]; then
    DESKTOP_CMD="npx tauri dev"
fi

SERVICES=(
    "Portal System|portal/system|9200|npm run dev"
    "Portal Operator|portal/operator|9300|npm run dev"
    "Solo Mobile|client/mobile|9500|npm run dev"
    "Solo Desktop|client/desktop|9600|$DESKTOP_CMD"
)

# Colors & Formatting
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'
HIDDEN='\033[8m'

ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$ROOT_DIR" || exit

# State
PIDS=()
START_TIMES=()
START_TOTAL=$(date +%s)

cleanup() {
    echo -e "\n${YELLOW}Stopping all services...${NC}"
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null
    done
    tput cnorm # Show cursor
    exit
}

trap cleanup SIGINT SIGTERM EXIT

# Check dependencies
check_deps() {
    [ -d "$1/node_modules" ]
}

# Start services
tput civis # Hide cursor
clear
echo -e "${BLUE}${BOLD}=== Solo.AI Frontend Dashboard (Starting) ===${NC}"

for i in "${!SERVICES[@]}"; do
    IFS='|' read -r name path port cmd <<< "${SERVICES[$i]}"
    echo -ne "  ${CYAN}Starting $name...${NC}\r"
    
    if check_deps "$path"; then
        (cd "$path" && eval "$cmd" > /dev/null 2>&1) &
        PIDS[$i]=$!
        START_TIMES[$i]=$(date +%s)
    else
        PIDS[$i]=-1
    fi
done

# Dashboard Loop
while true; do
    tput cup 0 0
    echo -e "${BLUE}${BOLD}=== Solo.AI Development Dashboard ===${NC}"
    echo -e "${CYAN}Root: $ROOT_DIR${NC}"
    echo -e "${CYAN}Uptime: $(($(date +%s) - START_TOTAL))s${NC}"
    echo ""
    
    printf "${BOLD}%-25s %-8s %-12s %-10s %s${NC}\n" "SERVICE" "PORT" "STATUS" "UPTIME" "URL"
    echo "--------------------------------------------------------------------------------"
    
    for i in "${!SERVICES[@]}"; do
        IFS='|' read -r name path port cmd <<< "${SERVICES[$i]}"
        pid=${PIDS[$i]}
        
        if [ "$pid" == "-1" ]; then
            STATUS="${RED}[DEP MISSING]${NC}"
            UPTIME="-"
            URL="-"
        elif kill -0 "$pid" 2>/dev/null; then
            # Check if port is actually listening (optional, slow)
            # if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null ; then ...
            STATUS="${GREEN}[RUNNING]${NC}"
            UPTIME="$(($(date +%s) - START_TIMES[$i]))s"
            URL="http://localhost:$port"
        else
            STATUS="${RED}[STOPPED]${NC}"
            UPTIME="-"
            URL="-"
        fi
        
        printf "%-25s %-8s %-12b %-10s ${GREEN}%s${NC}\n" "$name" "$port" "$STATUS" "$UPTIME" "$URL"
    done
    
    echo "--------------------------------------------------------------------------------"
    echo -e "${YELLOW}Press Ctrl+C to stop all services.${NC}"
    
    sleep 2
done
