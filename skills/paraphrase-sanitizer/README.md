# Paraphrase Sanitizer

## Status

Active as merged Tier 1 reference knowledge. CAITLYN does not currently rewrite content before classification.

## Purpose

Describes normalization and paraphrasing intended to expose instructions hidden by lexical variation, encoding or role-play framing.

## Intended execution

Rewrite low-trust content with a separate model, preserve the original for audit and scan both forms before allowing an action.

## Limitations

Paraphrasing can change meaning and roughly doubles inference work. The rewritten result must never become an authority source.
