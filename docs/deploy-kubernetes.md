# Deploying to Kubernetes

**Coming soon.** Nothing is deployed to a cluster yet.

For the working deployment, see [deploy-local.md](deploy-local.md).

## Where this actually stands

Rather than a bare placeholder, here is the honest state — so the next person does not rediscover it.

**Already built, and built to survive the move:**

- `Dockerfile` — multi-stage, non-root, `readOnlyRootFilesystem`-compatible, `HEALTHCHECK` wired to `/healthz`
- `k8s/discord-assistant-deploy.yaml` + `-svc.yaml` — `strategy: Recreate`, and `replicas` declared **0**; the hold is explained under [One invariant that must not be broken](#one-invariant-that-must-not-be-broken)
- `Makefile.k8s` (`apply`, via `teamvault-cli config parse`) and `make buca`
- `/healthz`, `/readiness`, `/version`, graceful shutdown that drains rather than restarts on a Discord outage
- Config resolved **environment > file > default**, so a ConfigMap overrides without editing anything

**Applied.** `discord-assistant` exists in the `star-citizen` namespace and ran there until 2026-10-03, when it was deliberately held down — see [One invariant that must not be broken](#one-invariant-that-must-not-be-broken).

**Built (2026-08-27):**

- The Dockerfile now copies `shim/` alongside `src/`, and installs `python3` + the `claude` CLI — one image carries both runtimes. The bot Deployment runs the default `ENTRYPOINT` (`node src/index.js`); the shim Deployment overrides the command to `python3 -u shim/claude_openai_shim.py`.
- Two Deployments sharing that image: `discord-assistant` (bot) + `discord-assistant-shim`, with a real `claude-shim` Service on 8080 — the bot's `OPENAI_BASE_URL` points at it.
- The shim reaches the backend through the **in-cluster claude-code-router** (`ANTHROPIC_BASE_URL=http://claude-code-router-dev:8788`), with a router `x-api-key` (from `allowedApiKeys`) as `ANTHROPIC_API_KEY` — no provider credential in the pod.
- Text-only baseline: `VOICE_ENABLED=0` on the bot (voice stays on the laptop; no GPU on any node). The dead `speech-to-speech:8765` Service wiring is dropped.

**Not built yet:**

- The `vault` volume is an `emptyDir` placeholder — provisioning (NFS / hostPath / PVC) is the deploy owner's job, per the Deploy Discord Assistant to Kubernetes task.
- The dynamic voice back-connect (laptop reachable → `/join` works; unreachable → graceful "text only" reply) is a later subtask of that same task.

## Three unknowns, in the order they gate the work

1. **GPU.** Can the target host run `speech-to-speech` at usable latency? `tools/realtime_probe.py` answers this directly — send a WAV to a realtime socket and measure time to first audio, then compare against the local baseline. Cheap, and the only measurement that matters.
2. **Claude Code auth in a pod.** The shim shells out to the `claude` CLI, which authenticates via Keychain on a laptop. A pod needs a mounted OAuth credential that refreshes, against `readOnlyRootFilesystem: true`, plus a writable workspace. A bigger GPU does not help with this.
3. **Which filesystem the assistant lives on.** Locally it reaches the vault and the workspaces directory. In a cluster it does not. That changes what the assistant _can do_, not just where it runs.

## One invariant that must not be broken

**A Discord bot identity permits exactly one gateway connection.** `strategy: Recreate` exists for this reason, and it also means a cluster instance and a laptop instance can never run at the same time on the same identity. Stop one before starting the other, or use a second Discord application.

⚠️ **This is not hypothetical — it happened on 2026-10-03.** The cluster assistant and the laptop instance share the application `Star Citizen Assistant` (id `1536456376258404452`). With both live, Discord delivered every interaction to *both* gateway sessions: the text-only pod answered the voice subcommands with `VOICE_DISABLED_REPLY` and won the acknowledgement race, and the laptop instance — the one that actually has voice — then died on an uncaught `DiscordAPIError[10062] Unknown interaction`, twice inside one minute, restarting under launchd each time. The two also overwrite each other's guild registration, since registrations are per-application, so the live `/sc` flapped between the pod's 5 subcommands and the laptop's 11.

`k8s/discord-assistant-deploy.yaml` therefore declares `replicas: 0`. The hold is a *declaration* rather than a hand-applied scale, so an apply cannot undo it. Raise it back to 1 only when the pod is the sole holder of the identity, or has its own Discord application.

## The likely shape

If the GPU answer is "no", the outcome is probably not "stay local" but a **split**: the text surface in the cluster, with voice remaining local while the laptop is on. That fixes the real problem — laptop closed, assistant gone — for the surface that needs no GPU at all. It does require a **second Discord application** — the cluster and laptop instances cannot both hold one identity (see above) — so until that exists the cluster copy stays at `replicas: 0`.

A `docker-compose.yml` may also be worth adding as a **local k8s-parity dev harness** (bot + shim wired the way the cluster wires them), to exercise container config without a cluster round-trip. That is distinct from using Compose as the local deployment, which was considered and rejected — see the last section of [deploy-local.md](deploy-local.md).
