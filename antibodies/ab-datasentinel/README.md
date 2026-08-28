# DataSentinel Adaptive Injection Detector

## Status

Reference only. DataSentinel is a trained detector. Replacing its model with a generic prompt would not reproduce the method.

## Threat model

An adaptive attacker optimizes injected text specifically to evade a deployed detector.

## Method

DataSentinel formulates training as a minimax problem. The inner optimization searches for detector-evasive attacks and the outer optimization trains the detector against those attacks.

## Required runtime support

- Published or independently reproduced model weights
- Matching tokenizer and inference code
- Threshold calibration on CAITLYN evaluation distributions

This entry must remain inactive until those artifacts are installed and evaluated.

## Source

Liu et al., [DataSentinel](https://arxiv.org/abs/2504.11358), IEEE Symposium on Security and Privacy 2025.
