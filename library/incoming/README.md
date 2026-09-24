# Library incoming (pre-audit staging)

Contributed attack samples and defense skills land here **before** human
audit. Maintainers promote approved entries into the shipped trees:

- `skills/<id>/`
- `attacks/<id>/`

## Layout

```
library/incoming/<contrib-id>/
  MANIFEST.json
  skills/<id>/config.yaml
  skills/<id>/README.md
  skills/<id>/detect.ts   # optional
  attacks/<id>/config.yaml
  attacks/<id>/README.md
  attacks/<id>/payload.txt   # hashed by default; full text only if opted in
```

## Rules

1. Entries in `incoming/` are **never** loaded by the scanner.
2. Remote contributions never auto-activate on client nodes.
3. Promotion into `skills/` / `attacks/` happens only after review.
4. Clients produce this tree via `caitlyn contribute` (local bundle under
   `~/.caitlyn/contribute/`). Opening the PR is a separate maintainer step.

See paper Section "Cloud Synchronization" and Appendix repository security.
