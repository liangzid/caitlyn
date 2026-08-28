# IsolateGPT Execution Isolation

## Status

Reference only. Process and capability isolation are deployment architecture, not a text detector.

## Threat model

Third-party agent applications may access unrelated user data, communicate across trust boundaries, or combine privileges that were never intended to coexist.

## Method

Run applications in isolated contexts. Mediate resource access and cross-application communication through explicit interfaces. Give each component only the capabilities required for its declared task.

## CAITLYN gap

The current adapter layer observes tool calls but does not create per-application processes or capability namespaces. Enabling this entry without that isolation would be misleading.

## Source

Wu et al., [IsolateGPT](https://arxiv.org/abs/2403.04960), NDSS 2025.
