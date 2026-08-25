#!/usr/bin/env python3
"""
======================================================================
ANNOTATE

1. Interactive annotation tool that fetches paper metadata from arXiv
   or Semantic Scholar APIs, prompts the user for taxonomy annotations,
   and appends entries to annotations.jsonl and annotations.org.
2. Calling chains:
   - main() -> parse_args() -> resolve_url_to_paper_id()
   - main() -> fetch_paper_metadata() -> fetch_from_arxiv() | fetch_from_semantic_scholar()
   - main() -> run_interactive_annotation()
   - main() -> collect_annotations()
   - main() -> append_to_jsonl() + append_to_org()
3. Modification history and reason:
   - 2026-07-24: Initial creation for CAITLYN knowledge base collection.

    Author: [AUTHOR] <[EMAIL]>
    Copyright (c) 2026, [AUTHOR], all rights reserved.
    Created: 24 July 2026
======================================================================
"""

import argparse
import json
import os
import sys
import re
import textwrap
from datetime import date, datetime
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ARXIV_API_URL = "https://export.arxiv.org/api/query"
SEMANTIC_SCHOLAR_API_URL = "https://api.semanticscholar.org/graph/v1"
SCRIPT_DIR = Path(__file__).resolve().parent
KB_DIR = SCRIPT_DIR.parent
ANNOTATIONS_JSONL = KB_DIR / "annotations.jsonl"
ANNOTATIONS_ORG = KB_DIR / "annotations.org"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def sanitize_id(raw: str) -> str:
    """Convert a raw paper identifier into a clean, filesystem-safe id."""
    return re.sub(r"[^a-zA-Z0-9._-]", "_", raw.strip())


def prompt_nonempty(prompt_text: str, default: Optional[str] = None) -> str:
    """Prompt the user repeatedly until a non-empty answer is given."""
    if default:
        full = f"{prompt_text} [{default}]: "
    else:
        full = f"{prompt_text}: "
    while True:
        val = input(full).strip()
        if not val and default:
            return default
        if val:
            return val
        print("  (value required)")


def prompt_list(prompt_text: str, default: Optional[list] = None) -> list:
    """Prompt for a comma-separated list; return as list of trimmed strings."""
    default_str = ", ".join(default) if default else None
    raw = prompt_nonempty(prompt_text, default_str)
    items = [s.strip() for s in raw.split(",") if s.strip()]
    return items


def prompt_float(prompt_text: str, default: Optional[float] = None) -> float:
    """Prompt for a float value with optional default."""
    while True:
        raw = prompt_nonempty(prompt_text, str(default) if default is not None else None)
        try:
            return float(raw)
        except ValueError:
            print(f"  Invalid float: {raw}")


def prompt_bool(prompt_text: str, default: bool = False) -> bool:
    """Prompt for y/n."""
    suffix = " [Y/n]: " if default else " [y/N]: "
    raw = input(prompt_text + suffix).strip().lower()
    if not raw:
        return default
    return raw.startswith("y")


# ---------------------------------------------------------------------------
# API: Metadata fetching
# ---------------------------------------------------------------------------

def fetch_from_arxiv(arxiv_id: str) -> Optional[dict]:
    """Fetch paper metadata from the arXiv API by arXiv ID."""
    import urllib.request
    import xml.etree.ElementTree as ET

    url = f"{ARXIV_API_URL}?id_list={arxiv_id}&max_results=1"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "CAITLYN-Annotate/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read().decode("utf-8")
    except Exception as exc:
        print(f"  arXiv API error: {exc}", file=sys.stderr)
        return None

    ns = {"atom": "http://www.w3.org/2005/Atom",
          "arxiv": "http://arxiv.org/schemas/atom"}
    root = ET.fromstring(data)
    entry = root.find("atom:entry", ns)
    if entry is None:
        print("  No entry found in arXiv response.", file=sys.stderr)
        return None

    title_el = entry.find("atom:title", ns)
    title = title_el.text.strip() if title_el is not None else "Unknown"

    author_els = entry.findall("atom:author/atom:name", ns)
    authors = [a.text.strip() for a in author_els if a.text]

    published = entry.find("atom:published", ns)
    year = int(published.text[:4]) if published is not None else None

    abs_el = entry.find("atom:summary", ns)
    abstract = abs_el.text.strip() if abs_el is not None else ""

    arxiv_url = f"https://arxiv.org/abs/{arxiv_id}"

    return {
        "title": title,
        "authors": authors,
        "year": year,
        "url": arxiv_url,
        "abstract": abstract,
        "venue": "arXiv",
        "id_suggestion": arxiv_id,
    }


def fetch_from_semantic_scholar(paper_id: str) -> Optional[dict]:
    """Fetch paper metadata from Semantic Scholar API by paper ID or DOI."""
    import urllib.request

    url = f"{SEMANTIC_SCHOLAR_API_URL}/paper/{paper_id}"
    fields = "title,authors,year,venue,externalIds,abstract,url"
    query_url = f"{url}?fields={fields}"
    try:
        req = urllib.request.Request(query_url, headers={"User-Agent": "CAITLYN-Annotate/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        print(f"  Semantic Scholar API error: {exc}", file=sys.stderr)
        return None

    title = payload.get("title", "Unknown")
    authors = [a["name"] for a in payload.get("authors", [])]
    year = payload.get("year")
    venue = payload.get("venue", "") or ""
    abstract = payload.get("abstract", "") or ""
    paper_url = payload.get("url", "")
    ext_ids = payload.get("externalIds", {})
    arxiv_id = ext_ids.get("ArXiv", "")
    doi = ext_ids.get("DOI", "")

    id_suggestion = arxiv_id or doi or paper_id

    # If no URL, try to construct from arXiv ID
    if not paper_url and arxiv_id:
        paper_url = f"https://arxiv.org/abs/{arxiv_id}"

    return {
        "title": title,
        "authors": authors,
        "year": year,
        "url": paper_url,
        "abstract": abstract,
        "venue": venue or "arXiv" if not venue and arxiv_id else venue or "Unknown",
        "id_suggestion": id_suggestion,
    }


def resolve_url_to_paper_id(raw_url: str) -> Optional[str]:
    """Extract a paper identifier (arXiv ID, DOI, S2 ID) from a URL string."""
    raw_url = raw_url.strip()

    # arXiv URL patterns: arxiv.org/abs/XXXX.YYYYY or arxiv.org/pdf/XXXX.YYYYY
    m = re.search(r"arxiv\.org/(?:abs|pdf)/([\w.\-]+?)(?:\.pdf)?$", raw_url)
    if m:
        return f"ARXIV:{m.group(1)}"

    # DOI pattern in URL: doi.org/10.XXXX/...
    m = re.search(r"doi\.org/(10\.[\w./\-]+)", raw_url)
    if m:
        return f"DOI:{m.group(1)}"

    # Semantic Scholar URL
    m = re.search(r"semanticscholar\.org/paper/[^/]+/([\w]+)", raw_url)
    if m:
        return f"CorpusId:{m.group(1)}"

    # Raw arXiv ID
    m = re.match(r"^(\d{4}\.\d{4,5})(v\d+)?$", raw_url)
    if m:
        return f"ARXIV:{m.group(1)}"

    return None


def fetch_paper_metadata(raw_url: str) -> Optional[dict]:
    """Resolve a URL/DOI and fetch metadata from the best available API."""
    paper_id = resolve_url_to_paper_id(raw_url)
    if paper_id is None:
        print(f"Could not parse paper identifier from: {raw_url}", file=sys.stderr)
        return None

    print(f"  Resolved paper ID: {paper_id}")

    if paper_id.startswith("ARXIV:"):
        arxiv_id = paper_id.split(":", 1)[1]
        return fetch_from_arxiv(arxiv_id)
    else:
        s2_id = paper_id.split(":", 1)[1]
        return fetch_from_semantic_scholar(s2_id)


# ---------------------------------------------------------------------------
# Interactive annotation
# ---------------------------------------------------------------------------

def collect_annotations(prefill: Optional[dict] = None) -> dict:
    """Interactively collect annotation fields from the user."""
    meta = prefill or {}

    print("\n--- Paper Metadata ---")
    title = prompt_nonempty("Title", meta.get("title"))
    authors = prompt_list("Authors (comma-separated)", meta.get("authors", []))
    year_str = prompt_nonempty("Year", str(meta.get("year", "")))
    year = int(year_str) if year_str else None
    venue = prompt_nonempty("Venue", meta.get("venue", "arXiv"))
    url = prompt_nonempty("URL", meta.get("url", ""))
    paper_id = prompt_nonempty("Paper ID", sanitize_id(meta.get("id_suggestion", title)))
    paper_id = sanitize_id(paper_id)

    print("\n--- Classification ---")
    paper_type = prompt_nonempty("Type (attack/defense/survey/benchmark/position)", "attack")

    # Attack categories
    print("\n  Attack categories (A1-A5, B1-B5, C*, D1-D3, E1-E3, F1-F4)")
    atk_cats = prompt_list("  Attack categories (comma-sep, or leave blank)", [])

    # Defense categories
    print("\n  Defense categories (alpha1-alpha4, beta1-beta4, gamma1-gamma4, delta1-delta4, epsilon1-epsilon4, zeta1-zeta4)")
    print("  Use short forms: a1=α1 Pattern Match, a2=α2 Classifier, a3=α3 Perplexity/Entropy,")
    print("    a4=α4 Embedding, b1=β1 System Hardening, b2=β2 Delimiter, b3=β3 Instruction Hierarchy,")
    print("    b4=β4 Self-Reminder, e1=ε1 LLM-as-Judge, e3=ε3 Context-Aware, d2=δ2 Permission Gating")
    def_cats = prompt_list("  Defense categories (comma-sep, or leave blank)", [])

    # CAITLYN attack category
    print("\n  CAITLYN category: injection | poisoning | exfil | tool_misuse | unknown")
    caitlyn_cat = prompt_nonempty("  CAITLYN attack category", "unknown")

    relevance = prompt_float("Relevance to CAITLYN (0.0-1.0)", 0.5)
    relevance = max(0.0, min(1.0, relevance))

    print("\n--- Actionable Artifacts ---")
    attack_payloads = prompt_list("  Attack payloads (comma-sep, or blank)", [])
    signatures = prompt_list("  Detection signatures/regex (comma-sep, or blank)", [])
    ab_prompt = prompt_nonempty("  Antibody prompt template (or '-' for none)", "-")
    if ab_prompt == "-":
        ab_prompt = ""
    eval_metric = prompt_nonempty("  Evaluation metric (ASR, F1, etc., or '-' for none)", "-")
    if eval_metric == "-":
        eval_metric = ""

    artifacts = {
        "attack_payloads": attack_payloads,
        "signatures": signatures,
        "antibody_prompt_template": ab_prompt,
        "evaluation_metric": eval_metric,
    }

    key_claims = prompt_list("Key claims (comma-sep, or blank)", [])
    datasets = prompt_list("Datasets used (comma-sep, or blank)", [])
    baselines = prompt_list("Baselines compared (comma-sep, or blank)", [])
    notes = input("Notes (optional): ").strip()

    return {
        "id": paper_id,
        "title": title,
        "authors": authors,
        "year": year,
        "venue": venue,
        "venue_tier": 1,  # User may override later
        "url": url,
        "type": paper_type,
        "attack_categories": atk_cats,
        "defense_categories": def_cats,
        "caitlyn_attack_category": caitlyn_cat,
        "relevance_to_caitlyn": relevance,
        "actionable_artifacts": artifacts,
        "key_claims": key_claims,
        "dataset_used": datasets,
        "baselines_compared": baselines,
        "notes": notes,
        "added_date": date.today().isoformat(),
        "reviewed": False,
    }


# ---------------------------------------------------------------------------
# Output: JSONL and Org
# ---------------------------------------------------------------------------

def append_to_jsonl(annotation: dict, path: Path = ANNOTATIONS_JSONL) -> None:
    """Append a single annotation record to the JSONL file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(annotation, ensure_ascii=False) + "\n")
    print(f"  Appended to {path}")


def _escape_org(value: str) -> str:
    """Escape minimal org-mode syntax in a plain string."""
    return value.replace("|", "\\vert{}")


def append_to_org(annotation: dict, path: Path = ANNOTATIONS_ORG) -> None:
    """Append an org-mode entry for the annotation."""
    path.parent.mkdir(parents=True, exist_ok=True)
    title = annotation.get("title", "Untitled")
    pid = annotation.get("id", "unknown")
    year = annotation.get("year", "")
    venue = annotation.get("venue", "")
    tier = annotation.get("venue_tier", "")
    ptype = annotation.get("type", "")
    relevance = annotation.get("relevance_to_caitlyn", "")

    lines = []
    lines.append(f"* PAPER: {title}")
    lines.append(":PROPERTIES:")
    lines.append(f":ID:       {pid}")
    lines.append(f":YEAR:     {year}")
    lines.append(f":VENUE:    {venue}")
    lines.append(f":TIER:     {tier}")
    lines.append(f":TYPE:     {ptype}")
    lines.append(f":RELEVANCE: {relevance}")
    lines.append(":END:")
    lines.append("")

    authors_str = ", ".join(annotation.get("authors", []))
    lines.append(f"- Authors :: {_escape_org(authors_str)}")
    lines.append(f"- URL :: {_escape_org(annotation.get('url', ''))}")

    atk_str = ", ".join(annotation.get("attack_categories", [])) or "N/A"
    lines.append(f"- Attack Categories :: {_escape_org(atk_str)}")
    def_str = ", ".join(annotation.get("defense_categories", [])) or "N/A"
    lines.append(f"- Defense Categories :: {_escape_org(def_str)}")
    lines.append(f"- CAITLYN Category :: {_escape_org(annotation.get('caitlyn_attack_category', ''))}")

    claims = annotation.get("key_claims", [])
    lines.append("- Key Claims ::")
    for i, c in enumerate(claims or [], start=1):
        lines.append(f"  {i}. {_escape_org(c)}")
    if not claims:
        lines[-1] += " (none)"

    art = annotation.get("actionable_artifacts", {})
    lines.append("- Actionable for CAITLYN ::")
    lines.append(f"  - Attack payloads: {art.get('attack_payloads', [])}")
    lines.append(f"  - Signatures: {art.get('signatures', [])}")
    ab_prompt = art.get("antibody_prompt_template", "")
    if ab_prompt:
        lines.append(f"  - Antibody prompt idea: {_escape_org(ab_prompt[:200])}")

    datasets = annotation.get("dataset_used", [])
    ds_str = ", ".join(datasets) if datasets else "N/A"
    lines.append(f"- Datasets Used :: {_escape_org(ds_str)}")

    bl_str = ", ".join(annotation.get("baselines_compared", [])) or "N/A"
    lines.append(f"- Baselines :: {_escape_org(bl_str)}")

    notes = annotation.get("notes", "")
    lines.append(f"- Notes :: {_escape_org(notes) if notes else '(none)'}")

    lines.append("")  # blank separator

    with open(path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"  Appended org entry to {path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list) -> argparse.Namespace:
    """Parse command-line arguments."""
    p = argparse.ArgumentParser(
        description="CAITLYN Paper Annotation Tool — interactively annotate papers "
                    "with attack/defense taxonomy."
    )
    p.add_argument("--url", type=str, default=None,
                   help="Paper URL (arXiv, DOI, Semantic Scholar). "
                        "If provided, metadata is fetched automatically.")
    p.add_argument("--interactive", action="store_true", default=True,
                   help="Run interactive annotation prompts (default).")
    p.add_argument("--no-interactive", action="store_false", dest="interactive",
                   help="Skip interactive prompts (fetches metadata only).")
    p.add_argument("--jsonl", type=str, default=str(ANNOTATIONS_JSONL),
                   help="Path to annotations JSONL file.")
    p.add_argument("--org", type=str, default=str(ANNOTATIONS_ORG),
                   help="Path to annotations org-mode file.")
    return p.parse_args(argv)


def run_interactive_annotation(args: argparse.Namespace) -> int:
    """Main entry point: fetch metadata, collect annotations, write outputs."""
    prefill = None

    if args.url:
        print(f"Fetching metadata for: {args.url}")
        prefill = fetch_paper_metadata(args.url)
        if prefill is None:
            print("Failed to fetch metadata. Continuing with manual entry.\n", file=sys.stderr)
        else:
            print(f"  Title: {prefill['title']}")
            print(f"  Authors: {', '.join(prefill.get('authors', []))}")
            print(f"  Year: {prefill.get('year')}  Venue: {prefill.get('venue')}")
            print(f"  URL: {prefill.get('url')}")

    if not args.interactive:
        # Non-interactive mode: just print fetched metadata and exit
        if prefill:
            print(json.dumps(prefill, indent=2, ensure_ascii=False))
        else:
            print("No metadata to display (no URL provided).", file=sys.stderr)
        return 0

    annotation = collect_annotations(prefill)

    jsonl_path = Path(args.jsonl)
    org_path = Path(args.org)

    print(f"\n--- Writing outputs ---")
    append_to_jsonl(annotation, jsonl_path)
    append_to_org(annotation, org_path)

    print(f"\nDone. Annotated paper: {annotation['title']}")
    return 0


def main(argv: Optional[list] = None) -> int:
    """Entry point."""
    if argv is None:
        argv = sys.argv[1:]
    args = parse_args(argv)
    return run_interactive_annotation(args)


if __name__ == "__main__":
    sys.exit(main())
