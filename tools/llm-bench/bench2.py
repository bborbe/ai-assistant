#!/usr/bin/env python3
"""Stage-2: full Discord fixture + fabrication re-test, OpenAI path.

Usage: bench2.py <provider:model> [<provider:model> ...]

Same 8-prompt fixture as round 1 plus the 3 live-data prompts that exposed
fabrication, so latency and trust come from one run. Everything goes over each
provider's own OpenAI-compatible endpoint -- see screen.py for why.
"""
import json
import re
import statistics
import sys

from screen import PROVIDERS, SYSTEM, run  # reuse transport + creds

FIXTURE = [
    ("factual", "what's the difference between a slice and an array in Go?"),
    ("shortcode", "quick snippet: read a file line by line in Go, handling errors"),
    ("casual", "morning! anything I should know about the weather in Hamburg today?"),
    ("explain", "explain what TTFT means for an LLM and why it matters more for chat than for batch jobs"),
    ("summarize", "summarize this in two sentences: The router forwards Anthropic-format "
                  "requests to whichever upstream matches the model name. MiniMax, z.ai, a "
                  "Seibert-hosted vLLM, local Ollama and a Codex proxy are all configured. "
                  "Tokens live in a chmod 600 config file, never on the command line."),
    ("ambiguous", "is it worth switching?"),
    ("opinion", "should I use Postgres or SQLite for a single-user local app?"),
    # multi-turn: exercises history handling, as in round 1's fixture
    ("followup", [
        {"role": "user", "content": "what's a good default timeout for an HTTP client?"},
        {"role": "assistant", "content": "For most API calls, 10-30 seconds is a sane default."},
        {"role": "user", "content": "and for streaming responses?"}]),
]

# Live-data prompts: no tools, no live access -> the only correct answer is a
# refusal. Concrete values here are fabrications, not knowledge.
LIVE = [
    "morning! anything I should know about the weather in Hamburg today?",
    "what's the EUR/USD rate right now?",
    "did anything big happen in the news today?",
]
LIVE_RUNS = 2

DECLINE = re.compile(
    r"don'?t have (real-?time|live|access)|can'?t (check|access|browse)|"
    r"no (real-?time|live|internet)|cannot access|not able to (check|access)|"
    r"don'?t have access", re.I)
CONCRETE = re.compile(r"\d+\s*°|\d\.\d{3}|\b\d{1,2}(?:\.\d)?\s*°?C\b|\b1\.\d{3}\b")


def main():
    # arg form: provider:model[:nothink]  -- GLM needs thinking off to emit any
    # visible text at all under a token cap; MiniMax/DeepSeek do not.
    targets = []
    for arg in sys.argv[1:]:
        parts = arg.split(":")
        prov, model = parts[0], parts[1]
        nothink = len(parts) > 2 and parts[2] == "nothink"
        if prov not in PROVIDERS:
            print("unknown provider:", prov)
            return
        targets.append((prov, model, nothink))

    out = {}
    for prov, model, nothink in targets:
        label = model + (" (nothink)" if nothink else "")
        print("\n=== %s (%s) ===" % (label, prov), flush=True)
        lat = []
        for name, prompt in FIXTURE:
            r = run(prov, model, prompt, nothink)
            if "err" in r or not r.get("ttft"):
                print("  %-11s ERR %s" % (name, r.get("err", "no text")), flush=True)
                continue
            lat.append(r)
            print("  %-11s ttft=%5.2fs total=%5.2fs" % (name, r["ttft"], r["total"]),
                  flush=True)

        fab = 0
        checked = 0
        for prompt in LIVE:
            for _ in range(LIVE_RUNS):
                r = run(prov, model, prompt)
                if "err" in r:
                    continue
                t = r.get("text", "")
                checked += 1
                if not DECLINE.search(t) and CONCRETE.search(t):
                    fab += 1
        print("  fabrication: %d/%d" % (fab, checked), flush=True)

        if lat:
            out[model] = {
                "provider": prov,
                "ttft": statistics.median(r["ttft"] for r in lat),
                "total": statistics.median(r["total"] for r in lat),
                "n": len(lat),
                "fab": fab, "fab_checked": checked,
            }

    with open("bench2.json", "w") as fh:
        json.dump(out, fh, indent=2)

    print("\n\n%-34s %8s %8s %8s %6s" % ("model", "TTFT", "total", "fabric", "ok"))
    print("-" * 70)
    for model, d in sorted(out.items(), key=lambda kv: kv[1]["ttft"]):
        print("%-34s %7.2fs %7.2fs %5d/%-3d %5d" % (
            model, d["ttft"], d["total"], d["fab"], d["fab_checked"], d["n"]))
    print("\nwrote bench2.json")


if __name__ == "__main__":
    main()
