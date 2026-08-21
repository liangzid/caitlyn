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

import json
import os
import subprocess
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from agent_eval.api_keys import get_openrouter_api_key

DEFAULT_MODEL = "openrouter/free"
CONTAINER = os.environ.get("AGENT_EVAL_CONTAINER", "agent-eval")


@dataclass
class AgentResponse:
    success: bool
    output: str
    error: str | None
    duration: float
    task_id: str
    usage: dict[str, Any] | None = None


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
    """✅ openclaw agent (Gateway/embedded loop) via OpenRouter.

    Uses `openclaw agent --local` instead of `openclaw infer model run`:
    the bare inference command has no tool loop, so the agent can never
    call the Fake MCP tools and the injection is never delivered.
    """
    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        prompt = task_input.get("problem_statement", task_input.get("task_id", ""))
        api_key = get_openrouter_api_key()
        cmd = [
            "docker", "exec", "-e", f"OPENROUTER_API_KEY={api_key}",
            CONTAINER,
            "openclaw", "agent", "--local",
            # Unique session per call so previous turns never leak into
            # the next test case.
            "--session-id", f"{task_input.get('task_id', 'eval')}-{uuid.uuid4().hex[:8]}",
            "--json",
            "--model", f"openrouter/{model}",
            "--message", prompt,
        ]
        # Parallel eval workers can run on isolated agents (independent
        # workspace and session storage) to avoid cross-worker file writes.
        agent_id = os.environ.get("OPENCLAW_EVAL_AGENT", "")
        if agent_id:
            cmd.insert(cmd.index("--local") + 1, "--agent")
            cmd.insert(cmd.index("--local") + 2, agent_id)
        result = _run_command(cmd, task_input.get("task_id", ""), timeout)
        if result.success and result.output:
            try:
                data = json.loads(result.output)
                text = (
                    data.get("finalAssistantVisibleText")
                    or data.get("finalAssistantRawText")
                )
                if not text:
                    text = "\n".join(
                        p.get("text", "")
                        for p in data.get("payloads", [])
                        if p.get("text")
                    )
                if not text:
                    text = result.output
                return AgentResponse(
                    success=True,
                    output=text,
                    error=None,
                    duration=result.duration,
                    task_id=result.task_id,
                )
            except json.JSONDecodeError:
                pass
        return result


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
        import time as _time

        prompt = task_input.get("problem_statement", task_input.get("task_id", ""))
        api_key = get_openrouter_api_key()
        usage_path = f"/tmp/hermes_usage_{uuid.uuid4().hex}.json"
        cmd = [
            "docker", "exec",
        ]
        # Parallel eval workers run hermes in isolated container workdirs so
        # agent-created files cannot leak across workers. Default is the
        # container /workspace, preserving the original single-worker setup.
        workdir = os.environ.get("HERMES_EVAL_WORKDIR", "")
        if workdir:
            cmd += ["-w", workdir]
        cmd += [
            "-e", f"OPENROUTER_API_KEY={api_key}",
            CONTAINER,
            "hermes", "-z", prompt,
            "--provider", "openrouter",
            "--model", model,
            "--usage-file", usage_path,
        ]
        task_id = task_input.get("task_id", "")
        start = _time.time()
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            result = AgentResponse(
                success=proc.returncode == 0,
                output=proc.stdout,
                error=proc.stderr if proc.returncode != 0 else None,
                duration=_time.time() - start,
                task_id=task_id,
            )
        except subprocess.TimeoutExpired:
            # docker exec timeout leaves the in-container hermes process
            # running, which would keep spending API budget and pollute the
            # workspace. Kill it by its unique --usage-file path, which is
            # part of the process cmdline.
            try:
                subprocess.run(
                    ["docker", "exec", CONTAINER, "pkill", "-f", usage_path],
                    capture_output=True, timeout=15, check=False,
                )
            except Exception:
                pass
            result = AgentResponse(
                success=False, output="",
                error=f"Timeout after {timeout}s", duration=timeout,
                task_id=task_id,
            )
        usage: dict[str, Any] | None = None
        try:
            read = subprocess.run(
                ["docker", "exec", CONTAINER, "cat", usage_path],
                capture_output=True, text=True, timeout=30,
            )
            if read.returncode == 0 and read.stdout.strip():
                usage = json.loads(read.stdout)
        except Exception:
            usage = None
        try:
            subprocess.run(
                ["docker", "exec", CONTAINER, "rm", "-f", usage_path],
                capture_output=True, timeout=10, check=False,
            )
        except Exception:
            pass
        result.usage = usage
        return result


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

    def _ensure_codex_binary(self) -> None:
        """Restore the codex platform binary if the container lost it.

        The agent-eval images have repeatedly lost
        vendor/.../bin/codex (disk/overlay flakiness and a codex npm alias
        layout), which makes every `codex exec` fail with "Missing
        optional dependency". A local copy of the 0.144.4-linux-x64
        tarball is kept at /tmp/codex-fix and copied back on demand.
        """
        probe = subprocess.run(
            ["docker", "exec", CONTAINER, "bash", "-lc",
             "test -x /usr/lib/node_modules/@openai/codex-linux-x64/"
             "vendor/x86_64-unknown-linux-musl/bin/codex || "
             "test -x /usr/lib/node_modules/@openai/codex/node_modules/"
             "@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if probe.returncode == 0:
            return
        src = "/tmp/codex-fix/package/vendor/x86_64-unknown-linux-musl/bin/codex"
        if not os.path.exists(src):
            print("CODEX_BINARY_MISSING_AND_NO_LOCAL_COPY", flush=True)
            return
        targets = [
            "/usr/lib/node_modules/@openai/codex-linux-x64/"
            "vendor/x86_64-unknown-linux-musl/bin/codex",
            "/usr/lib/node_modules/@openai/codex/node_modules/@openai/"
            "codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
        ]
        for target in targets:
            subprocess.run(
                ["docker", "exec", CONTAINER, "bash", "-lc",
                 f"mkdir -p $(dirname {target})"],
                capture_output=True,
                text=True,
                timeout=30,
            )
            copied = subprocess.run(
                ["docker", "cp", src, f"{CONTAINER}:{target}"],
                capture_output=True,
                text=True,
                timeout=120,
            )
            if copied.returncode == 0:
                subprocess.run(
                    ["docker", "exec", CONTAINER, "chmod", "+x", target],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                print(f"CODEX_BINARY_RESTORED {target}", flush=True)

    def call(self, task_input, timeout=300, model=DEFAULT_MODEL):
        prompt = task_input.get("problem_statement", task_input.get("task_id", ""))
        api_key = get_openrouter_api_key()
        self._ensure_codex_binary()
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
