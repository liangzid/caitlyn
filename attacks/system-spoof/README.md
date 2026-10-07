# System Message Spoofing

## Attack Description
The attacker crafts tool output or external content that mimics a system-level message, tricking the agent into treating it as authoritative.

## Technique
Uses system message formatting conventions (e.g. `[SYSTEM]`, `<|im_start|>system`, special Unicode markers) to make content appear as if it came from the platform itself rather than from an untrusted source.

## Typical Context
- MCP tool responses formatted to look like system messages
- Web search results containing `[SYSTEM]` markers
- File contents with embedded system message tokens

## Why It Escapes Basic Detection
- System message tokens can be split across lines
- Can use invisible Unicode characters between tokens
- Non-standard system message formats specific to different LLM platforms
