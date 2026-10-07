# Retrieval Hijack and Authority Spoof Detector

## Status

Active Tier 0 detector with a precompiled JavaScript implementation.

## Purpose

Targets poisoned retrieval chunks, fabricated policy authority and malicious package, plugin, Model Context Protocol or skill manifests.

## Execution

The detector scans raw retrieved content for coupled authority, action and supply-chain indicators and returns the standard JSON result.

## Limitations

Mentions of security files or package metadata are common in legitimate development. A match should require an instruction or privilege-changing relationship.
