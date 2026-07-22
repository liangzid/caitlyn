#!/bin/bash
# Agent Containers Management Script
# Part of Mobius Injection Research Project
# Location: /home/zi/paper_mobius/scripts/agent_containers.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Agent list
AGENTS=("nanobot" "opencode" "kilo_code" "grok_cli" "codex" "openclaw" "droid" "zed" "claude_code" "zeroclaw" "hermes")

show_status() {
    echo -e "${GREEN}=== Agent Container Status ===${NC}"
    docker ps -a --format '{{.Names}}: {{.Status}}' | grep -E '^('"${AGENTS[*]}"'):' || echo "No agent containers found"
}

show_help() {
    cat << EOF
${GREEN}Agent Containers Management Script${NC}

${YELLOW}Usage:${NC}
    $0 [command] [agent]

${YELLOW}Commands:${NC}
    status      Show all agent container statuses
    start       Start a specific agent container
    stop        Stop a specific agent container
    restart     Restart a specific agent container
    logs        Show logs for a specific agent
    exec        Open an interactive shell in an agent container
    run         Run a command in an agent container
    setup       Configure API keys in an agent container
    setup-all   Configure API keys in all agent containers
    help        Show this help message

${YELLOW}Agents:${NC}
    ${AGENTS[*]}

${YELLOW}Examples:${NC}
    $0 status
    $0 start hermes
    $0 stop nanobot
    $0 exec opencode
    $0 run nanobot nanobot --version
    $0 logs claude_code
    $0 setup claude_code ~/.env
    $0 setup-all ~/.env

EOF
}

case "${1:-}" in
    status)
        show_status
        ;;
    start)
        if [ -z "$2" ]; then
            echo -e "${RED}Error: Agent name required${NC}"
            echo "Usage: $0 start <agent>"
            exit 1
        fi
        docker start "$2"
        ;;
    stop)
        if [ -z "$2" ]; then
            echo -e "${RED}Error: Agent name required${NC}"
            echo "Usage: $0 stop <agent>"
            exit 1
        fi
        docker stop "$2"
        ;;
    restart)
        if [ -z "$2" ]; then
            echo -e "${RED}Error: Agent name required${NC}"
            echo "Usage: $0 restart <agent>"
            exit 1
        fi
        docker restart "$2"
        ;;
    logs)
        if [ -z "$2" ]; then
            echo -e "${RED}Error: Agent name required${NC}"
            echo "Usage: $0 logs <agent>"
            exit 1
        fi
        docker logs "$2"
        ;;
    exec)
        if [ -z "$2" ]; then
            echo -e "${RED}Error: Agent name required${NC}"
            echo "Usage: $0 exec <agent> [command]"
            exit 1
        fi
        AGENT="$2"
        shift 2
        # Determine shell based on agent
        if [ "$AGENT" = "droid" ] || [ "$AGENT" = "zed" ]; then
            docker exec -it "$AGENT" sh "${@:-}"
        else
            docker exec -it "$AGENT" bash "${@:-}" 2>/dev/null || docker exec -it "$AGENT" sh "${@:-}"
        fi
        ;;
    run)
        if [ -z "$2" ]; then
            echo -e "${RED}Error: Agent name required${NC}"
            echo "Usage: $0 run <agent> <command>"
            exit 1
        fi
        AGENT="$2"
        shift 2
        docker exec "$AGENT" "$@"
        ;;
    setup)
        if [ -z "$2" ]; then
            echo -e "${RED}Error: Agent name required${NC}"
            echo "Usage: $0 setup <agent> [env_file]"
            exit 1
        fi
        AGENT="$2"
        ENV_FILE="${3:-$SCRIPT_DIR/setup/.env}"
        SCRIPT_MAP="claude_code:01_claude_code.sh openclaw:02_openclaw.sh opencode:03_opencode.sh codex:04_codex.sh kilo_code:05_kilo_code.sh grok_cli:06_grok_cli.sh zeroclaw:07_zeroclaw.sh hermes:08_hermes.sh nanobot:09_nanobot.sh droid:10_droid.sh zed:11_zed.sh"
        SCRIPT=""
        for entry in $SCRIPT_MAP; do
            if [ "${entry%%:*}" = "$AGENT" ]; then
                SCRIPT="${entry##*:}"
                break
            fi
        done
        if [ -z "$SCRIPT" ]; then
            echo -e "${RED}Error: Unknown agent: $AGENT${NC}"
            exit 1
        fi
        if [ ! -f "$ENV_FILE" ]; then
            echo -e "${RED}Error: Environment file not found: $ENV_FILE${NC}"
            echo "Copy scripts/setup/.env.example to scripts/setup/.env and fill in your keys"
            exit 1
        fi
        echo "Setting up $AGENT with API keys from $ENV_FILE..."
        docker cp "$ENV_FILE" "${AGENT}:/tmp/.env"
        docker cp "$SCRIPT_DIR/setup/$SCRIPT" "${AGENT}:/tmp/setup_agent.sh"
        docker exec "$AGENT" bash /tmp/setup_agent.sh
        docker exec "$AGENT" rm -f /tmp/setup_agent.sh /tmp/.env
        echo "Done: $AGENT"
        ;;
    setup-all)
        ENV_FILE="${2:-$SCRIPT_DIR/setup/.env}"
        if [ ! -f "$ENV_FILE" ]; then
            echo -e "${RED}Error: Environment file not found: $ENV_FILE${NC}"
            echo "Copy scripts/setup/.env.example to scripts/setup/.env and fill in your keys"
            exit 1
        fi
        echo "Setting up all agent containers with API keys..."
        for AGENT in "${AGENTS[@]}"; do
            if ! docker ps --format '{{.Names}}' | grep -q "^${AGENT}$"; then
                echo "Warning: $AGENT not running, skipping"
                continue
            fi
            SCRIPT_MAP="claude_code:01_claude_code.sh openclaw:02_openclaw.sh opencode:03_opencode.sh codex:04_codex.sh kilo_code:05_kilo_code.sh grok_cli:06_grok_cli.sh zeroclaw:07_zeroclaw.sh hermes:08_hermes.sh nanobot:09_nanobot.sh droid:10_droid.sh zed:11_zed.sh"
            SCRIPT=""
            for entry in $SCRIPT_MAP; do
                if [ "${entry%%:*}" = "$AGENT" ]; then
                    SCRIPT="${entry##*:}"
                    break
                fi
            done
            echo "--- Setting up $AGENT ---"
            docker cp "$ENV_FILE" "${AGENT}:/tmp/.env" 2>/dev/null || true
            docker cp "$SCRIPT_DIR/setup/$SCRIPT" "${AGENT}:/tmp/setup_agent.sh" 2>/dev/null || true
            docker exec "$AGENT" bash /tmp/setup_agent.sh 2>/dev/null || true
            docker exec "$AGENT" rm -f /tmp/setup_agent.sh /tmp/.env 2>/dev/null || true
            echo "Done: $AGENT"
        done
        echo "All agents configured!"
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        if [ -n "$1" ]; then
            echo -e "${RED}Unknown command: $1${NC}"
        fi
        show_help
        exit 1
        ;;
esac
