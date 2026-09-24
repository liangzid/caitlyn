# SARA Action Provenance Authorizer

## Status

Experimental and disabled by default. The paper was posted on 27 August 2026 and has not yet been independently reproduced in CAITLYN.

## Threat model

Tool output contains text that induces a concrete follow-up action. Repetition across steps can make that attacker-originated action appear to be established context.

## Method

Keep action discovery separate from action authorization. Record the origin of every candidate action. Authorize execution only from the trusted user objective and evidence produced by previously authorized executions. Do not let history promote an untrusted origin into authority.

## Required input

- Trusted user objective
- Observation-level provenance spans
- Proposed action and argument provenance
- Authorized execution history

## Source

[When Tool Outputs Become Commands](https://arxiv.org/abs/2608.27146), 2026.
