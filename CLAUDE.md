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
