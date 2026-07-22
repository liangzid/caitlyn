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
    for ab in r.get("antibody_results", []):
        icon = "🔴" if ab["verdict"] == "malicious" else ("🟡" if ab["verdict"] == "suspicious" else "🟢")
        print(f"   {icon} {ab['antibody_name']}: {ab['verdict']} ({ab['confidence']*100:.0f}%)")
    if r.get("triggered_vaccination"):
        print("   💉 Vaccination triggered!")
    sys.exit(1 if v == "MALICIOUS" else 0)

def cmd_status():
    import urllib.request
    try:
        with urllib.request.urlopen(f"{CAITLYND_URL}/v1/status") as resp:
            s = json.loads(resp.read())
    except Exception as e:
        print(f"❌ caitlynd unreachable: {e}")
        sys.exit(1)
    print(f"🛡️  Active Antibodies: {s['active_antibodies']}")
    print(f"🧠 Memory Entries:    {s['memory_entries']}")
    print(f"📊 Tracked Patterns:  {s['tracked_patterns']}")
    print(f"📦 Version:           {s['version']}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: caitlyn-helpers <scan|status> [args...]")
        sys.exit(1)
    cmd = sys.argv[1]
    sys.argv = [sys.argv[0]] + sys.argv[2:]
    {"scan": cmd_scan, "status": cmd_status}[cmd]()
