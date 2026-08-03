"""
Agent Caller Module — unified interface for all coding agents.
All agents run inside a single Docker container (`agent-eval`).

Verified agents: openclaw ✅, opencode ✅, hermes ✅
Needs auth config: claude_code, codex

Usage:
    from agent_eval import get_caller
    caller = get_caller('opencode')
    response = caller.call({'problem_statement': 'Fix this bug'}, timeout=120)
"""

from __future__ import annotations

import subprocess
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from agent_eval.api_keys import get_openrouter_api_key

DEFAULT_MODEL = "openrouter/free"
CONTAINER = "agent-eval"


@dataclass
class AgentResponse:
    success: bool
    output: str
    error: str | None
    duration: float
    task_id: str


class AgentCaller(ABC):
    @abstractmethod
    def call(
        self, task_input: dict[str, Any], timeout: int = 300,
        model: str = DEFAULT_MODEL,
    ) -> AgentResponse: ...


def _run_command(cmd: list[str], task_id: str, timeout: int) -> AgentResponse:
    import time
    start = time.time()
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return AgentResponse(
            success=result.returncode == 0,
            output=result.stdout,
            error=result.stderr if result.returncode != 0 else None,
            duration=time.time() - start,
            task_id=task_id,
        )
    except subprocess.TimeoutExpired:
        return AgentResponse(
            success=False, output="",
            error=f"Timeout after {timeout}s", duration=timeout, task_id=task_id,
        )


# ── Verified callers ──────────────────────────────────────────────

class OpenClawCaller(AgentCaller):
    """✅ Verified: openclaw infer model run via OpenRouter"""
    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        prompt = task_input.get("problem_statement", task_input.get("task_id", ""))
        api_key = get_openrouter_api_key()
        cmd = [
            "docker", "exec", "-e", f"OPENROUTER_API_KEY={api_key}",
            CONTAINER,
            "openclaw", "infer", "model", "run",
            "--local",
            "--model", f"openrouter/{model}",
            "--prompt", prompt,
        ]
        return _run_command(cmd, task_input.get("task_id", ""), timeout)


class OpenCodeCaller(AgentCaller):
    """✅ Verified: opencode run -m openrouter/{model}"""
    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        prompt = task_input.get("problem_statement", task_input.get("task_id", ""))
        api_key = get_openrouter_api_key()
        cmd = [
            "docker", "exec", "-e", f"OPENROUTER_API_KEY={api_key}",
            CONTAINER,
            "opencode", "run", "-m", f"openrouter/{model}", prompt,
        ]
        return _run_command(cmd, task_input.get("task_id", ""), timeout)


class HermesCaller(AgentCaller):
    """✅ Verified: hermes -z --provider openrouter --model {model}"""
    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        prompt = task_input.get("problem_statement", task_input.get("task_id", ""))
        api_key = get_openrouter_api_key()
        cmd = [
            "docker", "exec", "-e", f"OPENROUTER_API_KEY={api_key}",
            CONTAINER,
            "hermes", "-z", prompt,
            "--provider", "openrouter",
            "--model", model,
        ]
        return _run_command(cmd, task_input.get("task_id", ""), timeout)


# ── Needs auth config ─────────────────────────────────────────────

class ClaudeCodeCaller(AgentCaller):
    """⚠️ Needs Anthropic auth (not OpenRouter). Non-root user required."""
    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        prompt = task_input.get("problem_statement", task_input.get("task_id", ""))
        api_key = get_openrouter_api_key()
        cmd = [
            "docker", "exec", "-u", "agent", "-e", f"OPENROUTER_API_KEY={api_key}",
            CONTAINER,
            "claude", "--dangerously-skip-permissions", "-p", prompt,
        ]
        return _run_command(cmd, task_input.get("task_id", ""), timeout)


class CodexCaller(AgentCaller):
    """Codex CLI via OpenRouter.

    Requires ~/.codex/config.toml in the container to define the
    "openrouter" model provider (see AgentEval/Dockerfile). The old
    `-c provider=openrouter` override is not a valid Codex config key and
    silently falls back to the OpenAI provider.
    """
    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        prompt = task_input.get("problem_statement", task_input.get("task_id", ""))
        api_key = get_openrouter_api_key()
        cmd = [
            "docker", "exec", "-e", f"OPENROUTER_API_KEY={api_key}",
            CONTAINER,
            "codex", "exec",
            "--full-auto", "--skip-git-repo-check",
            "-c", f"model={model}",
            prompt,
        ]
        return _run_command(cmd, task_input.get("task_id", ""), timeout)


class PiCaller(AgentCaller):
    """pi-coding-agent (Earendil Works) via OpenRouter.

    model must be a bare OpenRouter slug without the "openrouter/" provider
    prefix, e.g. "deepseek/deepseek-chat" or "cohere/north-mini-code:free".
    The "openrouter/free" alias is not part of pi's built-in model registry.
    """
    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        prompt = task_input.get("problem_statement", task_input.get("task_id", ""))
        api_key = get_openrouter_api_key()
        cmd = [
            "docker", "exec", "-e", f"OPENROUTER_API_KEY={api_key}",
            CONTAINER, "pi", "-p", "--provider", "openrouter",
            "--model", f"openrouter/{model}", prompt,
        ]
        return _run_command(cmd, task_input.get("task_id", ""), timeout)


# ── Legacy (not in current container) ─────────────────────────────

class ZeroClawCaller(AgentCaller):
    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        prompt = task_input.get("problem_statement", task_input.get("task_id", ""))
        return _run_command([
            "docker", "exec", CONTAINER, "zeroclaw", "agent", "-m", prompt,
        ], task_input.get("task_id", ""), timeout)


class NanobotCaller(AgentCaller):
    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        prompt = task_input.get("problem_statement", task_input.get("task_id", ""))
        return _run_command([
            "docker", "exec", CONTAINER, "nanobot", "agent", "-m", prompt, "--no-markdown",
        ], task_input.get("task_id", ""), timeout)


class KiloCodeCaller(AgentCaller):
    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        prompt = task_input.get("problem_statement", task_input.get("task_id", ""))
        return _run_command([
            "docker", "exec", CONTAINER, "kilo", "run", "-m", model, "--auto", prompt,
        ], task_input.get("task_id", ""), timeout)


class CursorCaller(AgentCaller):
    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        return _run_command([
            "cursor", "--task", task_input.get("task_id", ""),
        ], task_input.get("task_id", ""), timeout)


class DroidCaller(AgentCaller):
    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        prompt = task_input.get("problem_statement", task_input.get("task_id", ""))
        api_key = get_openrouter_api_key()
        return _run_command([
            "docker", "exec", "-e", f"FACTORY_API_KEY={api_key}",
            CONTAINER, "droid", "exec", prompt,
        ], task_input.get("task_id", ""), timeout)


class ZedCaller(AgentCaller):
    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        return _run_command([
            "zed", "--task", task_input.get("task_id", ""),
        ], task_input.get("task_id", ""), timeout)


# ── Registry ──────────────────────────────────────────────────────

CLAW_STYLE_CALLERS = {
    "openclaw": OpenClawCaller,
    "zeroclaw": ZeroClawCaller,
    "nanobot": NanobotCaller,
    "hermes": HermesCaller,
}

CODING_STYLE_CALLERS = {
    "claude_code": ClaudeCodeCaller,
    "cursor": CursorCaller,
    "opencode": OpenCodeCaller,
    "pi": PiCaller,
    "kilo_code": KiloCodeCaller,
    "codex": CodexCaller,
    "droid": DroidCaller,
    "zed": ZedCaller,
}


def get_caller(agent_type: str) -> AgentCaller:
    if agent_type in CLAW_STYLE_CALLERS:
        return CLAW_STYLE_CALLERS[agent_type]()
    if agent_type in CODING_STYLE_CALLERS:
        return CODING_STYLE_CALLERS[agent_type]()
    raise ValueError(f"Unknown agent: {agent_type}")
