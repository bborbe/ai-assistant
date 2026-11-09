# Definition of Done

A prompt is complete when ALL of the following are true:

## Build

- [ ] `make precommit` passes (install + format + test + lint + audit + trivy)
- [ ] No new linting warnings or errors

## Code Quality

- [ ] Follows existing code patterns in the file being modified
- [ ] No secrets or tokens committed — values are resolved at run time

## Tests

- [ ] New behaviour has a test
- [ ] Existing tests still pass (`node --test` and the shim's Python tests)

## Style

- [ ] Prettier formatting applied
- [ ] No absolute paths — all paths relative or resolved from the environment
