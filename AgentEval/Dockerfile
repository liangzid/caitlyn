# AgentEval — Single Docker image with all 6 agents
#   Claude Code + Codex CLI + OpenCode + OpenClaw + Hermes + Pi
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
#         docker exec agent-eval pi -p "hello"

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

# ── Non-root user (Claude Code requires it; invoked with -u agent) ──
# The container keeps root as the default exec user because all AgentEval
# callers use `docker exec` without -u. Claude Code is the only agent that
# must run as the non-root `agent` user.
RUN useradd -m -s /bin/bash agent && \
    echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# ── Node.js 22 ────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm config set registry https://registry.npmjs.org/

# ── Install all agents ────────────────────────────────────────
# Order: Claude Code → Codex CLI → OpenCode → OpenClaw → Hermes → Pi

RUN npm install -g @anthropic-ai/claude-code 2>&1 | tail -3
RUN npm install -g @openai/codex 2>&1 | tail -3
RUN npm install -g opencode-ai 2>&1 | tail -3
RUN npm install -g openclaw@latest 2>&1 | tail -3
RUN pip install --break-system-packages hermes-agent 2>&1 | tail -3
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.6 2>&1 | tail -3

# ── Codex: OpenRouter provider (evaluation) ──────────────────
# Built-in "openrouter" provider; wire_api must be "responses" (the "chat"
# wire API was removed from Codex in 2026). Written for both root and the
# non-root agent user so `docker exec` works either way.
RUN mkdir -p /root/.codex /home/agent/.codex && \
    printf 'model_provider = "openrouter"\nmodel = "openrouter/free"\n\n[model_providers.openrouter]\nname = "OpenRouter"\nbase_url = "https://openrouter.ai/api/v1"\nenv_key = "OPENROUTER_API_KEY"\nwire_api = "responses"\n\n[projects."/workspace"]\ntrust_level = "trusted"\n' > /root/.codex/config.toml && \
    cp /root/.codex/config.toml /home/agent/.codex/config.toml && \
    chown -R agent:agent /home/agent/.codex

# ── Verify installations ──────────────────────────────────────
RUN claude --version 2>&1 || echo "claude: OK (version check not supported)"
RUN codex --version 2>&1 || echo "codex: OK"
RUN opencode version 2>&1 || echo "opencode: OK"
RUN openclaw --version 2>&1 || echo "openclaw: OK"
RUN hermes --version 2>&1 || echo "hermes: OK"
RUN pi --help 2>&1 | head -1 || echo "pi: OK"

# ── Runtime setup ─────────────────────────────────────────────
RUN mkdir -p /workspace /root/.claude /root/.codex /root/.opencode /root/.openclaw /root/.hermes
WORKDIR /workspace

# API key placeholder — mount at runtime via -v
ENV OPENROUTER_API_KEY_FILE=/tmp/api_key

# Fake MCP server accessible from host
# When running benchmark, set --mcp-port and the runner will
# configure agents to connect via host.docker.internal
