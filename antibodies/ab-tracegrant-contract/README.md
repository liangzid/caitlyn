# TraceGrant Task-Effect Contract

## Status

Experimental and disabled by default. This entry defines the required contract but does not claim reproduction of the reported system.

## Threat model

An action may pass an isolated pre-call check while its arguments, provider state, delivered effect or completion claim later diverge from the authorized task.

## Method

Create a task-effect contract from trusted user intent. Admit runtime evidence without granting it new authority. Bind tool calls to authorized effects, then verify actual provider results before declaring the task complete.

## Required input

- Trusted user intent and effect boundaries
- Tool call and result provenance
- Provider effect receipts
- Persistent trajectory state

## Source

[TraceGrant](https://arxiv.org/abs/2608.21126), 2026.
