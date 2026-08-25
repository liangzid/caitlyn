#!/usr/bin/env python3
"""
======================================================================
FETCH_PAPERS

1. Bulk paper fetching via the Semantic Scholar API. Accepts search
   queries from CLI arguments or a query file, retrieves matching
   paper metadata, and outputs JSONL to stdout or a specified file.
2. Calling chains:
   - main() -> parse_args() -> load_queries()
   - main() -> search_semantic_scholar() -> _fetch_page()  [paginated]
   - main() -> output_results()
3. Modification history and reason:
   - 2026-07-24: Initial creation for CAITLYN knowledge base collection.

    Author: [AUTHOR] <[EMAIL]>
    Copyright (c) 2026, [AUTHOR], all rights reserved.
    Created: 24 July 2026
======================================================================
"""

import argparse
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote, urlencode

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SEMANTIC_SCHOLAR_SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
DEFAULT_LIMIT = 50
RATE_LIMIT_WINDOW_S = 300         # 5 minutes
RATE_LIMIT_MAX_REQUESTS = 100

# ---------------------------------------------------------------------------
# Rate limiter (self-policing token bucket)
# ---------------------------------------------------------------------------

class RateLimiter:
    """Simple rate limiter for the Semantic Scholar free tier: 100 req/5min."""

    def __init__(self, max_requests: int = RATE_LIMIT_MAX_REQUESTS,
                 window: float = RATE_LIMIT_WINDOW_S):
        self._max = max_requests
        self._window = window
        self._timestamps: list[float] = []

    def _prune(self, now: float) -> None:
        """Remove timestamps older than the window."""
        cutoff = now - self._window
        while self._timestamps and self._timestamps[0] < cutoff:
            self._timestamps.pop(0)

    def wait_if_needed(self) -> None:
        """Block if we have exhausted our window budget."""
        now = time.monotonic()
        self._prune(now)
        if len(self._timestamps) >= self._max:
            sleep_for = self._timestamps[0] + self._window - now + 1.0
            if sleep_for > 0:
                print(f"  Rate limit: sleeping {sleep_for:.1f}s ...", file=sys.stderr)
                time.sleep(sleep_for)
            # Re-prune after sleep
            now = time.monotonic()
            self._prune(now)

    def record(self) -> None:
        """Record that a request was made now."""
        self._timestamps.append(time.monotonic())


# ---------------------------------------------------------------------------
# Query loading
# ---------------------------------------------------------------------------

def load_queries(args: argparse.Namespace) -> list[str]:
    """Return the list of search queries from CLI args or a query file."""
    queries: list[str] = []
    if args.query:
        queries.append(args.query)
    if args.query_file:
        qf = Path(args.query_file)
        if not qf.is_file():
            print(f"Query file not found: {qf}", file=sys.stderr)
            sys.exit(2)
        with open(qf, "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped and not stripped.startswith("#"):
                    queries.append(stripped)
    if not queries:
        print("Error: at least one --query or --query-file is required.", file=sys.stderr)
        sys.exit(2)
    return queries


# ---------------------------------------------------------------------------
# Semantic Scholar API
# ---------------------------------------------------------------------------

def _build_search_url(query: str, limit: int, offset: int,
                      year_from: Optional[int] = None,
                      venue_filter: Optional[str] = None) -> str:
    """Construct the Semantic Scholar paper/search URL with query params."""
    params: dict[str, Any] = {
        "query": query,
        "limit": min(limit, 100),  # S2 max per page is 100
        "offset": offset,
        "fields": "title,authors,year,venue,externalIds,abstract,url,publicationTypes,citationCount",
    }
    if year_from:
        params["year"] = f"{year_from}-"
    if venue_filter:
        params["venue"] = venue_filter
    return f"{SEMANTIC_SCHOLAR_SEARCH_URL}?{urlencode(params)}"


def _api_get(url: str, rate_limiter: RateLimiter) -> Optional[dict]:
    """Make a single GET request to the Semantic Scholar API with rate limiting."""
    rate_limiter.wait_if_needed()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "CAITLYN-Fetch/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            rate_limiter.record()
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        rate_limiter.record()
        print(f"  HTTP {exc.code} for {url}", file=sys.stderr)
        return None
    except Exception as exc:
        # Don't count network errors against rate limit
        print(f"  Request error: {exc}", file=sys.stderr)
        return None


def _normalize_paper(paper: dict) -> dict:
    """Convert a raw Semantic Scholar paper record to our standard format."""
    authors = [a.get("name", "") for a in paper.get("authors", [])]
    ext = paper.get("externalIds", {}) or {}
    arxiv_id = ext.get("ArXiv", "")
    doi = ext.get("DOI", "")

    paper_url = paper.get("url", "")
    if not paper_url and arxiv_id:
        paper_url = f"https://arxiv.org/abs/{arxiv_id}"

    return {
        "paper_id": paper.get("paperId", ""),
        "title": paper.get("title", ""),
        "authors": authors,
        "year": paper.get("year"),
        "venue": paper.get("venue", ""),
        "url": paper_url,
        "abstract": paper.get("abstract", ""),
        "external_ids": {"ArXiv": arxiv_id, "DOI": doi},
        "citation_count": paper.get("citationCount", 0),
        "publication_types": paper.get("publicationTypes", []),
    }


def search_semantic_scholar(
    query: str,
    limit: int = DEFAULT_LIMIT,
    year_from: Optional[int] = None,
    venue_filter: Optional[str] = None,
    rate_limiter: Optional[RateLimiter] = None,
) -> list[dict]:
    """Search Semantic Scholar for papers matching *query*.

    Returns a list of normalized paper records up to *limit* entries.
    Handles pagination transparently.
    """
    if rate_limiter is None:
        rate_limiter = RateLimiter()

    results: list[dict] = []
    offset = 0
    retrieved = 0

    while retrieved < limit:
        batch_size = min(100, limit - retrieved)
        url = _build_search_url(query, batch_size, offset, year_from, venue_filter)
        print(f"  Query: \"{query}\" offset={offset} limit={batch_size}", file=sys.stderr)

        resp = _api_get(url, rate_limiter)
        if resp is None:
            print("  API call failed; stopping.", file=sys.stderr)
            break

        data = resp.get("data", [])
        if not data:
            break

        for paper in data:
            results.append(_normalize_paper(paper))

        next_offset = resp.get("next")
        if next_offset is None:
            break
        offset = next_offset
        retrieved += len(data)

        # Be polite between pages
        time.sleep(0.5)

    return results[:limit]


def _fetch_page(
    query: str,
    offset: int,
    batch_size: int,
    year_from: Optional[int],
    venue_filter: Optional[str],
    rate_limiter: RateLimiter,
) -> Optional[dict]:
    """Fetch one page of results (used by search_semantic_scholar above)."""
    url = _build_search_url(query, batch_size, offset, year_from, venue_filter)
    return _api_get(url, rate_limiter)


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def output_results(results: list[dict], output_path: Optional[str] = None) -> None:
    """Write JSONL results to *output_path* or stdout."""
    lines = [json.dumps(r, ensure_ascii=False) for r in results]
    content = "\n".join(lines) + "\n" if lines else ""

    if output_path:
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"Wrote {len(results)} results to {out}", file=sys.stderr)
    else:
        sys.stdout.write(content)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str]) -> argparse.Namespace:
    """Parse command-line arguments."""
    p = argparse.ArgumentParser(
        description="CAITLYN Bulk Paper Fetcher — search Semantic Scholar and output JSONL."
    )
    p.add_argument("--query", "-q", type=str, default=None,
                   help="Search query string.")
    p.add_argument("--query-file", type=str, default=None,
                   help="File with one query per line (lines starting with # are comments).")
    p.add_argument("--limit", "-n", type=int, default=DEFAULT_LIMIT,
                   help="Maximum number of results per query (default: 50).")
    p.add_argument("--year-from", type=int, default=None,
                   help="Only return papers published in or after this year.")
    p.add_argument("--venue-filter", type=str, default=None,
                   help="Filter by publication venue name substring.")
    p.add_argument("--output", "-o", type=str, default=None,
                   help="Output JSONL file path (default: stdout).")
    return p.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    """Entry point."""
    if argv is None:
        argv = sys.argv[1:]
    args = parse_args(argv)

    queries = load_queries(args)
    rate_limiter = RateLimiter()

    all_results: list[dict] = []
    for q in queries:
        print(f"Searching: {q}", file=sys.stderr)
        results = search_semantic_scholar(
            q,
            limit=args.limit,
            year_from=args.year_from,
            venue_filter=args.venue_filter,
            rate_limiter=rate_limiter,
        )
        print(f"  Got {len(results)} results", file=sys.stderr)
        all_results.extend(results)

    # Deduplicate by paper_id
    seen: set[str] = set()
    unique: list[dict] = []
    for r in all_results:
        pid = r.get("paper_id", "")
        if pid and pid not in seen:
            seen.add(pid)
            unique.append(r)
        elif not pid:
            # Keep papers without IDs (should not happen, but be safe)
            unique.append(r)

    print(f"Total: {len(unique)} unique results across {len(queries)} queries.", file=sys.stderr)
    output_results(unique, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
