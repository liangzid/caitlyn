# Task Shield Alignment Gate

## Status

Experimental and disabled by default. This entry specifies a CAITLYN adapter contract. It is not a claim that the complete Task Shield system has been reproduced.

## Threat model

Indirect content can propose new actions that are syntactically harmless but unrelated to the trusted user request. Content-only injection classifiers may miss this goal drift.

## Method

Before a tool call, compare the proposed action and its supporting instruction with the original user objective. Permit the action only when its contribution to that objective is explicit. External content may supply facts, but it cannot create authority.

## Required input

- Trusted user objective
- Proposed tool name and arguments
- Provenance of instructions that induced the action
- Prior approved actions when the dependency is multi-step

The current scanner accepts only text, so this skill remains disabled until structured hook context is available.

## Source

Zeng et al., [The Task Shield](https://arxiv.org/abs/2412.16682), 2024.
