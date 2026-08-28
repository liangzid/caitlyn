# Instruction Redirection Detector

## Status

Active Tier 0 detector with a precompiled JavaScript implementation.

## Purpose

Detects multilingual requests to discard earlier instructions, forged message-role markers and attempts to redefine the current goal, mission or priority.

## Execution

The detector evaluates bounded patterns and returns a standard JSON verdict through the resident worker.

## Limitations

Translations and ordinary discussion of instruction hierarchy can resemble attack text. The implementation therefore requires contextual combinations instead of treating every control word as malicious.
