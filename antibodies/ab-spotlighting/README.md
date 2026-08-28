# Spotlighting Data Marker

## Status

Active as merged Tier 1 reference knowledge. Randomized wrapping is not yet applied automatically at every ingestion point.

## Purpose

Marks retrieved or tool-produced text as untrusted data so instructions inside it are less likely to be followed.

## Intended execution

Wrap each untrusted source in a fresh delimiter and add a trusted rule stating that the enclosed content is data, not authority.

## Limitations

Spotlighting is a probabilistic prompting defense. It must be combined with authorization and output controls.

## Source

Hines et al., [Defending Against Indirect Prompt Injection Attacks With Spotlighting](https://arxiv.org/abs/2403.14720), 2024.
