# Permission Gating Guard

## Status

Active as merged Tier 1 reference knowledge. The hook policy currently blocks by scan verdict but does not implement per-tool capability manifests.

## Purpose

Checks whether a proposed tool and its arguments are authorized, task-relevant and proportionate to the intended effect.

## Execution

The current hook scans serialized arguments before execution. Full permission gating requires explicit allowlists, resource scopes and consequence-aware policies.

## Limitations

Keywords such as `curl`, `delete` or shell punctuation are not sufficient evidence of misuse without task and capability context.
