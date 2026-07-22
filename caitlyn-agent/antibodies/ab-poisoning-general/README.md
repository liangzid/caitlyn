# General Poisoning Detector

## Detection Target
Detects tool output and MCP response poisoning attacks against LLM agents.

## Attack Patterns Covered
1. **Tool output poisoning**: Tool results containing hidden instructions to manipulate the agent's next actions
2. **MCP response poisoning**: MCP server responses injecting malicious instructions into agent context
3. **Data poisoning**: Fake but convincing data designed to mislead agent reasoning
4. **Trust exploitation**: Content leveraging agent trust in tool outputs to inject harmful instructions
5. **Recursive poisoning**: Content instructing the agent to fetch more poisoned content

## Detection Heuristics (implemented in detect.ts)
- Hidden instruction markers in output text (IMPORTANT, NOTE, ATTENTION with instruction language)
- Instruction-laden tool outputs that go beyond data delivery
- "Trust me" / authority-exploiting language in external content
- Recursive fetch/crawl instructions in tool responses

## Known Weaknesses
- Subtle data poisoning (factually wrong data without instruction language)
- Statistical poisoning (many benign-looking poisoned samples)
- Long-con attacks spanning many tool calls
