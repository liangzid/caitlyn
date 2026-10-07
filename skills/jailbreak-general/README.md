# General Jailbreak Detector

## Status

Active Tier 0 detector and one of the original CAITLYN root skills.

## Purpose

Detects common jailbreak personas, developer-mode claims, safety-disable requests, encoded payloads and manipulation patterns.

## Execution

The TypeScript source is precompiled to an ES module and loaded once by the Tier 0 worker. It returns a verdict, confidence and concise reason.

## Limitations

The skill targets attack form rather than harmful subject matter. Legitimate security discussion must remain benign unless it attempts to alter model authority or behavior.
