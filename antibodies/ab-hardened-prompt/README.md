# Hardened System Prompt

## Status

Experimental knowledge entry. The current scanner does not install this prompt into the protected agent.

## Purpose

Documents instruction-priority, untrusted-data and refusal rules suitable for a protected agent system prompt.

## Intended execution

An adapter should merge the hardening text into the trusted system channel before any untrusted observation is introduced.

## Limitations

Prompt hardening is bypassable and cannot replace tool authorization, isolation or information-flow control.
