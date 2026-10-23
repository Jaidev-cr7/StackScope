# Fixtures

Eight tiny Node projects, each with one deterministic failure. They stand in for
"a CI run that just went red": the app points the investigator at a fixture,
captures its test output as the CI log, and asks the agent to explain and fix it.

## Layout

```
fixtures/
  definitions/      the source of truth: one small JS module per fixture
  scripts/          seed.js materialises them, check.js proves they still fail
  repos/            generated output, git-ignored
  expected.json     hand-written ground truth, read by check.js and eval only
```

A fixture lives in `definitions/<id>.js` as a plain object mapping relative file
paths to file contents. That keeps the whole project in one readable file per
fixture instead of a tree of tiny files, and makes it easy to see a fixture's
whole world at once.

## Regenerate and check

```bash
npm run seed            # write fixtures/repos/<id>/
npm run fixtures:check  # every fixture must fail, with its expected signature
```

`fixtures:check` is the guard against a silent regression: if a fixture ever
starts passing, or fails for a different reason than we wrote down in
`expected.json`, it reports FAIL and prints the output.

## Run one fixture by hand

Each fixture is a standalone project using only Node's built-in test runner, so
you can look at any failure yourself:

```bash
cd fixtures/repos/01-logic-bug
node --test --test-reporter=spec
```

`--test-reporter=spec` is deliberate. The default TAP output is long and noisy;
`spec` prints a short failing-tests block with paths relative to the fixture root
and the offending source line, which is what the failure-signature parser reads
and what the agent is shown.

## The eight failures

| id | failure | Node error |
|----|---------|-----------|
| 01-logic-bug | source ignores a field the test relies on | `AssertionError` |
| 02-missing-dependency | imports a package that is not installed | `Error [ERR_MODULE_NOT_FOUND]` |
| 03-syntax-error | a function body is never closed | `SyntaxError`, no stack frame |
| 04-undefined-variable | references an identifier that was never declared | `ReferenceError` |
| 05-missing-config-key | reads a config section that is not in the file | `TypeError` |
| 06-broken-import | imports an export that a rename removed | `SyntaxError` on the link step |
| 07-wrong-test-expectation | the assertion is stale, the source is right | `AssertionError` |
| 08-undiagnosable | depends on a service that is not in the sandbox | `TypeError: fetch failed` / `ECONNREFUSED` |

Two of these are deliberately awkward, because a diagnosis tool that only works
on easy cases is not a diagnosis tool:

- **05** points its stack frame at `src/server.js`, but the file that must
  change is `config.json`. Root cause and stack frame are different things.
- **08** has no culprit at all. Every frame is a Node internal or the correct
  call site, and no edit to the repository can make it pass. The honest answer
  is `INCONCLUSIVE`, and the system is built to allow that answer.

## expected.json

`expected.json` records, per fixture, the error signature that must appear, the
file a correct patch has to change, the root cause in plain language, and the
status the investigation should reach. It is written by reading the fixture
source, never from watching the agent. The agent never reads this file, and the
sandbox does not either.