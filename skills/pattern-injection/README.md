# Pattern-Based Injection Detector

## Status

Active Tier 0 signature detector.

## Purpose

Provides a low-latency memory bank for known instruction-override, role-hijack and forged system-message patterns.

## Execution

The precompiled script evaluates the maintained pattern set in the resident worker and returns the strongest supported verdict.

## Limitations

This skill intentionally favors precise known patterns. It is not expected to detect semantically novel attacks and should be complemented by Tier 1 classification.
