# General Tool-Output Poisoning Detector

## Status

Active Tier 0 detector and one of the original CAITLYN root skills.

## Purpose

Detects instruction-like content in retrieved documents and tool responses, including authority spoofing, recursive fetch requests, fabricated verification and error-driven action bait.

## Execution

The detector combines signatures with instruction-to-data heuristics and runs before tool output is returned to the agent context.

## Limitations

Operational documentation can contain imperative text. Source trust, user intent and Tier 1 analysis remain necessary for ambiguous cases.
