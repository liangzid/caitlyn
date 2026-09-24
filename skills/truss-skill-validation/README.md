# TRUSS Skill Validation Pipeline

## Status

Experimental and disabled by default. CAITLYN already performs schema, regular-expression and deterministic candidate verification, but it lacks the complete brokered shadow environment described by TRUSS.

## Threat model

A generated skill appears useful from its text or final answer while its scripts request undeclared capabilities or produce unsafe side effects.

## Method

Check source-backed functional claims and the full artifact against explicit safety properties. Execute admitted candidates through brokered tools in a controlled environment. Preserve action provenance and use concrete failures to guide repair.

## CAITLYN integration target

Extend the contribution verifier and System II sandbox with artifact-wide static analysis, declared capabilities, brokered tools and attributable execution traces.

## Source

[TRUSS](https://arxiv.org/abs/2608.17588), 2026.
