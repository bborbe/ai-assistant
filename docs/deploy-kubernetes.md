# Deploying to Kubernetes

**Coming soon.** Nothing is deployed to a cluster yet.

For the working deployment, see [deploy-local.md](deploy-local.md).

## Where this actually stands

Rather than a bare placeholder, here is the honest state — so the next person does not rediscover it.

**Already built, and built to survive the move:**

- `Dockerfile` — multi-stage, non-root, `readOnlyRootFilesystem`-compatible, `HEALTHCHECK` wired to `/healthz`
- `k8s/discord-assistant-deploy.yaml` + `-svc.yaml` — pinned to `replicas: 1` with `strategy: Recreate`
- `Makefile.k8s` (`apply`, via `teamvault-cli config parse`) and `make buca`
- `/healthz`, `/readiness`, `/version`, graceful shutdown that drains rather than restarts on a Discord outage
- Config resolved **environment > file > default**, so a ConfigMap overrides without editing anything

**Never applied.** No `discord-assistant` exists in any cluster.

**Not built:**

- The Dockerfile copies `src/` only — `shim/claude_openai_shim.py` is not containerised
- The Deployment references two Services that do not exist: `claude-shim:8080` and `speech-to-speech:8765`

So the bot leg is roughly done and the other two legs are at zero.

## Three unknowns, in the order they gate the work

1. **GPU.** Can the target host run `speech-to-speech` at usable latency? `tools/realtime_probe.py` answers this directly — send a WAV to a realtime socket and measure time to first audio, then compare against the local baseline. Cheap, and the only measurement that matters.
2. **Claude Code auth in a pod.** The shim shells out to the `claude` CLI, which authenticates via Keychain on a laptop. A pod needs a mounted OAuth credential that refreshes, against `readOnlyRootFilesystem: true`, plus a writable workspace. A bigger GPU does not help with this.
3. **Which filesystem the assistant lives on.** Locally it reaches the vault and the workspaces directory. In a cluster it does not. That changes what the assistant _can do_, not just where it runs.

## One invariant that must not be broken

**A Discord bot identity permits exactly one gateway connection.** `replicas: 1` and `strategy: Recreate` exist for this reason, and it also means a cluster instance and a laptop instance can never run at the same time on the same identity. Stop one before starting the other, or use a second Discord application.

## The likely shape

If the GPU answer is "no", the outcome is probably not "stay local" but a **split**: the text surface in the cluster, always up, with voice remaining local while the laptop is on. That fixes the real problem — laptop closed, assistant gone — for the surface that needs no GPU at all.

A `docker-compose.yml` may also be worth adding as a **local k8s-parity dev harness** (bot + shim wired the way the cluster wires them), to exercise container config without a cluster round-trip. That is distinct from using Compose as the local deployment, which was considered and rejected — see the last section of [deploy-local.md](deploy-local.md).
