# StruQ Structured Query Boundary

## Status

Reference only. Wrapping text in XML is not a faithful implementation of StruQ because the method also requires a specially trained model.

## Threat model

The model interprets instructions embedded in user or retrieved data as application instructions.

## Method

Use a secure frontend to encode trusted instructions and untrusted data in separate structural channels. Train the model to follow only the instruction channel and ignore instructions occurring in the data channel.

## Required runtime support

- Reserved-token-safe prompt construction
- A model trained for the structured query format
- End-to-end tests against delimiter injection and adaptive attacks

## Source

Chen et al., [StruQ](https://arxiv.org/abs/2402.06363), USENIX Security 2025.
