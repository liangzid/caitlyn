# Exfiltration Instruction Detector

## Status

Active Tier 0 signature-only detector.

## Purpose

Detects instructions to reveal system prompts, credentials, conversation history or sensitive files, including attempts to send them through email, webhooks, paste services or external tools.

## Execution

The in-process signature engine compiles the patterns from `config.yaml`. No child process or language model call is required.

## Limitations

This detector identifies exfiltration instructions, not whether a concrete data flow is authorized. Capability and sink policies remain necessary.
