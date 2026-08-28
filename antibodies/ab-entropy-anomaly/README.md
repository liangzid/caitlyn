# Entropy and Statistical Anomaly Detector

## Status

Active Tier 0 detector with a precompiled JavaScript implementation.

## Purpose

Finds encoded or visually manipulated regions using character distribution, repeated tokens, escape sequences, bidirectional controls and suspicious base64-like spans.

## Execution

The implementation combines bounded statistical checks with regular expressions and emits the standard verdict, confidence and reason object.

## Limitations

High entropy is not proof of an attack. Legitimate identifiers, compressed material and multilingual text require conservative thresholds and semantic follow-up.
