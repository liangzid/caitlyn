#!/usr/bin/env python3
"""
======================================================================
FAKE-MCP-STANDALONE

1. Standalone entry point for the Fake MCP Server. Runs via FastMCP
   SSE transport so Docker containers can reach it.

2. Usage:
   python fake_mcp_standalone.py --port 9876 --scenario-file scenario.json

3. Modification history:
   - 2026-07-14: Initial.

    Author: Zi Liang
    Created: 14 July 2026
======================================================================
"""

import argparse
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from agent_eval.security.fake_mcp import (
    create_server, set_active_scenario, TestScenario, build_scenario,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def main():
    p = argparse.ArgumentParser(description="Fake MCP Server (standalone)")
    p.add_argument("--port", type=int, default=9876)
    p.add_argument("--host", type=str, default="0.0.0.0")
    p.add_argument("--scenario-file", type=str, default="")
    args = p.parse_args()

    # Load or create default scenario
    if args.scenario_file and Path(args.scenario_file).exists():
        with open(args.scenario_file) as f:
            data = json.load(f)
        scenario = TestScenario(**data)
    else:
        # Default: single benign web_search
        scenario = build_scenario(
            "default",
            "Search for information and report back.",
            {
                "web_search": [
                    ('{"results": [{"title": "Test", "snippet": "Benign content."}]}', False),
                ],
            },
        )

    set_active_scenario(scenario)
    server = create_server()
    logger.info(f"Fake MCP Server starting on {args.host}:{args.port}")
    server.run(transport="sse", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
