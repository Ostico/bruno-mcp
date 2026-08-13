# Execution groups and parallelism

`run_collection` executes a list of **groups**. A group is the unit of isolation and the
unit of configuration: it owns the state its requests share, and it carries the settings
that apply to them. Everything else about a run — what runs concurrently, what sees whose
cookies, which environment applies, how many times the same requests execute — follows from
how you cut the groups.

This document describes what a group is, what it owns, and exactly which of the two
`parallel` flags does what.

## Why groups rather than folders

Before groups, execution was derived from directory layout. One request path or one folder
could be selected, requests inside a folder ran in `seq` order, `parallel: true` fanned out
folders, and one `environment` applied to the whole run. That tied three unrelated things
to where files happen to live:

- **Selection was singular.** There was no way to name an arbitrary set of requests, and no
  way to name them in an order of your choosing.
- **The isolation boundary was an accident of layout.** A folder is a place files live.
  Using it as the unit of concurrency, of variable scope and of session scope meant the
  only way to change any of those was to move files on disk.
- **The same requests could not run twice under different inputs.** Running five requests as
  `alice` and the same five as `bob`, concurrently and without leakage, was not expressible.
  Neither was running them against `dev` and `staging` in one call.

Groups make the boundary something you declare in the call rather than something you build
on disk. `seq` still orders requests discovered inside a directory; it no longer constrains
what may run at the same time as what.

## The model

**A run** is an ordered list of groups plus a run-level `parallel` flag that fans them out.
Run-level `environment` and `variables` act as defaults that groups may override.

**A group** has an ordered list of request references, optionally its own `environment`, its
own `variables`, its own `parallel` flag, its own data rows, and a `name`.

**A request** is a `.bru` or `.yml` file, named by a path relative to the collection.

### What a group owns

For its lifetime, a group owns:

- one variable store — everything `bru.setVar` writes, and every value captured from a
  response,
- one cookie jar, when cookies are enabled for the run,
- one OAuth2 access-token cache.

**Nothing crosses a group boundary.** Not variables, not cookies, not captured values, not
tokens. That is what makes `alice` and `bob` safe in one call, and what lets `dev` and
`staging` run in one call without either seeing the other's session.

Within a group, requests share all three. This is deliberate: the login-then-use chain is
the reason a group exists at all. A login writes the token into the group's store, and the
requests after it read it.

## The two `parallel` flags

There are two, they are independent, and neither reads the other.

| Flag | Where | Default | What it fans out |
| --- | --- | --- | --- |
| `parallel` | on the run | `false` | the **groups** — several groups execute at once |
| `parallel` | on a group | `false` | that **group's requests** — its requests execute at once |

A group's `parallel` never inherits the run's. A run with `parallel: true` and three groups
that say nothing runs three groups concurrently, each executing its own requests strictly in
listed order. To get concurrency inside a group, set it on that group.

```json
{
  "parallel": true,
  "groups": [
    { "name": "alice", "requests": ["login.bru", "profile.bru"] },
    { "name": "bob",   "requests": ["login.bru", "profile.bru"] }
  ]
}
```

Two groups at once; within each, `login.bru` finishes before `profile.bru` starts.

```json
{
  "groups": [
    { "name": "smoke", "requests": ["a.bru", "b.bru", "c.bru"], "parallel": true }
  ]
}
```

One group, three requests at once — and all three sharing one store and one jar, which is
the arrangement in which a `setVar` race is reproducible.

### When you pass no groups

`requests` and `groups` are mutually exclusive: passing both is an error rather than a
precedence rule, because they express two different intentions and there is no correct way
to pick one for you.

Passing neither — or passing `requests` — makes the run a single implicit group built from
`requests` and the run-level `parallel`. In that shape only, run-level `parallel: true`
means *the requests* run concurrently, because the requests are the group. This is the
pre-groups behaviour, and it is why a caller who never uses groups sees nothing change.

An omitted `requests` list means the whole collection. A list that is present and empty is
not the same thing: you said which requests you wanted and the answer was none of them, so
the group reports a warning rather than quietly running everything.

## Order within a group

A group's requests run in the order they are listed. A reference to a directory expands in
place, ordered by `seq` scoped to that folder, subfolders before that directory's own loose
requests, ties broken by filename. So a group may mix explicit ordering with directory
expansion and still be deterministic.

Duplicates are allowed. Naming the same request twice runs it twice — which is how you get
several concurrent copies of one request contending over one store.

## Environment and variables

Precedence, weakest first:

1. the run's `environment` and `variables`,
2. the group's `environment` (replacing the run's) and `variables` (merged over the run's),
3. a data row's columns (see below), which win over both.

A group's `environment` replaces rather than merges, because an environment is a named set
that only makes sense whole. Its `variables` merge key by key over the run's, so a group can
override one value without restating the rest.

## Iterations: data rows expand into groups

`data` (rows inline) and `dataFile` (a CSV inside the collection, whose first line names the
columns) turn one group into one group per row. Each expanded group is a full group — its
own store, jar and token cache — and carries an `iterationIndex` in the result so rows stay
distinguishable.

Rows may be given on the run or on a group, and `data` and `dataFile` are mutually
exclusive at each level. A group that has its own rows uses them *instead of* the run's, not
in addition: the caller who wrote rows on one group was describing that group, and appending
the run's rows underneath would run iterations nobody asked for.

A row's columns go in as authored variables, which means a cell holding `{{host}}` resolves
exactly as the same value written into `variables` by hand would. At most 1000 rows are
accepted per scope — every row runs every request in the group, so a spreadsheet passed by
mistake is an outbound request storm; slice the file and run it in parts.

Rows are independent: a row that fails does not stop the rows after it. Rows read from a
`dataFile` are not echoed back in the result, because a column named `password` is file
content this server will not copy into a transcript. An iteration is identified by its
`iterationIndex`, counting from 0 in file order.

Because expansion happens before execution, run-level `parallel: true` fans out the
iterations. Fifty rows with `parallel: true` is fifty concurrent sessions, subject to the
ceiling below.

## The concurrency ceiling

`maxConcurrency` bounds how many **sandboxed script executions** may run at once — the
forked children that evaluate pre-request scripts, post-response scripts and tests. It does
not cap HTTP sockets; that is what the two `parallel` flags govern.

Left unset, it is derived from the machine:

```
max(1, floor(0.9 × min(cores × 2, totalMemory / 64MB)))
```

Container limits are read where they are exposed, so a cgroup-constrained CPU or memory
quota is respected rather than the host's figures. The memory term uses total memory, not
free memory, so the ceiling is a property of the machine and does not drift with whatever
else happens to be running at the moment the run starts.

`maxConcurrency: 0` means unbounded, at the caller's risk. A large fan-out with unbounded
sandboxing is how a run exhausts the machine.

The practical consequence is worth spelling out: requests that run scripts need a sandbox
slot each, so a ceiling below the width of your fan-out serialises them — quietly, since
nothing about the result says the cap was the reason. When you are reproducing a race
between scripted requests, give `maxConcurrency` at least as many slots as you have racers.

### Concurrency across separate calls

Everything above is about one call. Simultaneity *between* calls is not something this
server promises: two `run_collection` calls issued together may overlap, or may serialise,
and nothing in either result says which happened. Runs that were meant to be simultaneous
have been observed starting more than twenty seconds apart, each passing its own
assertions — the kind of failure that leaves a green suite proving nothing.

So a test that depends on two things happening at once must be **one call** with a parallel
group, where the ordering is part of the contract. Reach for several concurrent calls only
when you do not care which order they run in.

## Failure semantics

The boundary that isolates state also isolates failure.

- **A request that fails is a request result.** A non-2xx status, a connection error or a
  failing test is recorded on that request and the group continues (or, in a parallel group,
  never noticed).
- **A group can fail as a whole.** A reference that cannot be resolved, or an error raised
  while resolving membership, sets `error` on that group. It means a failure that preceded
  every request in the group, so the group reports no request results — and only that group
  is affected. A bad path in one group does not stop the others from reporting what they
  would have done.
- **References that resolve to nothing are named.** Each unresolvable reference is listed in
  the group's `missingRequests`, rather than collapsed into a count.
- **One crashed group cannot hide the rest.** Groups are settled individually, so a group
  that throws is reported in its own slot with its error, and every other group's results
  come back intact. This holds whether the groups ran concurrently or in order. A crashed
  group also counts as one failure in the run summary: it ran no requests, so it contributes
  nothing to the per-request tally, and without that adjustment a run with a dead group
  would read as fully green.
- **A parse failure means different things for a discovered file and a named one.** A file
  found by running the whole collection or by expanding a directory is skipped: it is
  counted in `parseErrors` and named with its reason in `parseFailures`, and the rest of the
  group runs. A file you named yourself fails the group that named it, reported as that
  group's `error` — you asked for that specific request and there is no partial answer to
  it. The other groups still run either way.

## Reading the result

The result is group-shaped. There is no flat top-level list of request results — flattening
would make every caller branch on whether they had passed groups:

```
{
  summary:  { … totals across every group … },
  groups: [
    {
      name?, index, summary, results: [ … per request … ],
      capturedVariableNames?, capturedVariables?, warnings?,
      iterationIndex?, missingRequests?, error?
    }
  ],
  parseErrors?, parseFailures?, warnings?
}
```

`index` is the group's position in the executed plan, which equals its position in your list
until a group expands into iterations and differs after. Iterations of one group share that
group's `name` and are told apart by `index` and `iterationIndex`. Captured variables are
per group, for the same reason the store is.

## Recipes

**Two identities, concurrently, no leakage.** Each group logs in separately and holds its
own token and cookies:

```json
{
  "parallel": true,
  "groups": [
    { "name": "alice", "requests": ["auth/login.bru", "orders/list.bru"],
      "variables": { "user": "alice" } },
    { "name": "bob", "requests": ["auth/login.bru", "orders/list.bru"],
      "variables": { "user": "bob" } }
  ]
}
```

**The same suite against two environments in one call:**

```json
{
  "parallel": true,
  "groups": [
    { "name": "dev", "requests": ["smoke"], "environment": "dev" },
    { "name": "staging", "requests": ["smoke"], "environment": "staging" }
  ]
}
```

**Login, then use the session.** One group, serial, which is the default:

```json
{
  "groups": [
    { "name": "session",
      "requests": ["auth/login.bru", "orders/list.bru", "orders/get.bru"] }
  ]
}
```

There is no serial-prefix-then-concurrent-suffix inside one group: `parallel` applies to the
whole group. Splitting the login into its own group does not help either, because the token
would not cross the boundary — that is the boundary working as designed. A burst that shares
one already-established session is therefore expressed by having the collection's own
pre-request script authenticate, not by ordering requests.

**Reproduce a credential race.** Requests in one group share a store, a jar and a token
cache, so concurrent requests inside a single group genuinely contend over one token — which
is what makes a token-renewal race reachable from a run:

```json
{
  "groups": [
    { "name": "renewal", "requests": ["auth/whoami.bru", "auth/whoami.bru", "auth/whoami.bru"],
      "parallel": true }
  ]
}
```

**Fifty accounts, from a CSV.** One group per row, all fifty concurrent:

```json
{
  "parallel": true,
  "groups": [
    { "name": "accounts", "requests": ["auth/login.bru", "profile.bru"],
      "dataFile": "data/accounts.csv" }
  ]
}
```
