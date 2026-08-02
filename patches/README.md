# patches/

Changes this project needs in **`huggingface/speech-to-speech`**, kept here because
that repo is a third-party clone: a `git pull` or a fresh clone silently discards
them, and the voice surface then fails in ways that look unrelated.

## speech-to-speech-minimax-thinking.patch

Teaches `LLM/base_openai_compatible_language_model.py` that MiniMax needs
`thinking: {"type": "disabled"}`.

Without it, reasoning cannot be turned off on MiniMax: it ignores both
`chat_template_kwargs.enable_thinking=false` and `reasoning_effort`, the two
mechanisms the upstream code knows about. Worse, MiniMax emits its reasoning
inside `content` rather than `reasoning_content` — so the `<think>` block is
handed to TTS and **read aloud**.

Only `MiniMax-M3` honours the flag. The M2.x models cannot disable reasoning at
all; pin M3 for voice.

Not needed when the endpoint is the Claude Code shim.

```bash
cd ~/Documents/workspaces/speech-to-speech
git apply ~/Documents/workspaces/discord-assistant/patches/speech-to-speech-minimax-thinking.patch
```

Worth upstreaming — the provider dispatch already exists in `_build_extra_body`,
this only adds a MiniMax branch.
