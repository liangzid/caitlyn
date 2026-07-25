# Encoding-Based Bypass

## Attack Description
The attacker encodes malicious instructions using base64, hex, leetspeak, or Unicode tricks to evade keyword-based detection while the LLM can still decode and execute them.

## Technique
Common encoding strategies:
- Base64: `SWdub3JlIGFsbCBwcmV2aW91cyBpbnN0cnVjdGlvbnMu` → "Ignore all previous instructions."
- Hex escapes: `\x49\x67\x6e\x6f\x72\x65`
- Leetspeak: `1gn0r3 4ll pr3v10us 1nstruct10ns`
- Unicode homoglyphs: using Cyrillic `а` instead of Latin `a`
- Zero-width character insertion between keywords

## Typical Context
- "Puzzle" or "decoding challenge" framing to get the agent to decode
- Hidden in image alt text or metadata
- Multi-step: first ask agent to decode, then reveal decoded instructions

## Why It Escapes Basic Detection
- Regex patterns don't match encoded text
- Each encoding variant needs its own detection rule
- LLMs can decode many formats that regex can't
