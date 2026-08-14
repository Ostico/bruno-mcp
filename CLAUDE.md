## Git

Do not add Co-Authored-By trailers to commit messages.

# Memory-First Protocol
<!-- signet-first-version: 2.0.4 -->

These rules enforce memory-aware behavior for AI coding agents.
If `signet_memory_search` is available, use Signet as the primary memory system.
Otherwise, use your native memory capabilities (MEMORY.md, auto memory, etc.).

## Rules

1. **Search memory before running commands.** Before build/test/deploy/lint commands,
   search for the verified procedure. Use the stored version exactly.
   Skip for: single-line edits; commands the user gave you verbatim this turn.
   Preferred: `signet_memory_search(query, type, limit)`. Fallback: MEMORY.md or native recall.

2. **Search memory at session start.** Look for recent session summaries before touching files.
   Before searching explicitly, check whether memory context is already available in your session.
   If it covers recent summaries and project-relevant notes, skip the explicit search.
   Search explicitly for: continuation requests (daily-log by project scope), project-specific
   recall the available context lacks, or when no memory context is available at all.
   Skip for: self-contained tasks; memory context already covers the current project.

3. **Store conclusions BEFORE composing your answer.** After multi-step investigations, decisions,
   or debugging, store the synthesized conclusion in memory FIRST — before writing the user-facing
   response. Sequence: investigate → synthesize → store → answer. If you are writing a response
   that contains a novel conclusion and have not yet stored it, stop, store it, then continue.
   Search for duplicates first — update, don't duplicate.
   When the conclusion is a user-stated hard constraint or critical procedure, set
   `pinned: true` alongside `importance: 1.0` and tag `critical`.
   Skip for: trivial Q&A under 3 exchanges; single lookups with no novel finding.
   Preferred: `signet_memory_store(content, type, tags, importance, pinned)`. Fallback: native memory.

4. **Write a structured session handoff before ending non-trivial sessions.**
   Store a daily-log with: accomplishments, decisions made, unfinished work, blockers —
   task-oriented synthesis for the next session to resume without re-reading the transcript.
   Skip for: sessions with no investigation/decision/exploration; sessions under 3 exchanges.

5. **When memory returns no results, say so in one sentence and proceed.**
   `Memory returned no results for "<query>". Checking project files.`
   Memory gaps are normal. Do not retry with minor variations or distrust memory on subsequent searches.
   Then store the result so the gap fills over time.

6. **When memory conflicts with current code, trust the code.** Code is the artifact;
   memory is commentary. When they disagree, the artifact wins. Update or remove stale memory.
   Exception: if the memory records a `decision` or `rationale` type, flag the conflict
   to the user before updating — the code may have diverged intentionally.

7. **Use the correct memory type.** `procedural` for commands, `decision` for choices,
   `preference` for user habits. Do not default everything to `fact`.

---
<!-- Do not edit above this line -- managed by signet-first plugin -->
<!-- Add your project-specific rules below -->

## Build

Use **npm**, never yarn. `yarn.lock` is stale, and a yarn-installed tree makes `tsc` run out
of memory. CI is `npm ci`.

## Changelog entries

A pull request must not touch `CHANGELOG.md` at all. Every entry goes at the top of the same
`## [Unreleased]` section, so any two open branches conflict there by construction — and the
work of resolving that grows with the square of how many are open, for a file that changes
nothing about how the server behaves. Worse, each merge re-conflicts the branches whose
conflicts were already resolved.

Write the entry while you still understand the work, but write it to `.changelog-pending.md`
in the repository root instead. That file is uncommitted and stays that way: `.gitignore`
ignores everything matching `.*`. Head each block with the branch it came from, so an entry
can be checked against the code that landed. Nothing in CI reads the changelog —
`tests/unit/meta/source-archive.test.ts` only requires the file to ship — so a branch that
leaves it alone passes every gate.

If a branch already carries changelog edits when this is noticed, drop them:
`git checkout origin/main -- CHANGELOG.md`, prove it with
`git diff --quiet origin/main -- CHANGELOG.md`, and move the text to the pending file.

## Cutting a release

The tag is what publishes. `.github/workflows/release.yml` fires on a pushed `v*` tag and
runs `npm publish` with provenance plus a GitHub release; nothing about merging a PR
publishes anything. So a release is a normal PR followed by one tag push.

1. **Branch** `chore/release-X.Y.Z` off `origin/main`.
2. **Write the changelog.** Merge every block in `.changelog-pending.md` into
   `## [Unreleased]`, under the right `### Added` / `### Fixed` / `### Documentation`
   heading, then rename that section to `## [X.Y.Z] - YYYY-MM-DD` and empty the pending
   file. Order entries by what they mean to a caller — data loss first, then new
   capability, then corrections — not by the order the work landed. Do not rewrite the
   entries themselves: each was written by whoever understood that change. Check the
   pending file against `git log vPREVIOUS..origin/main --merges` and account for every
   merge, since nothing enforces that an entry was ever written.
3. **Bump the version in four places**, which must agree: `package.json`,
   `package-lock.json` (both via `npm version X.Y.Z --no-git-tag-version`), the literal
   in `src/server.ts` that the server reports to its client on connect, and both version
   fields in `server.json` (`.version` and `.packages[0].version`).
   `tests/unit/meta/version-matches-package.test.ts` and
   `tests/unit/meta/registry-manifest.test.ts` fail if either is forgotten.
4. **Verify before pushing**: `npx tsc --noEmit`, `npx eslint src/ --ext .ts`, `npx jest`,
   `npm run build`. Check the suite *count*, not just "0 failures" — a broken build drops
   whole suites silently.
5. **Open the PR** as a draft, with a body that says what ships and that merging publishes
   nothing. Wait for all six CI gates (test 22.x, test 24.x, build, Test adequacy gate,
   Test-Guard, GitGuardian Security Checks). Poll them with
   `gh pr checks` or `--json statusCheckRollup` reading `status`, not `state`: a check still
   running reports `state: null` and `conclusion: ""`, which a naive poll calls green. The
   user merges it; never merge or force-push.
6. **Tag main after the merge**, annotated and pointing at the merge commit — that is where
   `v2.0.0` and `v2.1.0` point:
   `git tag -a vX.Y.Z <merge-sha> -F <message-file>` then `git push origin vX.Y.Z`.
   The message is release notes, not a subject line.
7. **Watch the run**: `gh run list --workflow=release.yml`. It is only released when that
   run is green — npm publish and the GitHub release both happen there.

Tagging publishes to a public registry and cannot be undone, so do it only when the user
asks for that release by name.
