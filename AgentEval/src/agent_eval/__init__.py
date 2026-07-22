"""
AgentEval - Unified LLM Agent Evaluation Framework

This package provides a unified Python interface for calling various LLM coding agents
via Docker containers. It supports multiple agent types with consistent API.

Usage:
    from agent_eval import get_caller, DEFAULT_MODEL

    caller = get_caller('nanobot')
    response = caller.call({'problem_statement': 'Fix this bug'}, model='openrouter/free')

Available agents:
    - nanobot: Nanobot AI agent
    - hermes: Hermes self-evolving agent
    - zeroclaw: ZeroClaw Rust agent
    - openclaw: OpenClaw coding assistant
    - kilo_code: Kilo Code CLI
    - opencode: OpenCode by SST
    - codex: OpenAI Codex CLI
    - claude_code: Claude Code
    - droid: Factory AI Droid
    - grok_cli: Grok CLI

Example:
    >>> from agent_eval import get_caller
    >>> caller = get_caller('nanobot')
    >>> response = caller.call({'problem_statement': 'What is 2+2?'})
    >>> print(response.success, response.output)
    True '4'
"""

from agent_eval.callers import get_caller, AgentCaller, AgentResponse, DEFAULT_MODEL

__version__ = "0.1.0"
__all__ = ["get_caller", "AgentCaller", "AgentResponse", "DEFAULT_MODEL"]
