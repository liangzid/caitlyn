# Ignore Previous Instructions

## Attack Description
The attacker instructs the agent to disregard its earlier directives and adopt new, malicious instructions instead.

## Technique
Uses boundary-breaking language like "Ignore all previous instructions" to reset the agent's instruction stack. Often combined with a new task description that appears legitimate.

## Typical Context
- Chat messages with "corrections" to previous instructions
- Document comments containing override directives
- Multi-part inputs where the later part invalidates the earlier

## Why It Escapes Basic Detection
- "Ignore" is also used in benign contexts ("please ignore the typo")
- Can be phrased indirectly: "The previous instructions were incorrect"
- Multi-language variants
