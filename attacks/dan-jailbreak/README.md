# DAN Jailbreak Variant

## Attack Description
A role-play jailbreak where the attacker creates a fictional persona (DAN = Do Anything Now) and asks the agent to role-play as this unrestricted character.

## Technique
Creates a dual-persona framing: the agent maintains its original identity but also adopts DAN, who has no restrictions. The attacker then addresses requests to DAN specifically. This exploits the tension between role-play ("it's just pretend") and actual output generation.

## Typical Context
- Chat interactions where the user introduces a "game" or "role-play scenario"
- Multi-turn conversations that gradually escalate the DAN persona's freedom
- Variants include: STAN, DUDE, Mongo Tom, Translator Bot, etc.

## Why It Escapes Basic Detection
- Keyword obfuscation: D A N, D.A.N, DΔN
- Indirect references: "the mode we discussed earlier"
- Character-by-character construction
