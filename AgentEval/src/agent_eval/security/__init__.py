"""
AgentEval Security Evaluation Subpackage

Provides the evaluation harness for agent security testing:
- Fake MCP Server: controlled tool outputs for injection testing
- Test Cases: schema and loaders from CAITLYN valsets
- Harness: orchestration, compromise detection, metrics
"""

from agent_eval.security.fake_mcp import (
    FakeMCPServer,
    TestScenario,
    ToolResponse,
    ToolCallRecord,
    set_active_scenario,
    get_active_scenario,
    create_server,
    run_server,
    build_scenario,
)

from agent_eval.security.test_cases import (
    SecurityTestCase,
    ControlledToolResponse,
    to_test_scenario,
    load_from_agentdojo_jsonl,
    load_natural_cases,
    load_emerging_challenge_cases,
    create_smoke_test_benign,
    create_smoke_test_attack,
)

from agent_eval.security.harness import (
    SecurityHarness,
    AgentSecurityResponse,
    SecurityMetrics,
    detect_compromise,
)

__all__ = [
    # Fake MCP
    "FakeMCPServer",
    "TestScenario",
    "ToolResponse",
    "ToolCallRecord",
    "set_active_scenario",
    "get_active_scenario",
    "create_server",
    "run_server",
    "build_scenario",
    # Test Cases
    "SecurityTestCase",
    "ControlledToolResponse",
    "to_test_scenario",
    "load_from_agentdojo_jsonl",
    "load_natural_cases",
    "load_emerging_challenge_cases",
    "create_smoke_test_benign",
    "create_smoke_test_attack",
    # Harness
    "SecurityHarness",
    "AgentSecurityResponse",
    "SecurityMetrics",
    "detect_compromise",
]
from agent_eval.security.simulated_agent import (
    SimulatedAgent,
    SimulatedAgentResult,
    run_smoke_test,
)
from agent_eval.security.caitlyn_client import (
    CaitlynClient,
    CaitlynDefense,
    CaitlynDefenseStats,
    ScanVerdict,
    CaitlynStatus,
    test_caitlyn_connection,
)
from agent_eval.security.defenses import (
    Defense,
    DefenseStats,
    NoneDefense,
    LLMJudgeDefense,
    LLMJudgeFewshotDefense,
    RegexGuardDefense,
    create_defense,
)
