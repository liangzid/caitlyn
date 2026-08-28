# Library incoming (pre-audit staging)

Contributed attack samples and defense skills land here **before** human
audit. Maintainers promote approved entries into the shipped trees:

- `antibodies/<id>/`
- `antigens/<id>/`

## Layout

```
library/incoming/<contrib-id>/
  MANIFEST.json
  antibodies/<id>/config.yaml
  antibodies/<id>/README.md
  antibodies/<id>/detect.ts   # optional
  antigens/<id>/config.yaml
  antigens/<id>/README.md
  antigens/<id>/payload.txt   # hashed by default; full text only if opted in
```

## Rules

1. Entries in `incoming/` are **never** loaded by the scanner.
2. Remote contributions never auto-activate on client nodes.
3. Promotion into `antibodies/` / `antigens/` happens only after review.
4. Clients produce this tree via `caitlyn contribute` (local bundle under
   `~/.caitlyn/contribute/`). Opening the PR is a separate maintainer step.

See paper Section "Cloud Synchronization" and Appendix repository security.
