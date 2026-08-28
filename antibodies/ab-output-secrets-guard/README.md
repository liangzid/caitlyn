# Output Secrets Guard

## Status

Active Tier 0 signature-only detector.

## Purpose

Finds common credential representations such as private keys, provider tokens, JSON Web Tokens and explicit key-value secret assignments before content is released.

## Execution

The in-process signature engine evaluates patterns directly from `config.yaml`.

## Limitations

Pattern coverage cannot identify every proprietary or context-dependent secret. Production integrations should combine this skill with data classification and destination authorization.
