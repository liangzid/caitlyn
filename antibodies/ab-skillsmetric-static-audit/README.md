# SkillsMetric Static Skill Auditor

## Status

Experimental and disabled by default. The current contribution verifier covers regular-expression safety and executable presence, but not full data-flow or capability analysis.

## Threat model

An imported Agent Skill contains malicious scripts, anomalous dependencies, undeclared data flow or capabilities inconsistent with its stated purpose.

## Method

Score the complete package across pattern density, statistical anomaly, data-flow taint, import anomaly and capability mismatch. Escalate known static-analysis blind spots to sandbox execution and semantic review.

## Important limitation

The source reports weak coverage for natural-language prompt injection and ordinary-command host destruction. This skill must be combined with TRUSS-style execution and composition analysis.

## Source

[SkillsMetric](https://arxiv.org/abs/2608.08468), 2026.
