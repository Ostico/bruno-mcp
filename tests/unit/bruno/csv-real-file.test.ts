/**
 * The CSV reader against a file nobody wrote for it.
 *
 * `tests/fixtures/csv/terragene-multilingual-glossary.csv` is a real
 * translation glossary, committed byte for byte as it was exported: 46 columns
 * over 14 languages, CRLF line endings, quoted fields containing commas, a
 * doubled quote inside a quoted field, a non-breaking space inside a value,
 * Cyrillic and `™`, and 30 empty cells in its first data row alone. It is the
 * shape of a CSV a person actually has lying around, as opposed to one written
 * to exercise a parser.
 *
 * Every expectation below was taken from Python's `csv` module reading the same
 * file — an implementation with no shared ancestry with this one. Before these
 * tests were written the two were compared cell for cell across all 1,748 data
 * cells and agreed on every one; what is committed here is the subset worth
 * reading, since committing the other implementation's output as a fixture
 * would only test that two copies of the same data match.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsvRows } from '../../../src/bruno/csv-parser';

const FIXTURE = join('tests', 'fixtures', 'csv', 'terragene-multilingual-glossary.csv');

const realFile = (): string => readFileSync(FIXTURE, 'utf8');

/**
 * The file with its repeated column names made distinct — the repair the
 * duplicate-name error asks the caller for, applied to the header line only.
 *
 * Written out here rather than hidden in a helper module because it is half the
 * point of the first test: the file as exported cannot be a data file, and this
 * is exactly how little has to change for it to become one.
 */
function withDistinctHeaders(text: string): string {
  const seen = new Map<string, number>();
  const [header, ...rest] = text.split('\r\n');
  const distinct = header.split(',').map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} ${count}`;
  });

  return [distinct.join(','), ...rest].join('\r\n');
}

describe('a real exported CSV', () => {
  it('is refused as exported, because 14 of its columns share a name', () => {
    // The finding this fixture exists for: a genuine export repeats a name once
    // per language group, so the refusal fires on the first real file it met.
    // Reporting "twice" here would have sent the reader looking for one stray
    // column out of 46.
    expect(() => parseCsvRows(realFile())).toThrow(
      /Line 1: the header row uses the name "Notes" for 14 columns \(6, 9, 12, …\)/,
    );
  });

  it('reads once its column names are distinct', () => {
    const { headers, rows } = parseCsvRows(withDistinctHeaders(realFile()));

    expect(headers).toHaveLength(46);
    expect(rows).toHaveLength(38);
  });

  it('splits on a comma inside a quoted value the way the exporter meant', () => {
    const { rows } = parseCsvRows(withDistinctHeaders(realFile()));

    expect(rows[0]['fi-FI']).toBe('BIOTRACE™ Auto Read 20, biologinen höyryindikaattori  (73100)');
  });

  it('reads a doubled quote inside a quoted value as one literal quote', () => {
    const { rows } = parseCsvRows(withDistinctHeaders(realFile()));

    // Written in the file as """THIS SIDE UP"" (para BD125X/1)".
    expect(rows[32]['en-GB']).toBe('"THIS SIDE UP" (para BD125X/1)');
  });

  it('leaves no CR in any value, though every line in the file ends with one', () => {
    const { rows } = parseCsvRows(withDistinctHeaders(realFile()));

    const withCarriageReturn = rows.flatMap((row) => Object.values(row)).filter((value) => value.includes('\r'));
    expect(withCarriageReturn).toEqual([]);
  });

  it('keeps a non-breaking space that a trim would have eaten', () => {
    const { rows } = parseCsvRows(withDistinctHeaders(realFile()));

    // U+00A0, mid-value, in the French cell. `String.prototype.trim` counts it
    // as whitespace, which is one reason values are never trimmed.
    expect(rows[0]['fr-FR']).toContain('automatique\u00A020');
  });

  it('keeps every empty cell rather than collapsing the row', () => {
    const { headers, rows } = parseCsvRows(withDistinctHeaders(realFile()));
    const first = rows[0];

    expect(Object.keys(first)).toHaveLength(46);
    expect(headers.filter((name) => first[name] === '')).toHaveLength(30);
  });

  it('carries scripts and symbols through untouched', () => {
    const { rows } = parseCsvRows(withDistinctHeaders(realFile()));

    expect(rows[0]['ru-RU']).toContain('Биологический индикатор');
    expect(rows[0]['en-GB']).toBe('BIOTRACE™ Auto Read 20 Steam Biological Indicator  (73100)');
  });
});
