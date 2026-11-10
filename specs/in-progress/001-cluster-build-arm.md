---
status: approved
approved: '2026-11-10T13:22:11Z'
branch: dark-factory/cluster-build-arm
---

## Summary

- This repo's image can currently be produced on one machine only: the Mac.
- Every other repo in its migration family can also build its image inside a Kubernetes cluster, unattended, from any committed ref.
- Add that second build path here as an arm beside the existing local one, leaving the local command and tag as they are.
- The cluster arm builds a named commit as a Kubernetes Job and pushes the result to `docker.io/bborbe/discord-assistant:<tag>`.
- Five `hack/` files are copied from two reference repos; no new build machinery is invented.

## Problem

`discord-assistant` is the last `to-migrate` row of its goal's target set. Its `Makefile.docker` carries a single `build:` recipe that runs `docker build` on the caller's machine, so the image exists only where a human is sitting. Three properties of this repo shape the arm:

- **`SERVICE` already carries the owner.** `Makefile:20` declares `SERVICE = bborbe/discord-assistant`, and `Makefile.docker:14` composes `$(DOCKER_REGISTRY)/$(SERVICE)`. The sibling repos this arm is copied from use a bare `SERVICE` plus `IMAGE ?= bborbe/$(SERVICE)`; copying that pattern verbatim here yields `bborbe/bborbe/discord-assistant`. The owner prefix must not be added twice.
- **`DOCKER_REGISTRY` has no default.** It appears nowhere in `Makefile` or `Makefile.variables`, and `local.env` is gitignored (`.gitignore` carries `local.env*`). On a fresh clone the local arm therefore tags `/bborbe/discord-assistant:<branch>`, and a cluster build must not inherit that empty prefix.
- **There is no `VERSION` concept.** The local arm tags by `BRANCH`, which defaults to the checked-out branch. A cluster build names a commit, not a branch, so the tag must come from the caller.

Two further properties make the copy cheap and constrain it:

- The repo is public (`gh api repos/bborbe/ai-assistant` reads `private: false`), so the Job's anonymous `git fetch` succeeds and no clone credential is needed.
- There is no `Makefile.env` branch guard in this repo, so unlike the pilot there is no parse-time refusal to narrow.

## Goal

`make build` on this repo produces the image locally exactly as it does today, and `make build BUILD_TARGET=<cluster> REF=<sha> VERSION=<tag>` produces it inside that cluster as a Kubernetes Job, pushing `docker.io/bborbe/discord-assistant:<tag>`. Both arms work from the same checkout, and the cluster arm works from a fresh clone with no local preparation.

## Non-goals

- Changing the local arm's command or its tag. Both stay as they are.
- Making the deployed manifest pull the image the cluster arm pushes. The manifests render `docker.prod.nuke.benjamin-borbe.de:443` from `DOCKER_REGISTRY` while the cluster arm can only push Docker Hub, so the two names cannot meet by construction. That is a separate task.
- Adding a nuke `MIRROR_IMAGES` entry. The private-registry copy is produced by nuke's mirror step, and no nuke reference to this component was found; the mirror belongs with the deploy-path change.
- Building at release or tag time. This spec adds the capability; _when_ a build is triggered is a separate concern.
- Multi-arch images. `linux/amd64` only, matching the cluster nodes.
- Extra build knobs beyond `BUILD_TARGET`, `REF` and `VERSION`. The repository URL and the push-secret name are literals in the dispatch, not configurable inputs.
- Refreshing the local clone's commit drift.
- Guarding against a caller-supplied `VERSION` that names an already-released tag. The push replaces it irreversibly; callers pass scratch tags. A pre-push `crane digest` guard is a separate change.

## Alternatives Considered

- **A GitHub Actions build.** The rest of the migration family builds in-cluster via a Job; a CI-runner build would be a second mechanism to operate and would still need the same push credential. Rejected as a parallel system.
- **A repo-local runner written from scratch.** It would re-implement the alias resolution, the hardened Job template and the render-and-poll loop — three files whose correctness is already proven in production on sibling repos. Copying is cheaper and keeps the family identical.
- **Do nothing.** See below.

## Acceptance Criteria

- [ ] **The local arm is unchanged** — with no `BUILD_TARGET` set, `make -n build` prints the `docker build` recipe and no reference to `hack/build-cluster.sh`; a real `DOCKER_REGISTRY=docker.io BUILD_TARGET=local DOCKER_CONTEXT=orbstack make build` exits 0; and `DOCKER_CONTEXT=orbstack docker image inspect docker.io/bborbe/discord-assistant:<branch>` exits 0 with an `.Id` that differs from a pre-build read of the same reference (or, where the reference did not exist before, an `.Id` that now exists). Evidence: the `-n` output, the exit code, and the pre- and post-build image ids. ⚠️ **`DOCKER_REGISTRY` must be supplied explicitly.** It has no default and `local.env` is gitignored and absent from a worktree, so an unsupplied registry composes `/bborbe/discord-assistant:<branch>` — an invalid reference format Docker rejects outright. ⚠️ The `DOCKER_CONTEXT=orbstack` prefix is load-bearing: this Mac's active context read `sun` on 2026-11-10, so an unprefixed build or inspect reaches the wrong daemon.
- [ ] **Post-Deploy (Rung-2):** the cluster arm builds and pushes from a fresh clone — `make build BUILD_TARGET=<cluster> REF=<full 40-character sha> VERSION=<scratch-tag>` exits 0, where `<scratch-tag>` cannot pre-exist (`scratch-<YYYYMMDD>-<sha7>-<n>`). Evidence: a pre-build `crane digest docker.io/bborbe/discord-assistant:<scratch-tag>` fails with `MANIFEST_UNKNOWN`; the Job name and the build pod's `spec.nodeName`; a post-build `crane digest` equal to the digest the Job's own log reports (`containerimage.digest`); and `DOCKER_CONTEXT=orbstack docker image inspect` on that reference failing on this Mac with `No such image`. `docker image inspect` failing alone is not evidence — it fails for every unpulled reference on this Mac.
  - `deploy_check:` `kubectl --context default --kubeconfig ~/.kube/sun -n build get secret buildkit-push -o jsonpath='{.metadata.name}'`
  - `deploy_target:` `buildkit-push`
- [ ] **`hack/` holds the five copied files and the cluster branch invokes the runner** — at the recorded head SHA, `git ls-tree --name-only <sha>:hack/` lists `build-cluster.sh`, `cluster-alias.sh`, `build-job.yaml`, `build-cluster-bootstrap.sh` and `dockerconfig.json.tpl`; `git show <sha>:Makefile.docker | grep -cE '^[[:space:]]+(\./|bash[[:space:]]+)?hack/build-cluster\.sh'` returns ≥ 1; and `make -n build BUILD_TARGET=sun REF=<sha> VERSION=probe` prints `hack/build-cluster.sh`. Evidence: the five names, the count, and the dry-run line. ⚠️ The anchored grep alone does not prove the invocation sits under `build:` — a dead target satisfies it — so the `make -n` line is what binds it. The leading-whitespace anchor is required because the copied header comments name the script. ⚠️ Two of the five files are never exercised by AC2, so assert their content too: `grep -c 'buildkit-push' hack/build-cluster-bootstrap.sh` ≥ 1 and `grep -c 'teamvaultUser' hack/dockerconfig.json.tpl` ≥ 1. ⚠️ **Assert byte fidelity, not just presence.** `make precommit` runs `npx prettier --write .` and this repo sets `singleQuote: true`, so `hack/build-job.yaml` is silently reformatted on the first precommit unless `hack/` is added to `.prettierignore`. Evidence: `grep -cE '^/?hack/?$' .prettierignore` = 1; after `make precommit`, `git status --porcelain hack/` is empty; and, with a clone of each source repo at hand, `diff <(git -C <clone> show <sha>:hack/<f>) hack/<f>` is empty for all five files. ⚠️ A `git show <sha>` against this repo's own commit is not that check — it compares a commit to its own working tree and is empty whenever the tree is clean, which is exactly the state it is meant to detect divergence from.
- [ ] **Post-Deploy (Rung-2):** the cluster arm refuses a tag it did not receive from the caller — `make build BUILD_TARGET=<cluster> REF=<sha>` with no `VERSION` exits non-zero and names `VERSION`, before any Job is applied. Evidence: the exit code and the message, plus `kubectl -n build get jobs` showing no new Job for that run.
  - `deploy_check:` `kubectl --context default --kubeconfig ~/.kube/sun -n build get namespace build -o jsonpath='{.metadata.name}'`
  - `deploy_target:` `build`
- [ ] **The documented build path matches reality** — a build doc (`docs/build.md`, linked from `README.md`'s Deployment list alongside `deploy-local.md` and `deploy-kubernetes.md`) shows the cluster invocation and records that the cluster arm pushes `docker.io/bborbe/discord-assistant`; `CHANGELOG.md` carries a `## Unreleased` section with a conventional-prefix bullet for this change. Evidence: `grep -c 'BUILD_TARGET=' docs/build.md` ≥ 1, `grep -c 'docker.io/bborbe/discord-assistant' docs/build.md` ≥ 1, a `README.md` link to it, and `grep -c '^## Unreleased$' CHANGELOG.md` = 1.

## Verification

### Container-executable (runs inside the YOLO container at prompt time)

- `make precommit` — prettier, eslint, node tests, npm audit, trivy clean
- `bash -n hack/build-cluster.sh && bash -n hack/cluster-alias.sh && bash -n hack/build-cluster-bootstrap.sh` — the copied runners parse
- `git ls-tree --name-only HEAD hack/` lists the five expected files
- `grep -c '^BUILD_TARGET' Makefile.docker` returns ≥ 1
- `grep -cE '^[[:space:]]+(\./|bash[[:space:]]+)?hack/build-cluster\.sh' Makefile.docker` returns ≥ 1
- `make -n build` prints a `docker build` recipe and no `hack/build-cluster.sh`
- `make -n build BUILD_TARGET=sun REF=<sha> VERSION=probe` prints `hack/build-cluster.sh` and the composed `docker.io/bborbe/discord-assistant:probe` line
- `grep -c '^## Unreleased$' CHANGELOG.md` returns 1
- `grep -cE '^/?hack/?$' .prettierignore` returns 1
- after `make precommit`, `git status --porcelain hack/` is empty

### Operator-executable (runs on the host after PR merge)

- `make build BUILD_TARGET=<cluster> REF=<sha> VERSION=<scratch-tag>` — one real cluster build; record the Job name, node and digest
- `crane digest docker.io/bborbe/discord-assistant:<scratch-tag>` — the push landed
- `DOCKER_REGISTRY=docker.io BUILD_TARGET=local DOCKER_CONTEXT=orbstack make build` then `DOCKER_CONTEXT=orbstack docker image inspect docker.io/bborbe/discord-assistant:<branch>` — the local arm still works

## Desired Behavior

1. **A build target selects the arm.** `BUILD_TARGET` defaults to `local`. With `local`, `make build` behaves exactly as it does today: it runs `docker build` on this machine and tags `$(DOCKER_REGISTRY)/$(SERVICE):$(BRANCH)`.
2. **Any other value routes to a cluster Job.** With `BUILD_TARGET` set to a cluster alias or kubectl context, `make build` prints the composed image reference, then renders the Job template and applies it through the copied runner, passing the repository URL and the push-secret name as literals, and the caller's `VERSION` as the runner's `TAG`. It waits for the Job and reports success or failure with the Job's own log lines.
3. **The cluster arm needs a caller-supplied tag.** The cluster arm refuses to run unless `VERSION` came from the caller. The refusal names the variable and happens before any Job is created.
4. **The cluster arm pushes to Docker Hub under the existing owner.** The reference is `docker.io/bborbe/discord-assistant:<VERSION>`. The owner comes from `SERVICE` alone; no second `bborbe/` prefix is added.
5. **The local arm keeps its tag.** The local recipe still tags `$(DOCKER_REGISTRY)/$(SERVICE):$(BRANCH)`, unchanged, including the empty-registry behaviour on a fresh clone.
6. **The cluster build works from a clone.** The Job clones `bborbe/ai-assistant` at the named ref, so the build sees committed state only. `npm ci` runs from the lockfile inside the image build, which needs no local preparation.
7. **The cluster-side prerequisites are provisioned by a copied script, not by this spec.** `hack/build-cluster-bootstrap.sh` creates the `build` namespace and the `buildkit-push` dockerconfigjson secret idempotently, resolving the credential from TeamVault at run time. The script is copied and available; this spec does not require it to be run, because both objects are assumed present.
8. **The documented build path matches reality.** The README shows both arms; the CHANGELOG records the change under `## Unreleased`.

## Constraints

- The local arm's command and its tag must not change.
- `SERVICE` already carries the owner prefix. Do not introduce `IMAGE ?= bborbe/$(SERVICE)`; the reference is `$(DOCKER_REGISTRY)/$(SERVICE)` with `DOCKER_REGISTRY=docker.io` on the cluster branch.
- The cluster branch must set `DOCKER_REGISTRY=docker.io` explicitly rather than relying on the variable's absence — an unset `DOCKER_REGISTRY` composes `/bborbe/discord-assistant`, which is a relative path, not a registry.
- The dispatch lives in `Makefile.docker`, beside the existing `build:` recipe, and declares `BUILD_TARGET ?= local` there — not in `Makefile.variables`. Both AC3 greps and the dry-run checks read that file.
- `.prettierignore` gains `hack/`. Without it, `make precommit`'s `prettier --write .` reformats the copied `build-job.yaml` (`singleQuote: true`), so the file silently diverges from its pinned source while the gate stays green.
- The runner's variable is `TAG`, not `VERSION`. The dispatch maps `TAG='$(VERSION)'`; do not edit the copied runner to rename it.
- The five `hack/` files are copied unmodified: `build-cluster.sh`, `cluster-alias.sh` and `build-job.yaml` from `agent-task-executor` at `d5604d8b69b23385aa92b6bfc4ebd9b274a50dea`; `build-cluster-bootstrap.sh` and `dockerconfig.json.tpl` from `go-skeleton` at `56f1a425e3eed205a199a57ffad976ca8afaef8b`. Read each with `git show <sha>:hack/<file>` from a clone of that repo — never resolve `origin/master` at build time, which would make the copy unreproducible. `agent-task-executor`'s Job template carries `automountServiceAccountToken: false`, which `go-skeleton`'s does not; that difference is why the split is three-and-two rather than all five from one repo.
- `REF` must be the full 40-character SHA. The runner derives `SOURCE_DATE_EPOCH` from the local repository and the Job's init container re-derives it from the cloned commit; a short SHA fails at the clone.
- `DOCKERFILE` is repository-root-relative even when the context moves; this repo's Dockerfile is at the root.
- The Job template already passes `DOCKER_REGISTRY=docker.io` as a build argument, so the Dockerfile's base images resolve from the public registry inside the cluster.
- Every value the runner substitutes must satisfy its character whitelist; no value may carry a newline.
- `dockerconfig.json.tpl` carries a TeamVault lookup key, not a credential. No secret is committed.
- No new scenario. The behaviour is reachable by checks on the rendered invocation plus one real cluster build.

## Assumptions

These must hold before the cluster AC can pass; none is created by this spec.

- The `build` namespace exists in the target cluster and a `buildkit-push` dockerconfigjson secret is present, **and that credential covers `docker.io`**. The copied bootstrap script can provision both, but only if its TeamVault lookup key resolves — that is the residual assumption. `50 Knowledge Base/Build on Kubernetes With BuildKit.md` § Prerequisites records that `BUILD_PUSH_SECRET` defaults to `buildkit-push`, a Docker Hub credential; the secret's `auths` key was not re-read live (the read was classifier-denied), so this remains a documented premise.
- The repo is public, so the Job's anonymous `git fetch` succeeds.
- `crane` is installed on the host running the operator-executable checks.
- `REF` exists both locally and on `origin`.
- `kubectl` is configured for the target cluster through the alias files `hack/cluster-alias.sh` resolves.

## Failure Modes

| Trigger                                                   | Expected behavior                                                                                 | Recovery                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `BUILD_TARGET` names an unknown cluster or context        | The runner fails before applying anything and lists the accepted values                           | Re-run with a listed target; no Job exists to clean up                                                         |
| `VERSION` omitted on the cluster arm                      | Refusal before the Job is created, naming `VERSION`                                               | Re-run passing `VERSION=<scratch-tag>`                                                                         |
| `REF` is not present in the local repository              | The runner dies resolving `SOURCE_DATE_EPOCH`                                                     | `git fetch`, then re-run with the full 40-character SHA                                                        |
| `REF` is a short SHA                                      | It resolves locally, then the Job's init container fails at the clone: `couldn't find remote ref` | Re-run with the full 40-character SHA                                                                          |
| `REF` exists locally but was never pushed                 | The clone init container fails: the ref does not exist on `origin`                                | Push the branch or commit, then re-run                                                                         |
| A Job with the derived name already exists in `build`     | The runner refuses and names the existing Job rather than overwriting it                          | Delete the finished Job, then re-run                                                                           |
| The push fails `401 Unauthorized`                         | The mounted secret is for a different registry                                                    | Check the secret's `auths` key against the pushed reference; the `auths` key must match exactly, port included |
| The build pod cannot reach the npm registry               | The Job fails; the runner prints the last 100 log lines and the Job name                          | Inspect the Job logs; the local arm is unaffected                                                              |
| The build pod is OOM-killed or throttled                  | The Job reports `failed`; the pod status carries `OOMKilled` or a throttling event                | Raise the template's limits in the same change, or build locally for that one image                            |
| A caller-supplied `VERSION` names an already-released tag | No guard — the push replaces that tag irreversibly                                                | Re-push the image from the released tag, then cut a new release                                                |
| The local arm regresses                                   | `make build` fails or tags differently                                                            | Revert the arm; the local path is the regression gate                                                          |

## Security / Abuse Cases

- The runner substitutes caller-supplied values into a manifest and into embedded shell, so every value is checked against a character whitelist and rejected for embedded newlines before rendering. Do not add a value path that bypasses that check.
- The repository URL and the push-secret name are literals in the dispatch, not configurable inputs: a configurable clone source on a build that mounts a push credential would let a caller point the credential-bearing Job at another repo.
- The build Job mounts a push credential from a `build`-namespace secret and runs with `automountServiceAccountToken: false`.
- The build container runs unprivileged with the sandbox profiles relaxed because rootless BuildKit requires it; that relaxation must not be copied to the clone init container.
- `VERSION` is caller-controlled and becomes an image tag and a Job name. The tag is whitelisted and the Job name is sanitized to a valid DNS name.

## Suggested Decomposition

| #   | Prompt focus                                                                                                                                                        | Covers DBs    | Covers ACs | Depends on                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------- | ---------------------------------------- |
| 1   | The five `hack/` files, copied unmodified from the two reference repos                                                                                              | 2, 6, 7       | 2, 3       | —                                        |
| 2   | The `Makefile.docker` dispatch: the `BUILD_TARGET` split, `DOCKER_REGISTRY=docker.io` on the cluster branch, the `VERSION` refusal, and the composed-reference echo | 1, 2, 3, 4, 5 | 1, 2, 4    | prompt 1 (the dispatch calls the runner) |
| 3   | Docs and release hygiene: the README build section and the `## Unreleased` CHANGELOG bullet                                                                         | 8             | 5          | —                                        |

Rationale: prompt 1 supplies the runner the dispatch calls; prompt 2 is the dispatch itself; prompt 3 is independent and touches no build logic. Prefer one prompt per row over a split whose rows carry hard inter-prompt preconditions.

## Do-Nothing Option

Leaving this repo without a cluster arm keeps one image tied to the Mac. It is the last `to-migrate` row of a 55-row target set, so the goal cannot close without it — and every rebuild while the operator is away from this machine needs a human at the keyboard.
