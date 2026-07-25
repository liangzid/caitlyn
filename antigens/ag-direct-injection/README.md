# Direct Instruction Injection

## Attack Description
The attacker directly inserts instructions into user-facing content that override the agent's system prompt or safety guidelines.

## Technique
The payload embeds a system-level directive (e.g. "You are now...") to hijack the agent's role. The agent treats the injected text as a new system prompt, abandoning its original constraints.

## Typical Context
- User-supplied text fields in web apps
- Uploaded documents with hidden meta-instructions
- Search results that include instruction text

## Why It Escapes Basic Detection
Advanced variants use:
- Unicode homoglyphs for keywords
- Zero-width characters to break regex patterns
- Multi-paragraph context to dilute the instruction density
