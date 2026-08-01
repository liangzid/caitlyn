"""
======================================================================
CAITLYN-MCP-PROXY

1. An MCP proxy server that sits between an agent and the Fake MCP
   environment. Intercepts all tool responses and scans them through
   CAITLYN before delivering to the agent.

2. Calling chain:
   Agent (Claude Code / Codex / OpenCode)
     -> connects to CaitlynMCPProxy (port 9071, SSE)
     -> proxy forwards to Fake MCP Server (port 9876, SSE)
     -> gets tool output, calls CAITLYN HTTP API (/v1/scan)
     -> if SAFE: returns output to agent
     -> if MALICIOUS: replaces with warning

3. Modification history:
   - 2026-07-14: Initial implementation

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 14 July 2026
======================================================================
"""

from __future__ import annotations

import json
import logging
import urllib.request
import urllib.error
from typing import Any

from agent_eval.security.caitlyn_client import CaitlynClient, ScanVerdict

logger = logging.getLogger(__name__)

# Try to import FastMCP/Starlette for the proxy server
try:
    from mcp.server.fastmcp import FastMCP
    HAS_FASTMCP = True
except ImportError:
    HAS_FASTMCP = False
    logger.warning("FastMCP not available; proxy server requires 'mcp' package")


class CaitlynMCPProxy:
    """MCP proxy that scans tool outputs through CAITLYN.

    This proxy:
    1. Connects to the Fake MCP Server as a client
    2. Exposes identical tools to the agent
    3. Intercepts every tool response and scans it via CAITLYN
    4. Blocks or warns on malicious content

    The agent connects to this proxy instead of directly to Fake MCP.
    The proxy transparently adds defense without agent cooperation.

    Usage:
        proxy = CaitlynMCPProxy(
            fake_mcp_url="http://127.0.0.1:9876/sse",
            caitlyn_port=9070,
        )
        proxy.start(port=9071)
        # Agent connects to port 9071
    """

    def __init__(
        self,
        fake_mcp_url: str = "http://127.0.0.1:9876/sse",
        caitlyn_port: int = 9070,
    ):
        self.fake_mcp_url = fake_mcp_url
        self.caitlyn = CaitlynClient(port=caitlyn_port) if caitlyn_port > 0 else None
        self._blocked_count = 0
        self._passed_count = 0

    def scan_tool_output(
        self, tool_name: str, content: str
    ) -> tuple[str, bool]:
        """Scan a tool output through CAITLYN.

        Returns:
            (filtered_content, was_blocked)
        """
        if self.caitlyn is None:
            self._passed_count += 1
            return content, False

        try:
            verdict = self.caitlyn.scan(content, source=tool_name)
        except ConnectionError:
            self._passed_count += 1
            return content, False

        if verdict.is_malicious:
            self._blocked_count += 1
            warning = (
                f"[SECURITY BLOCKED by CAITLYN]\n"
                f"Verdict: {verdict.verdict} (confidence: {verdict.confidence:.0%})\n"
                f"Reason: {verdict.reasoning[:200]}\n\n"
                f"The original tool output was blocked for your safety."
            )
            return warning, True
        else:
            self._passed_count += 1
            return content, False

    @property
    def blocked(self) -> int:
        return self._blocked_count

    @property
    def passed(self) -> int:
        return self._passed_count


# ── FastMCP-based Proxy Server ────────────────────────────────────

class FastMCPProxy:
    """Proxy server built on FastMCP that wraps the Fake MCP Server.

    This creates a new MCP server that:
    - Has the same tools as the Fake MCP Server
    - Internally forwards calls to the Fake MCP via HTTP
    - Scans responses through CAITLYN before returning
    """

    def __init__(
        self,
        fake_mcp_url: str = "http://127.0.0.1:9876",
        caitlyn_port: int = 9070,
    ):
        if not HAS_FASTMCP:
            raise ImportError(
                "FastMCP is required for the proxy server. "
                "Install with: pip install mcp"
            )
        self.fake_mcp_url = fake_mcp_url
        self.caitlyn_proxy = CaitlynMCPProxy(
            fake_mcp_url=fake_mcp_url, caitlyn_port=caitlyn_port,
        )

    def build_server(self) -> Any:
        """Build and return a FastMCP server configured as a proxy.

        The returned server has the same tools as Fake MCP but
        each tool call is forwarded to Fake MCP and scanned by CAITLYN.
        """
        server = FastMCP(
            name="CAITLYN MCP Proxy",
            instructions=(
                "You have access to tools: web_search, read_file, "
                "list_directory, send_email, execute_bash, read_webpage. "
                "All tool outputs are automatically scanned for security threats."
            ),
        )

        # Register proxy tools for each Fake MCP tool
        for tool_name, tool_desc, params in self._tool_definitions():
            self._register_proxy_tool(server, tool_name, tool_desc, params)

        return server

    def _tool_definitions(self) -> list[tuple[str, str, list[dict]]]:
        """Return tool definitions matching Fake MCP Server."""
        return [
            ("web_search", "Search the web for information.",
             [{"name": "query", "type": "string",
               "description": "The search query string.", "required": True}]),
            ("read_file", "Read the contents of a file.",
             [{"name": "path", "type": "string",
               "description": "The path to the file.", "required": True}]),
            ("list_directory", "List the contents of a directory.",
             [{"name": "path", "type": "string",
               "description": "The path to list.", "required": True}]),
            ("send_email", "Send an email.",
             [{"name": "to", "type": "string",
               "description": "Recipient email.", "required": True},
              {"name": "subject", "type": "string",
               "description": "Email subject.", "required": True},
              {"name": "body", "type": "string",
               "description": "Email body.", "required": True}]),
            ("execute_bash", "Execute a bash command.",
             [{"name": "command", "type": "string",
               "description": "The bash command.", "required": True}]),
            ("read_webpage", "Fetch and read a webpage.",
             [{"name": "url", "type": "string",
               "description": "URL to fetch.", "required": True}]),
        ]

    def _register_proxy_tool(
        self, server: Any, tool_name: str, tool_desc: str,
        params: list[dict],
    ) -> None:
        """Register a single proxy tool on the FastMCP server."""
        handler = self._make_handler_with_schema(tool_name, tool_desc, params)
        handler.__name__ = tool_name
        handler.__doc__ = tool_desc

        server.tool()(handler)

    def _make_handler_with_schema(
        self, tool_name: str, tool_desc: str, params: list[dict],
    ) -> Any:
        """Build a handler whose signature registers the tool parameter
        schema (named, typed arguments instead of **kwargs)."""
        names = [p["name"] for p in params]
        signature = ", ".join(f"{name}: str" for name in names)
        call_args = ", ".join(f"{name!r}: {name}" for name in names)
        ns: dict[str, Any] = {
            "_proxy": self,
            "_tool_name": tool_name,
        }
        source = (
            f"def handler({signature}) -> str:\n"
            f"    return _proxy._forward_and_scan(_tool_name, {{{call_args}}})"
        )
        exec(source, ns)  # noqa: S102 - controlled local construction
        handler = ns["handler"]
        handler.__name__ = tool_name
        handler.__doc__ = tool_desc + "\n\nArgs:\n" + "\n".join(
            f"    {p['name']} ({p['type']}): {p['description']}" for p in params
        )
        return handler

    def _forward_and_scan(self, tool_name: str, arguments: dict) -> str:
        """Forward a tool call to Fake MCP and scan the output."""
        raw_output = self._call_fake_mcp(tool_name, arguments)
        filtered, _blocked = self.caitlyn_proxy.scan_tool_output(tool_name, raw_output)
        return filtered

    def _call_fake_mcp(self, tool_name: str, arguments: dict) -> str:
        """Call a tool on the Fake MCP Server over HTTP /tools/call.

        Falls back to the in-process scenario when the HTTP endpoint is
        unreachable (same-process harness setups).
        """
        url = self.fake_mcp_url.rstrip("/") + "/tools/call"
        body = json.dumps({"tool": tool_name, "arguments": arguments}).encode("utf-8")
        try:
            req = urllib.request.Request(
                url,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("content", "")
        except Exception as exc:  # noqa: BLE001 - network fallback
            logger.warning("HTTP forward to %s failed (%s); using in-process scenario", url, exc)
            from agent_eval.security.fake_mcp import get_active_scenario

            return get_active_scenario().get_response(tool_name, arguments)

    def start(self, port: int = 9071) -> None:
        """Start the proxy MCP server (blocking)."""
        server = self.build_server()
        logger.info(
            f"Starting CAITLYN MCP Proxy on port {port} "
            f"→ forwarding to Fake MCP at {self.fake_mcp_url}"
        )
        server.run(transport="sse", host="127.0.0.1", port=port)


# ── Standalone Runner ─────────────────────────────────────────────

def run_proxy(
    fake_mcp_port: int = 9876,
    proxy_port: int = 9071,
    caitlyn_port: int = 9070,
) -> None:
    """Run the CAITLYN MCP Proxy as a standalone server.

    Prerequisites:
    1. Fake MCP Server running on fake_mcp_port (--agent ... handles this)
    2. CAITLYN daemon running on caitlyn_port (cargo run -- --http-port 9070)

    Usage:
        python -m agent_eval.security.caitlyn_mcp_proxy
    """
    proxy = FastMCPProxy(
        fake_mcp_url=f"http://127.0.0.1:{fake_mcp_port}",
        caitlyn_port=caitlyn_port,
    )
    proxy.start(port=proxy_port)


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="CAITLYN MCP Proxy Server")
    p.add_argument("--fake-mcp-port", type=int, default=9876)
    p.add_argument("--proxy-port", type=int, default=9071)
    p.add_argument("--caitlyn-port", type=int, default=9070)
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO)
    run_proxy(
        fake_mcp_port=args.fake_mcp_port,
        proxy_port=args.proxy_port,
        caitlyn_port=args.caitlyn_port,
    )
