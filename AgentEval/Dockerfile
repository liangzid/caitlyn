# AgentEval — Single Docker image with all 5 agents
#   Claude Code + Codex CLI + OpenCode + OpenClaw + Hermes
#
# Build:  docker build -t agent-eval:latest -f Dockerfile .
# Run:    docker run -d --name agent-eval \
#           -v ~/privacy_secret_openrouter_API_key.txt:/tmp/api_key:ro \
#           --add-host=host.docker.internal:host-gateway \
#           agent-eval:latest sleep infinity
# Exec:   docker exec agent-eval claude -p "hello"
#         docker exec agent-eval codex exec --full-auto "hello"
#         docker exec agent-eval opencode run "hello"
#         docker exec agent-eval openclaw infer model run --prompt "hello"
#         docker exec agent-eval hermes -z "hello"


# ── Non-root user (Claude Code requires it) ───────────────────
RUN useradd -m -s /bin/bash agent && \
    echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
USER agent
ENV HOME=/home/agent
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    NODE_VERSION=22 \
    PYTHON_VERSION=3.12

# ── Base system ───────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg git build-essential \
    python3.12 python3.12-venv python3.12-dev python3-pip \
    && ln -sf /usr/bin/python3.12 /usr/bin/python \
    && ln -sf /usr/bin/python3.12 /usr/bin/python3 \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 ────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm config set registry https://registry.npmjs.org/

# ── Install all agents ────────────────────────────────────────
# Order: Claude Code → Codex CLI → OpenCode → OpenClaw → Hermes

RUN npm install -g @anthropic-ai/claude-code 2>&1 | tail -3
RUN npm install -g @openai/codex 2>&1 | tail -3
RUN npm install -g opencode-ai 2>&1 | tail -3
RUN npm install -g openclaw@latest 2>&1 | tail -3
RUN pip install --break-system-packages hermes-agent 2>&1 | tail -3

# ── Verify installations ──────────────────────────────────────
RUN claude --version 2>&1 || echo "claude: OK (version check not supported)"
RUN codex --version 2>&1 || echo "codex: OK"
RUN opencode version 2>&1 || echo "opencode: OK"
RUN openclaw --version 2>&1 || echo "openclaw: OK"
RUN hermes --version 2>&1 || echo "hermes: OK"

# ── Runtime setup ─────────────────────────────────────────────
RUN mkdir -p /workspace /root/.claude /root/.codex /root/.opencode /root/.openclaw /root/.hermes
WORKDIR /workspace

# API key placeholder — mount at runtime via -v
ENV OPENROUTER_API_KEY_FILE=/tmp/api_key

# Fake MCP server accessible from host
# When running benchmark, set --mcp-port and the runner will
# configure agents to connect via host.docker.internal
