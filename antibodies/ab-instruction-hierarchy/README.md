# Instruction Hierarchy Classifier

## Status

Active Tier 1 detector.

## Purpose

Detects lower-authority content that attempts to override system or developer instructions, including forged roles and commands embedded in tool output.

## Execution

The configured language model applies the hierarchy prompt either independently or as part of merged Tier 1 execution.

## Limitations

Prompting a general model is not equivalent to instruction-hierarchy training. The skill provides runtime classification knowledge and must not be described as model-level hardening.
