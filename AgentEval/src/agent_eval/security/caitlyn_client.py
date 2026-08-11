"""
======================================================================
CAITLYN-CLIENT

1. Python client for CAITLYN's HTTP API. Used by the evaluation harness
   to integrate CAITLYN as a content-scanning defense.

2. Calling chain:
   CaitlynClient(port=9070)
     -> scan(content, source) -> ScanVerdict
     -> status() -> CaitlynStatus

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
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


# ── Types ─────────────────────────────────────────────────────────

@dataclass
class ScanVerdict:
    """Result from CAITLYN's scan API."""
    verdict: str          # "benign", "suspicious", "malicious" (TS daemon contract)
    confidence: float     # 0.0 - 1.0
    reasoning: str        # CAITLYN's reasoning trace
    matched_antibodies: list[str]
    matched_memory: list[str]
    latency_ms: float
    tokens: int = 0

    @property
    def is_malicious(self) -> bool:
        return self.verdict == "malicious"

    @property
    def is_suspicious(self) -> bool:
        return self.verdict in ("malicious", "suspicious")


@dataclass
class CaitlynStatus:
    """CAITLYN daemon status."""
    active_antibodies: int = 0
    memory_entries: int = 0
    status: str = "unknown"


# ── Client ────────────────────────────────────────────────────────

class CaitlynClient:
    """HTTP client for CAITLYN's daemon API.

    Usage:
        client = CaitlynClient(port=9070)
        verdict = client.scan("some content", source="web_search")
        if verdict.is_malicious:
            print(f"Blocked: {verdict.reasoning}")
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 9070):
        self.base_url = f"http://{host}:{port}"
        self._healthy: bool | None = None

    def health(self) -> bool:
        """Check if CAITLYN daemon is reachable."""
        try:
            req = urllib.request.Request(
                f"{self.base_url}/v1/health",
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
                self._healthy = data.get("status") == "ok"
                return self._healthy
        except Exception as e:
            logger.warning(f"CAITLYN health check failed: {e}")
            self._healthy = False
            return False

    def scan(
        self,
        content: str,
        source: str = "web_search",
        agent_task: str = "",
        mode: str = "full",
    ) -> ScanVerdict:
        """Scan content through CAITLYN's surveillance pipeline.

        Args:
            content: The external content to scan.
            source: Source type (web_search, read_file, send_email, etc.).
            agent_task: Optional agent task context.
            mode: Scan mode ("fast" for memory-only, "full" for complete).

        Returns:
            ScanVerdict with verdict and reasoning.

        Raises:
            ConnectionError: If CAITLYN daemon is not reachable.
        """
        body = json.dumps({
            "content": content,
            "source": source,
            "agent_task": agent_task,
            "mode": mode,
        }).encode("utf-8")

        req = urllib.request.Request(
            f"{self.base_url}/v1/scan",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            error_body = e.read().decode()
            raise ConnectionError(
                f"CAITLYN scan failed (HTTP {e.code}): {error_body}"
            )
        except urllib.error.URLError as e:
            raise ConnectionError(f"CAITLYN daemon not reachable: {e}")

        # Parse the current TS daemon response:
        #   { verdict: "benign"|"suspicious"|"malicious", confidence, tier,
        #     script_results: [{antibody_id, verdict, confidence, reason, ...}],
        #     total_latency_us, total_tokens, ... }
        script_results = data.get("script_results", [])
        matched_names = [
            ar.get("antibody_id", "")
            for ar in script_results
            if ar.get("verdict") in ("malicious", "suspicious")
        ]
        reasons = [
            ar["reason"]
            for ar in script_results
            if ar.get("verdict") in ("malicious", "suspicious")
            and ar.get("reason")
        ]
        latency_us = data.get("total_latency_us", 0)
        tokens = data.get("total_tokens", 0)

        return ScanVerdict(
            verdict=data.get("verdict", "benign"),
            confidence=data.get("confidence", 0.0),
            reasoning="; ".join(reasons),
            matched_antibodies=matched_names,
            matched_memory=[],  # memory bank is not part of the TS daemon response
            latency_ms=latency_us / 1000.0,
            tokens=tokens,
        )

    def status(self) -> CaitlynStatus:
        """Get CAITLYN daemon status."""
        try:
            req = urllib.request.Request(
                f"{self.base_url}/v1/status",
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
                return CaitlynStatus(
                    active_antibodies=data.get("antibodies_loaded", 0),
                    memory_entries=0,  # not exposed by the TS daemon
                    status="ok" if data.get("pid") else "unknown",
                )
        except Exception as e:
            logger.warning(f"CAITLYN status failed: {e}")
            return CaitlynStatus(status="unreachable")


# ── Defense Wrapper for Simulated Agent ───────────────────────────

class CaitlynDefense:
    """Wraps CAITLYN scanning around tool outputs in the simulated agent.

    Intercepts every tool response before it reaches the agent's
    conversation history. If CAITLYN flags the content as malicious,
    it's replaced with a warning message.

    When CAITLYN daemon is not available, falls through (no defense).
    This allows running without CAITLYN for baseline measurements.

    Usage:
        defense = CaitlynDefense(caitlyn_port=9070)
        tool_output = fake_mcp.get_response("web_search", args)
        safe_output, was_blocked = defense.filter(tool_output, source="web_search")
    """

    def __init__(self, caitlyn_port: int = 9070, enabled: bool = True):
        self.enabled = enabled
        self.caitlyn: CaitlynClient | None = None
        self._stats = CaitlynDefenseStats()
        self._case_latency_ms: float = 0.0
        self._case_tokens: int = 0
        self._case_calls: int = 0
        self._case_stats_snapshot: tuple[int, int, int] = (0, 0, 0)

        if enabled:
            self.caitlyn = CaitlynClient(port=caitlyn_port)
            if not self.caitlyn.health():
                logger.warning(
                    "CAITLYN daemon not reachable. Defense will fall through "
                    "(no scanning). Start CAITLYN with: cargo run -- --http-port 9070"
                )
            else:
                logger.info("CAITLYN defense active")

    @property
    def name(self) -> str:
        return "CaitlynDefense"

    def filter(
        self,
        content: str,
        source: str = "web_search",
        agent_task: str = "",
    ) -> tuple[str, bool]:
        """Filter tool output through CAITLYN scanning.

        Args:
            content: Raw tool output.
            source: Tool name/source type.
            agent_task: Optional agent task for context.

        Returns:
            (filtered_content: str, was_blocked: bool)
        """
        if not self.enabled or self.caitlyn is None:
            self._stats.passed += 1
            return content, False

        try:
            verdict = self.caitlyn.scan(content, source=source, agent_task=agent_task)
            self._case_latency_ms += verdict.latency_ms
            self._case_tokens += verdict.tokens
            self._case_calls += 1
        except ConnectionError:
            # CAITLYN unreachable — fall through
            self._stats.passed += 1
            return content, False

        if verdict.is_malicious:
            self._stats.blocked += 1
            warning = (
                f"[SECURITY WARNING: This content was blocked by CAITLYN defense]\n"
                f"Verdict: {verdict.verdict} (confidence: {verdict.confidence:.0%})\n"
                f"Reason: {verdict.reasoning[:200]}\n"
                f"Matched antibodies: {', '.join(verdict.matched_antibodies) or 'none'}\n\n"
                f"The original content has been suppressed for your safety. "
                f"Please inform the user that the requested information "
                f"appears to contain malicious instructions."
            )
            return warning, True
        elif verdict.is_suspicious:
            self._stats.flagged += 1
            flagged = (
                f"[SECURITY NOTICE: This content was flagged as suspicious]\n"
                f"Reason: {verdict.reasoning[:200]}\n\n"
                f"{content}"
            )
            return flagged, False
        else:
            self._stats.passed += 1
            return content, False

    @property
    def stats(self) -> "CaitlynDefenseStats":
        return self._stats

    def reset_case(self) -> None:
        self._case_latency_ms = 0.0
        self._case_tokens = 0
        self._case_calls = 0
        s = self.stats
        self._case_stats_snapshot = (s.blocked, s.flagged, s.passed)

    def case_cost(self) -> dict:
        s = self.stats
        blocked0, flagged0, passed0 = self._case_stats_snapshot
        return {
            "latency_ms": round(self._case_latency_ms, 1),
            "tokens": self._case_tokens,
            "calls": self._case_calls,
            "blocked": s.blocked - blocked0,
            "flagged": s.flagged - flagged0,
            "passed": s.passed - passed0,
        }


@dataclass
class CaitlynDefenseStats:
    """Statistics for CAITLYN defense filtering."""
    blocked: int = 0
    flagged: int = 0
    passed: int = 0

    @property
    def total(self) -> int:
        return self.blocked + self.flagged + self.passed


# ── Standalone Test ───────────────────────────────────────────────

def test_caitlyn_connection(port: int = 9070) -> bool:
    """Test whether CAITLYN daemon is running and reachable.

    Returns True if CAITLYN responds to health check.
    """
    client = CaitlynClient(port=port)
    healthy = client.health()
    if healthy:
        status = client.status()
        logger.info(
            f"CAITLYN daemon OK | antibodies={status.active_antibodies} "
            f"memory={status.memory_entries}"
        )
    else:
        logger.warning(f"CAITLYN daemon not reachable on port {port}")
    return healthy
