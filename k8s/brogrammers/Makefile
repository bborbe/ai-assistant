include ../../Makefile.variables

# Self-contained apply for the Brogrammers instance. Sources
# local.env.brogrammers (gitignored — see the repo root .gitignore for the
# local.env.* rule) and applies only this directory's manifests, so a `make
# apply` here can never touch the star-citizen namespace.
#
# `-maxdepth 1` is load-bearing: without it `find` descends into nothing here
# (all manifests are at this level), but the shared Makefile.k8s `apply`
# gained the same cap so `make -C k8s apply` (SC instance) does not descend
# INTO this directory and apply Brogrammers manifests into star-citizen.
.PHONY: apply
apply:
	@command -v teamvault-cli >/dev/null 2>&1 || { echo "teamvault-cli not on PATH" >&2; exit 1; }
	bash -c 'source ${ROOTDIR}/local.env.brogrammers && find . -maxdepth 1 -name "*.yaml" | while read -r file; do cat $${file} | teamvault-cli config parse | kubectl apply --context=$${CLUSTER_CONTEXT} -f -; done'
