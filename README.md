# CI Investigator

An AI agent investigates a failed CI run, cites the evidence for its diagnosis,
and proposes a patch — but the **backend** decides whether any of it is true.
Citations are checked against the real log and the real files, and a patch is
only called verified when the project's own tests pass in a sandbox. The model
never gets to set that flag.

Status: Phase 1 of 5. The repository skeleton and the eight failing fixtures are
in place. `npm run fixtures:check` proves each fixture fails in the specific way
it is supposed to.

## Get set up

```bash
npm run setup           # install backend + frontend, then generate fixtures
npm run check:all       # run every check and print PASS/FAIL
```

See [fixtures/README.md](fixtures/README.md) for what the fixtures are and how to
run one by hand. Full setup, testing and architecture documentation land in
Phase 5.