# Cost-Triggered Escalation Coordinator

## Status

Active Tier 1 reference knowledge. CAITLYN also implements escalation decisions in its runtime configuration and scanner.

## Purpose

Balances fast-path cost against source trust and task risk, escalating ambiguous or high-impact content to broader language-model analysis.

## Execution

The scanner implements `safe`, `aggressive` and `off` escalation policies. This skill explains the decision principles used by merged Tier 1.

## Limitations

Escalation changes cost and latency but does not itself detect an attack. Thresholds require deployment-specific calibration.
