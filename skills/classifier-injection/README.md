# Prompt Injection Classifier

## Status

Active Tier 1 detector.

## Purpose

Uses boundary analysis to distinguish application instructions from attacker-controlled data, with emphasis on authority impersonation, instruction replacement and structured-format breakout.

## Execution

CAITLYN places the skill prompt in a trusted system message and the candidate content in a separate `<content>` block. The classifier returns one verdict and confidence score.

## Limitations

This is a prompted classifier, not a reproduction of a separately trained Prompt Guard or DataSentinel checkpoint. Its accuracy depends on the configured model.
