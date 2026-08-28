# IPIGuard Tool Dependency Graph

## Status

Experimental and disabled by default. The prompt records the authorization contract, but the current hook API does not yet supply a trusted dependency graph.

## Threat model

An indirect prompt injection induces a tool call that was not part of the task plan, or alters the prerequisites and arguments of an otherwise legitimate call.

## Method

Plan a tool dependency graph from the trusted request before reading untrusted data. During execution, allow only graph nodes whose predecessors have completed. Retrieved data may fill an expected value but cannot introduce a new action.

## Required input

- Trusted tool dependency graph
- Current node and completed-node ledger
- Proposed tool name and arguments
- Provenance of argument values

## Source

An et al., [IPIGuard](https://aclanthology.org/2025.emnlp-main.53/), EMNLP 2025.
