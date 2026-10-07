# Tool-Interface Firewall

## Status

Active as merged Tier 1 reference knowledge. The scanner does not yet perform schema-aware argument minimization or structured output sanitization.

## Purpose

Reduces the attack surface at tool boundaries by minimizing inputs before a call and sanitizing instruction-like output before it reaches the agent.

## Intended execution

Apply deterministic schema transformations where possible and preserve original plus sanitized forms for audit.

## Limitations

Free-text sanitization can remove legitimate data or miss semantic instructions. Tool-specific schemas and provenance are required.
