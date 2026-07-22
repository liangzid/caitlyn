# General Jailbreak Detector

## Detection Target
Detects jailbreak attempts that try to bypass an LLM agent's safety constraints.

## Attack Patterns Covered
1. **Role-play jailbreaks**: Instructions to assume personas that bypass safety (DAN, unaligned AI, "developer mode")
2. **Encoding-based jailbreaks**: Obfuscated instructions using base64, hex, character substitution, or leetspeak
3. **Emotional manipulation**: Urgency, empathy, or authority pressure to force unsafe behavior
4. **Few-shot manipulation**: Providing examples that normalize harmful output
5. **Token smuggling**: Splitting harmful words across tokens or using Unicode tricks

## Detection Heuristics (implemented in detect.ts)
- Known jailbreak persona/role keywords
- Encoding pattern detection (base64 strings, hex sequences, excessive special chars)
- Manipulation language markers ("you must", "you have to", "it is your duty")

## Known Weaknesses
- Novel jailbreak techniques not seen before
- Multi-turn distributed jailbreaks
- Highly creative few-shot constructions
