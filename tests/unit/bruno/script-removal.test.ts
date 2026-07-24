/**
 * Tests for script removal in both collection dialects.
 *
 * These run against the real parsers/generators — no mocks — because the point
 * is that a script written by inject* can actually be taken back out again.
 */

import { parse as parseYaml } from 'yaml';
import { injectYamlScript, removeYamlScript } from '../../../src/bruno/yaml-generator';
import { injectBruScript, removeBruScript } from '../../../src/bruno/bru-parser';
import { BrunoError } from '../../../src/bruno/types';

const YAML_BASE = 'info:\n  name: Get Order\nhttp:\n  method: GET\n  url: https://api.example.com/orders/1\n';
const BRU_BASE = 'meta {\n  name: Get Order\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://api.example.com/orders/1\n}\n';

type YamlScript = { type: string; code: string };

function scriptsOf(content: string): YamlScript[] {
  const parsed = parseYaml(content) as { runtime?: { scripts?: YamlScript[] } };
  return parsed.runtime?.scripts ?? [];
}

describe('removeYamlScript', () => {
  it('removes an after-response script and drops the empty containers', () => {
    const withScript = injectYamlScript(YAML_BASE, 'after-response', 'test("ok", function() {});', 'append');
    expect(scriptsOf(withScript)).toHaveLength(1);

    const removed = removeYamlScript(withScript, 'after-response');
    expect(scriptsOf(removed)).toHaveLength(0);
    // The now-empty runtime container is dropped rather than left as `scripts: []`
    expect(removed).not.toContain('runtime');
    // The request itself survives untouched
    expect(removed).toContain('name: Get Order');
    expect(removed).toContain('url: https://api.example.com/orders/1');
  });

  it('removes every block of the requested type, including duplicates', () => {
    let content = injectYamlScript(YAML_BASE, 'after-response', 'test("a", function() {});', 'append');
    content = injectYamlScript(content, 'after-response', 'test("b", function() {});', 'append');
    expect(scriptsOf(content)).toHaveLength(2);

    expect(scriptsOf(removeYamlScript(content, 'after-response'))).toHaveLength(0);
  });

  it('leaves scripts of other types in place', () => {
    let content = injectYamlScript(YAML_BASE, 'before-request', 'req.setHeader("X-A", "1");', 'append');
    content = injectYamlScript(content, 'after-response', 'test("ok", function() {});', 'append');

    const removed = removeYamlScript(content, 'after-response');
    const remaining = scriptsOf(removed);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].type).toBe('before-request');
    expect(remaining[0].code).toContain('X-A');
  });

  it('is a no-op when the file has no runtime block', () => {
    const removed = removeYamlScript(YAML_BASE, 'after-response');
    expect(scriptsOf(removed)).toHaveLength(0);
    expect(removed).toContain('name: Get Order');
  });

  it('is a no-op when runtime exists but scripts is not an array', () => {
    const content = `${YAML_BASE}runtime:\n  timeout: 5000\n`;
    const removed = removeYamlScript(content, 'after-response');
    expect(removed).toContain('timeout: 5000');
  });

  it('keeps a sibling runtime key when all scripts are removed', () => {
    const withScript = injectYamlScript(
      `${YAML_BASE}runtime:\n  timeout: 5000\n`,
      'after-response',
      'test("ok", function() {});',
      'append',
    );
    const removed = removeYamlScript(withScript, 'after-response');
    expect(removed).toContain('timeout: 5000');
    expect(scriptsOf(removed)).toHaveLength(0);
  });

  it('rejects an unsupported script type', () => {
    expect(() => removeYamlScript(YAML_BASE, 'tests' as 'after-response')).toThrow(BrunoError);
    expect(() => removeYamlScript(YAML_BASE, 'tests' as 'after-response')).toThrow(/Invalid script type/);
  });
});

describe('removeBruScript', () => {
  it('removes the tests block', () => {
    const withTests = injectBruScript(BRU_BASE, 'tests', 'test("ok", function() {});', 'replace');
    expect(withTests).toContain('tests {');

    const removed = removeBruScript(withTests, 'tests');
    expect(removed).not.toContain('tests {');
    expect(removed).toContain('name: Get Order');
  });

  it('removes the pre-request script and keeps post-response', () => {
    let content = injectBruScript(BRU_BASE, 'pre-request', 'req.setHeader("X-A", "1");', 'replace');
    content = injectBruScript(content, 'post-response', 'bru.setVar("id", 1);', 'replace');

    const removed = removeBruScript(content, 'pre-request');
    expect(removed).not.toContain('X-A');
    expect(removed).toContain('bru.setVar("id", 1)');
  });

  it('removes the post-response script and keeps pre-request', () => {
    let content = injectBruScript(BRU_BASE, 'pre-request', 'req.setHeader("X-A", "1");', 'replace');
    content = injectBruScript(content, 'post-response', 'bru.setVar("id", 1);', 'replace');

    const removed = removeBruScript(content, 'post-response');
    expect(removed).toContain('X-A');
    expect(removed).not.toContain('bru.setVar("id", 1)');
  });

  it('removes tests without disturbing pre-request', () => {
    let content = injectBruScript(BRU_BASE, 'pre-request', 'req.setHeader("X-A", "1");', 'replace');
    content = injectBruScript(content, 'tests', 'test("ok", function() {});', 'replace');

    const removed = removeBruScript(content, 'tests');
    expect(removed).toContain('X-A');
    expect(removed).not.toContain('tests {');
  });

  it('drops the empty script container when the last script goes away', () => {
    const content = injectBruScript(BRU_BASE, 'pre-request', 'req.setHeader("X-A", "1");', 'replace');
    expect(content).toContain('script:pre-request');

    const removed = removeBruScript(content, 'pre-request');
    expect(removed).not.toContain('script:pre-request');
    expect(removed).not.toContain('X-A');
    expect(removed).toContain('name: Get Order');
  });

  it('is a no-op when there is no script block at all', () => {
    const removed = removeBruScript(BRU_BASE, 'pre-request');
    expect(removed).toContain('name: Get Order');
  });

  it('is a no-op when the requested slot is already empty', () => {
    const content = injectBruScript(BRU_BASE, 'pre-request', 'req.setHeader("X-A", "1");', 'replace');
    const removed = removeBruScript(content, 'post-response');
    expect(removed).toContain('X-A');
  });

  it('rejects an unsupported script type', () => {
    expect(() => removeBruScript(BRU_BASE, 'after-response' as 'tests')).toThrow(BrunoError);
    expect(() => removeBruScript(BRU_BASE, 'after-response' as 'tests')).toThrow(/Invalid script type/);
  });

  it('reports a parse failure as a BrunoError', () => {
    expect(() => removeBruScript('meta {\n  name: broken\n', 'tests')).toThrow(BrunoError);
  });
});
