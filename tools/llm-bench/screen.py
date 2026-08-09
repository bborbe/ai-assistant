#!/usr/bin/env python3
"""Stage-1 broad screen: TTFT + streaming behaviour for every reachable model.

Every provider is hit on its OWN OpenAI-compatible endpoint rather than through
the Anthropic router -- one code path, and it matches what the Discord shim's
front tier actually speaks. (The router's Anthropic surface is what buffers on
z.ai, so measuring there would have re-measured the surface, not the model.)
"""
import json
import pathlib
import re
import sys
import time
import urllib.request

CFG = pathlib.Path.home() / ".config/claude-code-router/config.yaml"
TXT = CFG.read_text()


def token(name):
    m = re.search(r'^  %s:\n((?:    .*\n|\s*#.*\n)+)' % re.escape(name), TXT, re.M)
    if not m:
        return ""
    t = re.search(r'token:\s*(\S+)', m.group(1))
    return t.group(1).strip('"\'') if t else ""


PROVIDERS = {
    "minimax": ("https://api.minimax.io/v1/chat/completions", token("minimax")),
    "zai":     ("https://api.z.ai/api/coding/paas/v4/chat/completions", token("zai")),
    "seibert": ("https://vllm.seibert.tools/v1/chat/completions", token("seibert-vllm")),
    "ollama":  ("http://localhost:11434/v1/chat/completions", "ollama"),
}

MODELS = [
    ("minimax", m) for m in [
        "MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed",
        "MiniMax-M2.5", "MiniMax-M2.5-highspeed",
        "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2"]
] + [
    ("zai", m) for m in [
        "glm-5.2", "glm-5.1", "glm-5-turbo", "glm-5",
        "glm-4.7", "glm-4.6", "glm-4.5", "glm-4.5-air"]
] + [
    ("seibert", m) for m in [
        "deepseek-v4-flash", "deepseek-v4-flash-low", "deepseek-v4-flash-fast",
        "deepseek-v4-flash-max", "dsv4f-mtp", "dsv4f-25-mtp",
        "gemma4-31b-rtxpro-mtp", "gemma4-31b-rtxpro-mtp-non-thinking",
        "qwen3-vl-8b"]
] + [
    ("ollama", "qwen3.6:35b-a3b-mxfp8"),
]

SYSTEM = ("You are a helpful assistant answering in a Discord chat. "
          "Keep answers short and conversational unless asked for detail.")
PROMPTS = [
    "what's the difference between a slice and an array in Go?",
    "is it worth switching?",
]


def run(prov, model, prompt, nothink=False, timeout=120):
    """prompt: a user string, or a full message list for multi-turn fixtures."""
    url, tok = PROVIDERS[prov]
    turns = (prompt if isinstance(prompt, list)
             else [{"role": "user", "content": prompt}])
    body = {"model": model, "stream": True, "max_tokens": 400,
            "messages": [{"role": "system", "content": SYSTEM}] + turns}
    if nothink:
        body["thinking"] = {"type": "disabled"}
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={"content-type": "application/json",
                 "Authorization": "Bearer " + tok})
    t0 = time.monotonic()
    first = None
    last = 0.0
    n = 0
    text = []
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            for raw in resp:
                s = raw.decode("utf-8", "replace").strip()
                if not s.startswith("data:"):
                    continue
                payload = s[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    ev = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                ch = (ev.get("choices") or [{}])[0]
                d = ch.get("delta") or {}
                # count only VISIBLE content; reasoning_content is not shown
                piece = d.get("content")
                if piece:
                    n += 1
                    last = time.monotonic() - t0
                    if first is None:
                        first = last
                    text.append(piece)
    except Exception as exc:                       # noqa: BLE001
        return {"err": "%s: %s" % (type(exc).__name__, str(exc)[:60])}
    return {"ttft": first, "total": last or (time.monotonic() - t0),
            "chunks": n, "text": "".join(text)}


def main():
    nothink = "--nothink" in sys.argv
    out = {}
    print("%-38s %8s %8s %7s  %s" % ("model", "TTFT", "total", "chunks", "stream"))
    print("-" * 78)
    for prov, model in MODELS:
        rows = [run(prov, model, p, nothink) for p in PROMPTS]
        ok = [r for r in rows if "err" not in r and r.get("ttft")]
        if not ok:
            err = rows[0].get("err", "no visible text")
            print("%-38s %s" % (model, "ERR " + err))
            out[model] = {"provider": prov, "error": err}
            continue
        ttft = min(r["ttft"] for r in ok)
        total = max(r["total"] for r in ok)
        chunks = max(r["chunks"] for r in ok)
        spread = max(r["total"] - r["ttft"] for r in ok)
        streams = "yes" if spread > 0.3 else "BURST"
        print("%-38s %7.2fs %7.2fs %7d  %s" % (model, ttft, total, chunks, streams))
        out[model] = {"provider": prov, "ttft": ttft, "total": total,
                      "chunks": chunks, "streams": streams,
                      "sample": ok[0]["text"][:200]}
    name = "screen_nothink.json" if nothink else "screen.json"
    with open(name, "w") as fh:
        json.dump(out, fh, indent=2)
    print("\nwrote", name)


if __name__ == "__main__":
    main()
