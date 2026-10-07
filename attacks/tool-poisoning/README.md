# Tool Output Poisoning

## Attack Description
The attacker crafts a tool output (e.g., file contents, web search result, MCP response) that appears to be legitimate data but contains hidden instructions for the agent.

## Technique
Embeds instruction text within what should be pure data output. Common patterns:
- Appending instruction text after legitimate data
- Using data fields as instruction carriers (e.g., filename = malicious command)
- Fake error messages that instruct corrective action
- Authority claims within the tool output itself ("per system administrator...")

## Typical Context
- Web search results containing injected content
- Git repository files with malicious comments
- API responses from compromised endpoints
- File contents that include meta-instructions

## Why It Escapes Basic Detection
- Looks like legitimate tool output at first glance
- Agent has higher trust in tool outputs than user messages
- Data/instruction boundary is inherently fuzzy
