# Tool Argument Minimizer

## Status

Experimental and disabled by default. The current CAITLYN hook can block a call but cannot replace its structured arguments, so full enforcement requires an adapter extension.

## Threat model

An otherwise legitimate tool call includes personal or sensitive data that the tool does not require. Simple allow-or-block gates cannot reduce this over-sharing.

## Method

Compare each argument with the trusted objective and tool schema. Remove unnecessary fields. Where removal would break functionality, generalize, substitute, or truncate sensitive values while preserving schema validity.

## Required input

- Tool schema and required fields
- Structured arguments
- Trusted user objective
- A hook capable of returning rewritten arguments

## Source

[ToolMinimize](https://arxiv.org/abs/2608.24957), 2026.
