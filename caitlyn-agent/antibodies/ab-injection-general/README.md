# General Injection Detector

## Detection Target
Detects prompt injection attacks where external content attempts to override or manipulate the agent's system instructions.

## Attack Patterns Covered
1. **Direct instruction override**: "Ignore previous instructions", "You are now...", role-play hijacking
2. **SQL injection**: DROP TABLE, UNION SELECT, OR 1=1 patterns in tool inputs
3. **Code injection**: Shell commands (`rm -rf`, `curl evil.com`), `eval()` calls, `subprocess` invocations disguised in content
4. **Context boundary violations**: Content pretending to be a system message (e.g. `[SYSTEM]`, `<system>` tags)
5. **Delimiter injection**: Hidden delimiters or formatting tricks to escape content boundaries

## Detection Heuristics (implemented in detect.ts)
- Regex/signature matching for known injection patterns
- Suspicious tag/delimiter detection
- Command injection keyword scanning

## Known Weaknesses
- Obfuscated payloads (base64, hex encoding)
- Multi-turn attacks where each turn is benign
- Semantic-only attacks with no keyword overlap
