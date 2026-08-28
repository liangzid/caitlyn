# Persona Hijack Detector

## Status

Active Tier 0 detector with a precompiled JavaScript implementation.

## Purpose

Detects role-play requests that combine persona adoption with removal of safety constraints, refusal behavior or execution boundaries.

## Execution

Patterns require both a persona framing signal and an unsafe behavior signal where possible. The worker emits the standard JSON verdict.

## Limitations

Benign fictional role-play is not itself an attack. Persona names or words such as “debug” must not fire without behavior-changing context.
