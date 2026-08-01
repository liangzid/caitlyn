#!/usr/bin/env python3
"""caitlyn CLI helpers — called by the caitlyn wrapper script."""
import json, sys, os

CAITLYND_URL = os.environ.get("CAITLYND_URL", "http://127.0.0.1:9070")

def cmd_scan():
    import urllib.request
    content = " ".join(sys.argv[1:])
    if not content:
        print("Usage: caitlyn scan <content>")
        sys.exit(1)
    req = urllib.request.Request(
        f"{CAITLYND_URL}/v1/scan",
        data=json.dumps({"content": content, "context": {"source": "caitlyn-cli"}}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            r = json.loads(resp.read())
    except Exception as e:
        print(f"❌ Scan failed: {e}")
        sys.exit(2)

    v = r["verdict"].upper()
    e = "🚨" if v == "MALICIOUS" else ("⚠️" if v == "SUSPICIOUS" else "✅")
    print(f"{e} {v} ({(r['confidence']*100):.1f}%)")
    print(f"   Latency: {(r['total_latency_us']/1000):.1f}ms | Tokens: {r['total_tokens']}")
    for ab in r.get("script_results", []):
        icon = "🔴" if ab["verdict"] == "malicious" else ("🟡" if ab["verdict"] == "suspicious" else "🟢")
        reason = ab.get("reason") or ""
        print(f"   {icon} {ab['antibody_id']}: {ab['verdict']} ({ab['confidence']*100:.0f}%)")
        if reason:
            print(f"      {reason}")
    sys.exit(1 if v == "MALICIOUS" else 0)

def cmd_status():
    import urllib.request
    try:
        with urllib.request.urlopen(f"{CAITLYND_URL}/v1/status") as resp:
            s = json.loads(resp.read())
    except Exception as e:
        print(f"❌ caitlynd unreachable: {e}")
        sys.exit(1)
    print(f"🛡️  Antibodies: {s.get('antibodies_loaded', 0)}")
    print(f"🧬 Antigens:   {s.get('antigens_loaded', 0)}")
    scans = s.get("scans_total", 0)
    blocked = s.get("scans_blocked", 0)
    flagged = s.get("scans_flagged", 0)
    print(f"📊 Scans:      {scans} total | {blocked} blocked | {flagged} flagged")
    uptime_s = s.get("uptime_ms", 0) / 1000
    print(f"⏱️  Uptime:     {uptime_s:.0f}s")
    watch_dirs = s.get("watch_dirs") or []
    if watch_dirs:
        print(f"👁️  Watching:   {', '.join(watch_dirs)}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: caitlyn-helpers <scan|status> [args...]")
        sys.exit(1)
    cmd = sys.argv[1]
    sys.argv = [sys.argv[0]] + sys.argv[2:]
    {"scan": cmd_scan, "status": cmd_status}[cmd]()
