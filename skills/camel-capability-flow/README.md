# CaMeL Capability and Data-Flow Guard

## Status

Reference only. CaMeL is an architectural defense and cannot be implemented faithfully as a content-classification prompt.

## Threat model

An agent reads attacker-controlled data while holding tools and private values. The attacker attempts to redirect program flow or send sensitive values to an unauthorized sink.

## Method

Extract control flow from the trusted request before consuming untrusted data. Attach provenance and capabilities to runtime values. Enforce policies at every tool boundary so untrusted data cannot alter control flow or authorize a sensitive flow.

## Required runtime support

- A control-flow planner isolated from untrusted observations
- Value-level provenance and taint propagation
- Capability-aware tool wrappers
- Explicit source-to-sink policies

CAITLYN currently scans serialized text at each hook and does not preserve value-level provenance across calls.

## Source

Debenedetti et al., [Defeating Prompt Injections by Design](https://arxiv.org/abs/2503.18813), 2025.
