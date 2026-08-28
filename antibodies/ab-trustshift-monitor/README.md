# TrustShift Stateful MCP Monitor

## Status

Experimental and disabled by default. The underlying work was posted on 24 August 2026 and requires temporal evaluation before activation.

## Threat model

An MCP server behaves normally during inspection and early use, then switches to malicious output after it has accumulated trust. Static package scanning cannot observe the transition.

## Method

Maintain an identity-bound behavioral baseline for each MCP server. Inspect structural violations, semantic corruption and expansion of requested scope. Treat prior benign behavior as evidence for drift detection, not as authorization.

## Required runtime support

- Stable server identity
- Stateful response and effect summaries
- Baseline update and drift policies
- Evaluation against legitimate server upgrades

## Source

[TrustShiftProbe](https://arxiv.org/abs/2608.23763), 2026.
