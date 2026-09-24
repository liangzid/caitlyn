# General Prompt Injection Detector

## Status

Active Tier 0 detector and one of the three root skills described by the CAITLYN paper.

## Purpose

Detects direct instruction override, system-message impersonation, command-oriented payloads and common exfiltration language before content reaches the expensive classifier tier.

## Execution

The resident worker runs the compiled detector over raw content. A malicious result fires only when its confidence meets the configured threshold.

## Limitations

Signature matching is intentionally narrow. Semantic redirection and context-dependent authorization require Tier 1 or hook-level defenses.
