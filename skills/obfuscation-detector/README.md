# Obfuscation and Encoding Detector

## Status

Active Tier 0 detector with a precompiled JavaScript implementation.

## Purpose

Detects combining-mark abuse, homoglyph substitutions, leetspeak, spaced instruction words, decoding directives and repeated hexadecimal or Unicode escapes.

## Execution

The detector normalizes selected representations and applies bounded heuristics before returning the standard JSON result.

## Limitations

Obfuscation is only a risk signal. Legitimate international text and encoded data must not be classified as malicious without instruction-like evidence.
