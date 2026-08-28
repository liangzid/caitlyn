# AgentFlow Stateful Flow Policy

## Status

Experimental and disabled by default. This entry records the policy contract; CAITLYN does not yet provide value-level taint propagation or an SMT verifier.

## Threat model

Sensitive data reaches an unauthorized tool, sink, or delegated agent through a sequence of individually plausible actions.

## Method

Label runtime edges with provenance, sensitivity, destination and authority. Enforce flow and path rules using a stateful reference monitor. Permit controlled release only through an explicit policy rule.

## Required runtime support

- Persistent labels attached to values and effects
- A task-scoped capability store
- Cross-tool and cross-agent path tracking
- A deterministic policy evaluator

## Source

[AgentFlow](https://arxiv.org/abs/2608.22868), 2026.
