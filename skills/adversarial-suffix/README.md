# Adversarial Suffix and Compliant Prefill Detector

## Status

Active Tier 0 detector with a precompiled JavaScript implementation.

## Purpose

Detects token-optimization artifacts, long symbol runs, format corruption, unrestricted-mode markers and assistant-prefill text that attempts to start a prohibited answer before the model decides.

## Execution

The detector receives raw text on standard input and returns one JSON verdict. Its regular expressions and lightweight heuristics run in the resident Tier 0 worker.

## Limitations

Natural-language justification without suffix artifacts belongs to Tier 1. Broad punctuation or ordinary affirmative prose must not trigger without attack context.
