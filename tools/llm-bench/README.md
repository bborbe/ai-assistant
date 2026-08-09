# llm-bench — chat-shaped LLM benchmark

Hand-run diagnostics for choosing the shim's **front-tier** model (`SHIM_FRONT_MODEL`,
see `shim/claude_openai_shim.py`). Not wired into CI, not imported by the bot.

> **This is a parked copy, not the intended home.** These scripts belong in
> `bborbe/coding`'s `bench/` as a second fixture under its runner contract — that
> repo already models configuration identity as `(rules+commands, model, effort,
> mode)` with a results ledger and scoring layer. They live here because they were
> written for this repo's model choice and would otherwise have been lost.

## Why a separate benchmark exists

Public boards and the repo-adjacent `coding/bench` all score **agentic tool loops**,
where turn count dominates wall time. A chat surface is short-turn: **time to first
visible token dominates and turn count barely applies.** The rankings do not carry
over — measured 2026-08-09, MiniMax-M2.7 beats M3 on a code-review fixture while M3
beats M2.7 decisively here. Thinking-before-answering is an asset in a tool loop and
a ~3s liability in chat.

## The one rule that matters

**Count only user-visible text.** Separate `reasoning_content` from `content` on the
OpenAI surface, and `thinking_delta` from `text_delta` on the Anthropic one.

Conflating them is not a rounding error — it inverts conclusions. During the original
run it produced three successive wrong answers about GLM ("does not stream" → "streams
fine" → "it's a thinking artifact") before the separated measurement showed the truth:
GLM on the OpenAI surface with thinking **on** returns _zero_ visible text under a
token cap, spending the entire budget on reasoning, while the stream looks perfectly
healthy to a client reading `delta.content`.

## Scripts

| Script          | Answers                                                          |
| --------------- | ---------------------------------------------------------------- |
| `screen.py`     | broad sweep — TTFT + streaming granularity for every model       |
| `bench2.py`     | full 8-prompt Discord fixture + fabrication re-test on finalists |
| `ds_matrix.py`  | one provider family: surface × variant × reasoning × fabrication |
| `zai_matrix.py` | symmetric surface × thinking-mode matrix, text-only timing       |

`bench2.py`, `ds_matrix.py` and `zai_matrix.py` import transport and credentials from
`screen.py`, so keep them colocated.

## Credentials

Tokens are read at runtime from `~/.config/claude-code-router/config.yaml` and are
never stored here or passed on a command line. Nothing runs without that file.

Each provider is hit on its **own** OpenAI-compatible endpoint rather than through
the router's Anthropic surface — one code path for a fair comparison, and it matches
what the shim's front tier actually speaks. Measuring via the Anthropic surface
re-measures z.ai's buffering instead of the model.

## Running

```bash
python3 -u screen.py                    # all models
python3 -u screen.py MiniMax-M3         # subset
python3 -u screen.py --nothink          # thinking disabled where supported

python3 -u bench2.py minimax:MiniMax-M3 zai:glm-4.6:nothink seibert:deepseek-v4-flash-fast
```

Always `-u`. Without it the output buffers and a long sweep looks hung.

## Gotchas found the hard way

- **`MiniMax-M3-highspeed` does not exist.** The name is accepted and silently
  resolves to plain `MiniMax-M3`; the router's `m3` alias names a phantom.
- **GLM works in exactly one configuration** — OpenAI-coding endpoint plus
  `thinking:{type:"disabled"}`. The Anthropic surface buffers unconditionally.
- **z.ai's `api/paas/v4` returns 429** on a Coding Plan key; use `api/coding/paas/v4`.
- **`vllm.seibert.tools` is a multi-provider gateway**, not a plain vLLM. Its
  `/stats` lists historical usage (~29 models), `/v1/models` what is currently
  servable (12) — and being listed does not mean it answers.
- **Fastest ≠ usable.** DeepSeek V4 Flash leads on TTFT (0.19s) and fabricated 17 of
  24 live-data prompts, including narrating lookups it cannot perform.

Full results and coverage map: `[[Agent Subscription Landscape]]` § Chat-Shaped
Latency in the Personal vault.
