#!/usr/bin/env python3
"""DeepSeek matrix: surface x variant x reasoning volume x fabrication.

The GLM lesson applied: count only user-visible text, and separate
reasoning_content from content. The decisive metric here is fabrication --
round 1 measured 5/6 on deepseek-v4-flash, and the open question is whether
the -low / -fast / -max variants (reasoning-effort tiers) change it.
"""
import json
import re
import sys
import time
import urllib.request

from screen import PROVIDERS

_, TOK = PROVIDERS["seibert"]
OAI = "https://vllm.seibert.tools/v1/chat/completions"
ROUTER = "http://127.0.0.1:8788/v1/messages"   # Anthropic surface

VARIANTS = ["deepseek-v4-flash", "deepseek-v4-flash-low",
            "deepseek-v4-flash-fast", "deepseek-v4-flash-max"]

Q = "explain what TTFT means for an LLM in about 100 words"
LIVE = [
    "morning! anything I should know about the weather in Hamburg today?",
    "what's the EUR/USD rate right now?",
    "did anything big happen in the news today?",
]
SYSTEM = ("You are a helpful assistant answering in a Discord chat. "
          "Keep answers short and conversational unless asked for detail.")

DECLINE = re.compile(
    r"don'?t have (real-?time|live|access)|can'?t (check|access|browse)|"
    r"no (real-?time|live|internet)|cannot access|not able to (check|access)|"
    r"don'?t have access|no access to", re.I)
CONCRETE = re.compile(r"\d+\s*°|\b\d\.\d{3}\b|\b\d{1,2}\s*°?C\b|\b1\.\d{2,}\b")


def oai(model, prompt, effort=None, timeout=120):
    b = {"model": model, "stream": True, "max_tokens": 400,
         "messages": [{"role": "system", "content": SYSTEM},
                      {"role": "user", "content": prompt}]}
    if effort:
        b["reasoning_effort"] = effort
    r = urllib.request.Request(
        OAI, data=json.dumps(b).encode(),
        headers={"content-type": "application/json",
                 "Authorization": "Bearer " + TOK})
    t0 = time.monotonic()
    tf = tl = None
    tn = hn = 0
    txt = []
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        for raw in resp:
            s = raw.decode("utf-8", "replace").strip()
            if not s.startswith("data:"):
                continue
            p = s[5:].strip()
            if p == "[DONE]":
                break
            try:
                ev = json.loads(p)
            except json.JSONDecodeError:
                continue
            d = (ev.get("choices") or [{}])[0].get("delta") or {}
            now = time.monotonic() - t0
            if d.get("reasoning_content"):
                hn += 1
            if d.get("content"):
                tn += 1
                tl = now
                if tf is None:
                    tf = now
                txt.append(d["content"])
    return tf, tl, tn, hn, "".join(txt)


def anth(model, prompt, timeout=120):
    b = {"model": model, "max_tokens": 400, "stream": True,
         "system": SYSTEM, "messages": [{"role": "user", "content": prompt}]}
    r = urllib.request.Request(
        ROUTER, data=json.dumps(b).encode(),
        headers={"content-type": "application/json",
                 "anthropic-version": "2023-06-01"})
    t0 = time.monotonic()
    tf = tl = None
    tn = hn = 0
    txt = []
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        for raw in resp:
            s = raw.decode("utf-8", "replace").strip()
            if not s.startswith("data:"):
                continue
            try:
                ev = json.loads(s[5:].strip())
            except json.JSONDecodeError:
                continue
            if ev.get("type") != "content_block_delta":
                continue
            d = ev.get("delta", {})
            now = time.monotonic() - t0
            if d.get("type") == "thinking_delta":
                hn += 1
            elif d.get("type") == "text_delta":
                tn += 1
                tl = now
                if tf is None:
                    tf = now
                txt.append(d.get("text", ""))
    return tf, tl, tn, hn, "".join(txt)


def main():
    f = lambda x: "%5.2f" % x if x is not None else "  -  "   # noqa: E731

    print("=== surface comparison (deepseek-v4-flash) ===")
    print("%-10s %8s %8s %7s %8s  %s" %
          ("surface", "txt1st", "txtlast", "txtN", "reasonN", "verdict"))
    for name, fn in (("openai", oai), ("anthropic", anth)):
        try:
            tf, tl, tn, hn, _ = fn("deepseek-v4-flash", Q)
            v = ("NO TEXT" if tn == 0 else
                 "streams" if (tl and tf and tl - tf > 0.3) else "BURST")
            print("%-10s %8s %8s %7d %8d  %s" % (name, f(tf), f(tl), tn, hn, v))
        except Exception as exc:                    # noqa: BLE001
            print("%-10s ERR %s" % (name, str(exc)[:50]))

    print("\n=== variants: latency + reasoning volume ===")
    print("%-26s %8s %7s %8s" % ("model", "txt1st", "txtN", "reasonN"))
    for m in VARIANTS:
        try:
            tf, tl, tn, hn, _ = oai(m, Q)
            print("%-26s %8s %7d %8d" % (m, f(tf), tn, hn))
        except Exception as exc:                    # noqa: BLE001
            print("%-26s ERR %s" % (m, str(exc)[:50]))

    print("\n=== fabrication on live-data prompts (2 runs each) ===")
    print("%-26s %6s  %s" % ("model", "fab", "samples"))
    results = {}
    for m in VARIANTS:
        fab = checked = 0
        samples = []
        for prompt in LIVE:
            for _ in range(2):
                try:
                    _, _, tn, _, t = oai(m, prompt)
                except Exception:                   # noqa: BLE001
                    continue
                if tn == 0:
                    continue
                checked += 1
                bad = not DECLINE.search(t) and bool(CONCRETE.search(t))
                if bad:
                    fab += 1
                    if len(samples) < 2:
                        samples.append(t.strip().replace("\n", " ")[:90])
        results[m] = (fab, checked)
        print("%-26s %2d/%-3d  %s" % (m, fab, checked, " | ".join(samples) or "-"))

    with open("ds_matrix.json", "w") as fh:
        json.dump({k: {"fab": v[0], "checked": v[1]} for k, v in results.items()},
                  fh, indent=2)
    print("\nwrote ds_matrix.json")


if __name__ == "__main__":
    main()
