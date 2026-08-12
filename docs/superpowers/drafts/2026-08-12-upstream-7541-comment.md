# Draft comment for `usebruno/bruno#7541`

Not posted. Written 2026-08-12 against issue #7541 ("Official execution lifecycle /
programmatic runner capability for Bruno CLI integrations"), state OPEN, labels
`enhancement`, `triage-pending`, `module-cli`.

The issue asks for one of two things: a programmatic `runCollection(options, { onEvent })`
or an official lifecycle contract around `bru run`. What it does not have is evidence
from anyone who tried the subprocess route and priced it. We are that evidence: we
maintain a third-party MCP server for Bruno collections, we evaluated delegating
execution to `bru run`, and we refused — so we can name what the contract would have to
expose for us to switch. That is worth more to this thread than another vote.

Post only after deciding it is wanted. Upstream announced its own MCP server on
2026-08-11, so a comment from us reads as an interested party; the disclosure below is
not optional.

---

## The comment

Disclosure: I maintain [bruno-mcp-studio](https://github.com/Ostico/bruno-mcp-studio), a
third-party MCP server that reads, writes and runs Bruno collections. It has its own
runner rather than delegating to `bru run`. That was a deliberate decision, and since
this issue is asking what an integration contract would need to cover, the reasons may be
more useful here than as an opinion.

We looked hard at shelling out. `bru run` already accepts an ordered list of paths in one
process and writes a JSON report, which covers more than people assume — it is not the
naive one-request-per-invocation shape. Four things stopped us, and each one is a concrete
requirement for the contract this issue proposes rather than a preference:

**1. Secrets would have to leave memory.** We hold resolved credentials in process and
never write them anywhere. A subprocess boundary puts them in `argv`, an environment
block, or a file the child reads — all three are readable by other processes on the same
host, and a JSON report is a file on disk by definition. A programmatic entry point is the
only shape where a secret stays in one address space. If the answer here is Option B (a
lifecycle around `bru run`), this is the part that cannot be solved by more hooks.

**2. Events during the run, not a report after it.** The `onEvent` sketch in Option A is
the important half. We need to act between requests, not merely observe afterwards:
refresh an OAuth2 token that expired mid-run, apply a captured variable to the next
request, decide what a failure means for the rest of the group. A report parsed at exit
cannot express any of that. If a lifecycle contract emits only start and end, it does not
replace a runner.

**3. Concurrency inside a single run.** We execute a run as a set of groups, each owning
its own variable store, cookie jar and OAuth2 token cache, and groups may run in parallel
while requests inside a group stay ordered. Two identities differing only in a password
therefore authenticate separately instead of one silently reusing the other's token. One
`bru run` process with one path list has one of each of those, so this structure has
nowhere to live behind the CLI boundary. A programmatic API would need the isolation unit
to be a parameter, not an implicit global.

**4. Assertions need the wire, not the summary.** We assert against things a report
flattens away: duplicate response headers, which vanish the moment they pass through a
`headers` object and are only visible in `rawHeaders`; the WebSocket upgrade's 101 and its
negotiated subprotocol; a gRPC response body as parsed data rather than as display text.
A report is a summary of a run, and summarising is exactly what loses these.

None of this argues against the CLI — for CI, `bru run` plus a JUnit file is the right
tool and we emit the same artifacts for that reason. It argues that the gap this issue
names is real and that Option A is the shape that closes it. Option B would help wrappers
that today spawn a child and scrape stdout, which is a genuine improvement, but it leaves
every integration that needs in-memory credentials or mid-run control exactly where it is.

If it is useful, I am happy to write up the four points above as a checklist against a
concrete API proposal, or to say which of them we would drop first if the API only covered
some.

---

## Notes for whoever posts this

- Say nothing about upstream's own MCP server. Comparing products in a CLI issue turns a
  technical contribution into a territorial one.
- Do not link the npm package. The repository link is the disclosure; the package link is
  marketing.
- If a maintainer replies with a concrete API sketch, the follow-up offer at the end is
  the real value — take it up rather than restating these four points.
