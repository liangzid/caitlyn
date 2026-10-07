# SecAlign Preference-Aligned Model

## Status

Reference only. SecAlign changes model behavior through preference optimization and cannot be reproduced by inserting its description into a classifier prompt.

## Threat model

Injected instructions compete with the legitimate task, including adaptive attacks that were not present in ordinary instruction tuning.

## Method

Construct preference triples containing an injected input, a secure task-following output and an insecure injection-following output. Optimize the model to prefer the secure completion.

## Required runtime support

- The preference dataset and training pipeline
- A compatible trained checkpoint
- Independent utility and adaptive-attack evaluation

## Source

Chen et al., [SecAlign](https://arxiv.org/abs/2410.05451), CCS 2025.
