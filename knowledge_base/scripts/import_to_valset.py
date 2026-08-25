#!/usr/bin/env python3
"""
======================================================================
IMPORT_TO_VALSET

1. Reads attack payload JSONL files from the knowledge_base/attack_payloads/
   directory, parses each payload, and appends them to the appropriate
   valset attack files in valsets/attacks/ with content-hash deduplication.
2. Calling chains:
   - main() -> parse_args() -> resolve_paths()
   - main() -> read_source_payloads()  [glob *.jsonl]
   - main() -> load_existing_hashes()  [for dedup]
   - main() -> import_payloads() -> _append_to_valset()
3. Modification history and reason:
   - 2026-07-24: Initial creation for CAITLYN knowledge base collection.

    Author: [AUTHOR] <[EMAIL]>
    Copyright (c) 2026, [AUTHOR], all rights reserved.
    Created: 24 July 2026
======================================================================
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
KB_DIR = SCRIPT_DIR.parent
DEFAULT_SOURCE_DIR = KB_DIR / "attack_payloads"
DEFAULT_TARGET_DIR = SCRIPT_DIR.parent.parent / "valsets" / "attacks"


# ---------------------------------------------------------------------------
# Deduplication helpers
# ---------------------------------------------------------------------------

def content_hash(content: str) -> str:
    """SHA-256 hex digest of the normalized payload content."""
    normalized = content.strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def load_existing_hashes(target_dir: Path) -> set[str]:
    """Scan all JSONL files in *target_dir* and return the set of content hashes."""
    hashes: set[str] = set()
    if not target_dir.is_dir():
        return hashes
    for fpath in sorted(target_dir.glob("*.jsonl")):
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        c = obj.get("content", "")
                        if c:
                            hashes.add(content_hash(c))
                    except json.JSONDecodeError:
                        continue
        except OSError:
            continue
    return hashes


# ---------------------------------------------------------------------------
# Source reading
# ---------------------------------------------------------------------------

def read_source_payloads(source_dir: Path) -> list[dict]:
    """Yield all payload objects from JSONL files in *source_dir*."""
    payloads: list[dict] = []
    if not source_dir.is_dir():
        print(f"Source directory not found: {source_dir}", file=sys.stderr)
        return payloads
    for fpath in sorted(source_dir.glob("*.jsonl")):
        file_name = fpath.name
        print(f"  Reading {fpath}", file=sys.stderr)
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                for lineno, line in enumerate(f, start=1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError as exc:
                        print(f"    Skip line {lineno}: {exc}", file=sys.stderr)
                        continue
                    # Ensure required fields
                    if "content" not in obj:
                        print(f"    Skip line {lineno}: missing 'content' field", file=sys.stderr)
                        continue
                    # Add source file tag if not present
                    if "source" not in obj:
                        obj["source"] = file_name.rsplit(".", 1)[0]
                    if "id" not in obj:
                        obj["id"] = f"{obj['source']}-{content_hash(obj['content'])[:8]}"
                    payloads.append(obj)
        except OSError as exc:
            print(f"  Error reading {fpath}: {exc}", file=sys.stderr)
    return payloads


# ---------------------------------------------------------------------------
# Import logic
# ---------------------------------------------------------------------------

def _classify_target_file(payload: dict) -> str:
    """Determine target valset filename from payload category/attack_type."""
    category = (payload.get("category") or payload.get("attack_type") or "injection").strip().lower()
    # Normalize common categories to our valset file naming convention
    cat_map = {
        "injection": "raw_injection_payloads.jsonl",
        "prompt injection": "raw_injection_payloads.jsonl",
        "direct injection": "raw_injection_payloads.jsonl",
        "indirect injection": "raw_injection_payloads.jsonl",
        "jailbreak": "raw_injection_payloads.jsonl",
        "physical harm": "raw_injection_payloads.jsonl",
        "exfiltration": "raw_injection_payloads.jsonl",
        "tool misuse": "raw_injection_payloads.jsonl",
        "poisoning": "raw_injection_payloads.jsonl",
        "safety bypass": "raw_injection_payloads.jsonl",
        "agentdojo": "agentdojo_all.jsonl",
    }
    return cat_map.get(category, "raw_injection_payloads.jsonl")


def import_payloads(
    payloads: list[dict],
    target_dir: Path,
    existing_hashes: set[str],
    dry_run: bool = False,
) -> tuple[int, int]:
    """Import payloads into *target_dir*, deduplicating against *existing_hashes*.

    Returns (imported_count, skipped_count).
    """
    # Bucket payloads by target file
    buckets: dict[str, list[dict]] = {}
    for p in payloads:
        target_file = _classify_target_file(p)
        buckets.setdefault(target_file, []).append(p)

    imported = 0
    skipped = 0

    for target_file, plist in sorted(buckets.items()):
        target_path = target_dir / target_file
        new_lines: list[str] = []
        file_imported = 0

        if not dry_run:
            target_dir.mkdir(parents=True, exist_ok=True)

        for p in plist:
            h = content_hash(p.get("content", ""))
            if not h:
                skipped += 1
                continue
            if h in existing_hashes:
                skipped += 1
                continue
            existing_hashes.add(h)
            new_lines.append(json.dumps(p, ensure_ascii=False))
            imported += 1
            file_imported += 1

        if new_lines and dry_run:
            print(f"  [DRY RUN] Would append {len(new_lines)} entries to {target_file}")
        elif new_lines:
            target_text = "\n".join(new_lines) + "\n"
            with open(target_path, "a", encoding="utf-8") as f:
                f.write(target_text)
            print(f"  Appended {file_imported} entries to {target_file}")

    return imported, skipped


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str]) -> argparse.Namespace:
    """Parse command-line arguments."""
    p = argparse.ArgumentParser(
        description="CAITLYN Attack Payload Importer — import JSONL attack payloads "
                    "into valsets/attacks/ with content-hash deduplication."
    )
    p.add_argument("--source-dir", type=str, default=str(DEFAULT_SOURCE_DIR),
                   help="Directory containing attack payload JSONL files "
                        "(default: ../attack_payloads/).")
    p.add_argument("--target-dir", type=str, default=str(DEFAULT_TARGET_DIR),
                   help="Target valsets/attacks/ directory (default: ../../valsets/attacks/).")
    p.add_argument("--dry-run", action="store_true", default=False,
                   help="Preview what would be imported without writing files.")
    return p.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    """Entry point."""
    if argv is None:
        argv = sys.argv[1:]
    args = parse_args(argv)

    source_dir = Path(args.source_dir)
    target_dir = Path(args.target_dir)

    print(f"Source: {source_dir}", file=sys.stderr)
    print(f"Target: {target_dir}", file=sys.stderr)
    if args.dry_run:
        print("[DRY RUN MODE]", file=sys.stderr)

    # Load existing hashes from target directory for deduplication
    print("Loading existing payload hashes...", file=sys.stderr)
    existing_hashes = load_existing_hashes(target_dir)
    print(f"  {len(existing_hashes)} existing unique payloads", file=sys.stderr)

    # Read source payloads
    print("Reading source payloads...", file=sys.stderr)
    payloads = read_source_payloads(source_dir)
    print(f"  {len(payloads)} source payloads read", file=sys.stderr)

    # Import
    imported, skipped = import_payloads(payloads, target_dir, existing_hashes, args.dry_run)

    print(f"\nSummary: {imported} imported, {skipped} skipped (duplicates or empty).", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
