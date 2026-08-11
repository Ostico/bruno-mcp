# Contributing

Bug reports, reproductions and pull requests are all welcome. The project's reason to
exist is fidelity to Bruno's own file formats and honesty about what a run actually did,
so a report that shows *bytes* — what was written, what Bruno reads back — is worth more
here than most feature requests.

## Getting set up

```bash
npm ci
npm run build       # compile to dist/
npm test            # full suite
npm run test:unit   # unit only
npm run typecheck
npm run lint
```

**Use npm, never yarn.** The lockfile is npm's, CI runs `npm ci`, and a yarn-installed
tree makes `tsc` exhaust its heap.

## What CI checks

Five gates run on every pull request: the test suite on Node 22.x and on 24.x, the build,
a test-adequacy gate, and Test-Guard, which requires 95% line coverage of the `src/` lines
your diff changed. A green local run does not predict the last one, so expect to add tests
for every branch you introduce.

Two things worth knowing before you trust a local run:

- **Check the suite count, not just the failure count.** A broken build drops whole suites
  silently, and "0 failures" over 40 suites looks identical to "0 failures" over 199.
- **Tests are not type-checked.** `tsconfig.json` excludes `tests/`, and ts-jest runs with
  diagnostics off — so a type-only change has no test that can go red. Run
  `npm run typecheck` yourself.

## Commits

Conventional-commit subjects (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Write the body
for someone who will read it in a year with no memory of the discussion: what changed, and
why the alternative was worse. Do not add `Co-Authored-By` trailers.

## Sign your work — Developer Certificate of Origin

Every commit must carry a `Signed-off-by` line:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it from your git identity. It certifies that you wrote the patch or
otherwise have the right to submit it under this project's licence — the full text is the
[Developer Certificate of Origin 1.1](https://developercertificate.org/), which is short
and worth reading once.

Contributions are accepted under the project's [MIT licence](./LICENSE), the same terms
the project ships under. The sign-off exists so that provenance stays traceable: it is
what makes it possible to answer, years later, who contributed what and under which
terms.

## Reporting a security issue

Do not open a public issue for anything exploitable. Email the maintainer instead —
`domenico@translated.net` — and give it a reasonable window before disclosing.
