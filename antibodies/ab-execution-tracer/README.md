# Execution Tracer

## Status

Active as merged Tier 1 reference knowledge. Full trajectory adjudication is not yet implemented as a separate runtime skill.

## Purpose

Examines sequences of tool calls for unexpected privilege changes, repeated failures, cross-tool escalation and divergence from the stated task.

## Execution

Current merged execution contributes its analysis rules to content classification. A faithful implementation additionally requires ordered tool-call and effect history.

## Limitations

A serialized single tool call cannot establish trajectory-level behavior. Do not interpret the active knowledge status as complete lifecycle monitoring.
