# Re-Execution Verifier

## Status

Active as merged Tier 1 reference knowledge. Masked trajectory re-execution is not yet wired into the runtime.

## Purpose

Tests whether tool actions depend on untrusted injected content by comparing the original trajectory with a run in which the user-controlled instruction is masked.

## Intended execution

Apply only to high-impact effects, reproduce the relevant environment safely and compare action sequences before committing irreversible effects.

## Limitations

The method adds substantial execution cost and requires deterministic or well-controlled replay.
