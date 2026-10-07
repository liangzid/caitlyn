# CompoSkill Chain Auditor

## Status

Experimental and disabled by default. The method studies composition attacks, so scanning one directory at a time is insufficient.

## Threat model

Each installed skill passes individual review, but a chain of their outputs, capabilities or side effects forms an unsafe workflow.

## Method

Construct a graph whose nodes declare data inputs, outputs, capabilities and effects. Evaluate complete paths for authority amplification, sensitive-data transfer and unsafe side-effect composition.

## Required runtime support

- Capability and effect declarations for every skill
- A composition graph covering actual invocation paths
- Path-level policy evaluation during admission and execution

## Source

[CompoSkill](https://arxiv.org/abs/2608.16246), 2026.
