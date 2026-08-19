/**
 * What counts as the model having understood the surface.
 *
 * Grading is behavioural: the bytes the server wrote, or — for the tools that
 * write nothing — the arguments the model actually passed. A grader that read
 * the model's prose would be measuring how well it describes what it did.
 *
 * The three failure classes are never collapsed. "Zero tool errors" is the
 * property the measured session actually demonstrated, and it is evidence about
 * class 1 alone: a call that succeeded while writing the wrong thing (class 2)
 * is invisible to it, and so is a model that quietly did something else
 * (class 3). Task 6 needs to know which of the three it caused.
 */

import { promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const CLASS = {
  PASS: 'pass',
  TOOL_ERROR: 'class-1-tool-error',
  SILENT_WRONG: 'class-2-silent-wrong',
  AVOIDANCE: 'class-3-avoidance',
};

/** Every file under `root`, relative and lower-cased for comparison. */
async function walk(root) {
  const found = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else found.push(full);
    }
  }
  await visit(root);
  return found;
}

/**
 * Locate the file a task expects, by relative path or by basename.
 *
 * Matched case-insensitively and by suffix, because the writer lower-cases a
 * request's filename and a task should not have to restate that: the fact under
 * test is what the file contains, not whether the caller could predict its
 * name. On macOS the two spellings are the same file anyway, so a case-exact
 * match would pass here and fail on Linux.
 */
export async function findFile(root, wanted) {
  const files = await walk(root);
  const target = wanted.toLowerCase().split('/').join(sep);
  const exact = files.find((file) => relative(root, file).toLowerCase() === target);
  if (exact) return exact;
  return files.find((file) => relative(root, file).toLowerCase().endsWith(target));
}

/** True when every key in `expected` appears in `actual` with the same value. */
export function deepSubset(actual, expected, path = '') {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return { ok: false, at: path || 'root', why: 'not an array' };
    if (actual.length < expected.length) {
      return { ok: false, at: path || 'root', why: `${actual.length} items, expected ${expected.length}` };
    }
    for (const [index, item] of expected.entries()) {
      const inner = deepSubset(actual[index], item, `${path}[${index}]`);
      if (!inner.ok) return inner;
    }
    return { ok: true };
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') {
      return { ok: false, at: path || 'root', why: 'not an object' };
    }
    for (const [key, value] of Object.entries(expected)) {
      const inner = deepSubset(actual[key], value, path ? `${path}.${key}` : key);
      if (!inner.ok) return inner;
    }
    return { ok: true };
  }
  // A "re:" prefix compares by pattern. Some values are equally correct in more
  // than one spelling — a request can be named by a path relative to the
  // collection or by an absolute one, and both run the same request — so an
  // exact match would fail a trial for a choice the surface leaves open.
  if (typeof expected === 'string' && expected.startsWith('re:')) {
    if (typeof actual !== 'string' || !new RegExp(expected.slice(3)).test(actual)) {
      return { ok: false, at: path || 'root', why: `got ${JSON.stringify(actual)}, expected to match ${expected.slice(3)}` };
    }
    return { ok: true };
  }
  if (actual !== expected) {
    return { ok: false, at: path || 'root', why: `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}` };
  }
  return { ok: true };
}

/**
 * Grade one trial.
 *
 * `calls` are the tool_use blocks in order; `toolErrors` the tool_result blocks
 * that came back as errors. `root` is the trial's working directory — the only
 * place a trial is allowed to have written anything.
 */
export async function gradeTrial(task, { calls, toolErrors, root }) {
  const expect = task.expect ?? {};
  const named = expect.tool ? calls.filter((call) => call.name.endsWith(expect.tool)) : calls;

  // Class 1 first, and reported even when the end state is right: the property
  // the reference measured is a session with no tool errors at all, and a call
  // that failed and was then retried successfully still spent a round trip on a
  // description the caller had misread.
  if (toolErrors.length > 0) {
    return {
      klass: CLASS.TOOL_ERROR,
      diagnosis: `${toolErrors.length} tool error(s); first: ${toolErrors[0].slice(0, 400)}`,
      recovered: named.length > 0,
    };
  }

  if (expect.tool && named.length === 0) {
    return {
      klass: CLASS.AVOIDANCE,
      diagnosis: `${expect.tool} was never called; calls: ${calls.map((c) => c.name).join(', ') || 'none'}`,
    };
  }

  if (expect.toolNotCalled) {
    // The shape a "this cannot be done" fact needs: the task offers the model
    // the option of saying so, and doing it anyway is the failure. Grading the
    // written bytes could not tell the two apart, because a refusal and a wrong
    // attempt both leave no correct file behind.
    const forbidden = calls.filter((call) => call.name.endsWith(expect.toolNotCalled));
    if (forbidden.length > 0) {
      return {
        klass: CLASS.SILENT_WRONG,
        diagnosis: `${expect.toolNotCalled} was called ${forbidden.length} time(s) for something this server cannot express`,
        field: expect.toolNotCalled,
      };
    }
  }

  for (const wanted of expect.absent ?? []) {
    const found = await findFile(root, wanted);
    if (found) {
      return {
        klass: CLASS.SILENT_WRONG,
        diagnosis: `${wanted} is still on disk`,
        field: wanted,
      };
    }
  }

  if (expect.maxCalls && named.length > expect.maxCalls) {
    // A field that takes a list is only a saving if the caller reaches for the
    // list. Spending one call per item reaches the same end state and costs
    // what the batch field exists to avoid, so the file check further down
    // would call it a pass.
    return {
      klass: CLASS.SILENT_WRONG,
      diagnosis: `${expect.tool} called ${named.length} times where ${expect.maxCalls} would do`,
      field: 'maxCalls',
    };
  }

  for (const [key, wanted] of [['resultContains', true], ['resultNotContains', false]]) {
    for (const needle of expect[key] ?? []) {
      const present = named.some((call) => (call.result ?? '').includes(needle));
      if (present !== wanted) {
        // What the call reported back, not what it was asked. A run can be
        // accepted, execute nothing and still answer; only its own report says so.
        return {
          klass: CLASS.SILENT_WRONG,
          diagnosis: wanted
            ? `no result of ${expect.tool} mentioned ${JSON.stringify(needle)}`
            : `a result of ${expect.tool} mentioned ${JSON.stringify(needle)}`,
          needle,
        };
      }
    }
  }

  if (expect.argsInclude) {
    // Any one of the calls to that tool may be the one that satisfies it: a
    // model that fixes its own first attempt has still understood the field.
    const failures = named.map((call) => deepSubset(call.input, expect.argsInclude));
    if (!failures.some((result) => result.ok)) {
      const first = failures[0] ?? { at: 'root', why: 'no call' };
      return {
        klass: CLASS.SILENT_WRONG,
        diagnosis: `arguments wrong at ${first.at}: ${first.why}`,
        field: first.at,
      };
    }
  }

  if (expect.file) {
    const file = await findFile(root, expect.file);
    if (!file) {
      return {
        klass: CLASS.SILENT_WRONG,
        diagnosis: `no file matching "${expect.file}" was written`,
        field: expect.file,
      };
    }
    const text = await fs.readFile(file, 'utf8');
    for (const needle of expect.contains ?? []) {
      if (!text.includes(needle)) {
        return {
          klass: CLASS.SILENT_WRONG,
          diagnosis: `written file is missing ${JSON.stringify(needle)}`,
          field: needle,
        };
      }
    }
    for (const needle of expect.notContains ?? []) {
      if (text.includes(needle)) {
        return {
          klass: CLASS.SILENT_WRONG,
          diagnosis: `written file contains ${JSON.stringify(needle)}, which it must not`,
          field: needle,
        };
      }
    }
  }

  // A task may forbid a string anywhere under the trial root — the shape a
  // "never write this into a file" fact needs, since the wrong file is the
  // point and naming it in advance would give the answer away.
  for (const needle of expect.notInAnyFile ?? []) {
    const files = await walk(root);
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      if (text.includes(needle)) {
        return {
          klass: CLASS.SILENT_WRONG,
          diagnosis: `${relative(root, file)} contains ${JSON.stringify(needle)}, which must never be written to a file`,
          field: needle,
        };
      }
    }
  }

  return { klass: CLASS.PASS, diagnosis: '' };
}
