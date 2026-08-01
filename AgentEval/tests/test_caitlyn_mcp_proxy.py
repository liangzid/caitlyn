"""Tests for the CAITLYN MCP proxy: output scanning, real HTTP
forwarding, in-process fallback, and tool parameter schema registration."""

import inspect

import pytest
from unittest.mock import MagicMock

from agent_eval.security.caitlyn_client import ScanVerdict
from agent_eval.security.caitlyn_mcp_proxy import CaitlynMCPProxy, FastMCPProxy
from agent_eval.security.fake_mcp import (
    HTTPScenarioServer,
    TestScenario,
    ToolResponse,
    set_active_scenario,
)


def make_scenario():
    scenario = TestScenario(scenario_id="proxy-test", task_description="test")
    scenario.tool_responses = {
        "web_search": [ToolResponse(content="search result one", is_injection=False)],
        "read_file": [ToolResponse(content="file contents", is_injection=False)],
    }
    return scenario


def test_scan_tool_output_blocks_malicious():
    proxy = CaitlynMCPProxy(caitlyn_port=0)
    proxy.caitlyn = MagicMock()
    proxy.caitlyn.scan.return_value = ScanVerdict(
        verdict="malicious",
        confidence=0.95,
        reasoning="exfiltration attempt",
        matched_antibodies=["ab-x"],
        matched_memory=[],
        latency_ms=5.0,
    )
    output, blocked = proxy.scan_tool_output("web_search", "secret dump")
    assert blocked is True
    assert "[SECURITY BLOCKED" in output
    assert "exfiltration attempt" in output


def test_scan_tool_output_passes_benign():
    proxy = CaitlynMCPProxy(caitlyn_port=0)
    proxy.caitlyn = MagicMock()
    proxy.caitlyn.scan.return_value = ScanVerdict(
        verdict="benign",
        confidence=0.99,
        reasoning="clean",
        matched_antibodies=[],
        matched_memory=[],
        latency_ms=2.0,
    )
    output, blocked = proxy.scan_tool_output("web_search", "weather")
    assert blocked is False
    assert output == "weather"


def test_scan_tool_output_passes_when_daemon_unreachable():
    proxy = CaitlynMCPProxy(caitlyn_port=0)
    proxy.caitlyn = MagicMock()
    proxy.caitlyn.scan.side_effect = ConnectionError("daemon down")
    output, blocked = proxy.scan_tool_output("web_search", "anything")
    assert blocked is False
    assert output == "anything"


def test_handler_registers_named_parameter_schema():
    proxy = FastMCPProxy(fake_mcp_url="http://127.0.0.1:1", caitlyn_port=0)
    params = [
        {"name": "to", "type": "string", "description": "Recipient", "required": True},
        {"name": "subject", "type": "string", "description": "Subject", "required": True},
        {"name": "body", "type": "string", "description": "Body", "required": True},
    ]
    handler = proxy._make_handler_with_schema("send_email", "Send an email.", params)
    signature = inspect.signature(handler)
    assert list(signature.parameters) == ["to", "subject", "body"]
    assert all(p.annotation in (str, "str") for p in signature.parameters.values())
    assert "**kwargs" not in str(signature)


def test_http_forwarding_uses_network_endpoint():
    scenario = make_scenario()
    set_active_scenario(scenario)
    server = HTTPScenarioServer(port=0)
    server.start()
    port = server._httpd.server_address[1]
    try:
        proxy = FastMCPProxy(
            fake_mcp_url=f"http://127.0.0.1:{port}",
            caitlyn_port=0,
        )
        output = proxy._call_fake_mcp("web_search", {"query": "test"})
        assert output == "search result one"
        assert len(scenario.call_log) == 1
    finally:
        server.stop()


def test_http_forwarding_falls_back_to_in_process_scenario():
    scenario = make_scenario()
    set_active_scenario(scenario)
    proxy = FastMCPProxy(
        fake_mcp_url="http://127.0.0.1:1",  # nothing listens here
        caitlyn_port=0,
    )
    output = proxy._call_fake_mcp("read_file", {"path": "/tmp/x"})
    assert output == "file contents"


def test_forward_and_scan_returns_filtered_output():
    scenario = make_scenario()
    set_active_scenario(scenario)
    server = HTTPScenarioServer(port=0)
    server.start()
    port = server._httpd.server_address[1]
    try:
        proxy = FastMCPProxy(
            fake_mcp_url=f"http://127.0.0.1:{port}",
            caitlyn_port=0,
        )
        proxy.caitlyn_proxy.scan_tool_output = MagicMock(
            return_value=("[BLOCKED] filtered", True)
        )
        assert proxy._forward_and_scan("web_search", {"query": "x"}) == "[BLOCKED] filtered"
    finally:
        server.stop()
