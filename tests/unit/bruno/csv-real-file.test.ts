/**
 * The CSV reader against a file it was not written for.
 *
 * `tests/fixtures/csv/multilingual-glossary.csv` began as a real translation
 * glossary exported from a translation tool. Its words are not the original
 * ones: every letter and digit was substituted for another from the same
 * Unicode block, so nothing identifying survives — no product, no company, no
 * catalogue number. Read it and it is nonsense.
 *
 * Everything the parser can see, though, is the export's own and was not chosen
 * by anybody here: 46 columns over fourteen languages with `Notes` and
 * `Example of use` repeated once per language, CRLF endings and no final
 * newline, quoted fields containing commas, a doubled quote inside a quoted
 * field, a non-breaking space inside a value, Cyrillic alongside Latin, a
 * trademark sign, and 30 empty cells in the first data row. The substitution
 * touches letters and digits only, so it cannot move a comma, add or remove a
 * quote, or change a line ending — the file is still 11,218 bytes with 38 CRLFs,
 * exactly as it was exported.
 *
 * Every expectation below was taken from Python's `csv` module reading the same
 * bytes — an implementation with no shared ancestry with this one. The two were
 * compared cell for cell across all 1,748 data cells and agreed on every one,
 * before and after the substitution; what is committed here is the subset worth
 * reading, since committing the other implementation's output as a fixture would
 * only test that two copies of the same data match.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsvRows } from '../../../src/bruno/csv-parser';

const FIXTURE = join('tests', 'fixtures', 'csv', 'multilingual-glossary.csv');

const fixtureText = (): string => readFileSync(FIXTURE, 'utf8');

/**
 * The file with its repeated column names made distinct — the repair the
 * duplicate-name error asks the caller for, applied to the header line only.
 *
 * Written out here rather than hidden in a helper module because it is half the
 * point of the second test: the file as exported cannot be a data file, and this
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
  it('still has the CRLF line endings it was exported with', () => {
    // First, because it is the assumption every other test here rests on, and
    // because it is not git's default: without `-text` in .gitattributes git
    // normalises these CRLFs away on commit and the tests below fail in CI with
    // seven confusing messages instead of this one. The `.gitignore` in this
    // repo ignores all dotfiles, so `.gitattributes` also needs un-ignoring —
    // an ignored one is not an error, it simply never takes effect.
    const text = fixtureText();

    expect(text.split('\r\n')).toHaveLength(39);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('is refused as exported, because 14 of its columns share a name', () => {
    // The finding this fixture exists for: a genuine export repeats a name once
    // per language group, so the refusal fires on the first real file it met.
    // Reporting "twice" here would have sent the reader looking for one stray
    // column out of 46.
    expect(() => parseCsvRows(fixtureText())).toThrow(
      /Line 1: the header row uses the name "Notes" for 14 columns \(6, 9, 12, …\)/,
    );
  });

  it('reads once its column names are distinct', () => {
    const { headers, rows } = parseCsvRows(withDistinctHeaders(fixtureText()));

    expect(headers).toHaveLength(46);
    expect(rows).toHaveLength(38);
  });

  it('splits on a comma inside a quoted value the way the exporter meant', () => {
    const { rows } = parseCsvRows(withDistinctHeaders(fixtureText()));

    expect(rows[0]['fi-FI']).toBe('IPWCAHJL™ Hbav Alhk 07, ipvsvnpulu oófyfpukprhhaavyp  (51977)');
  });

  it('reads a doubled quote inside a quoted value as one literal quote', () => {
    const { rows } = parseCsvRows(withDistinctHeaders(fixtureText()));

    // Written in the file as """COPB BPKL DX"" (whyh IK903G/9)".
    expect(rows[32]['en-GB']).toBe('"COPB BPKL DX" (whyh IK903G/9)');
  });

  it('leaves no CR in any value, though every line in the file ends with one', () => {
    const { rows } = parseCsvRows(withDistinctHeaders(fixtureText()));

    const withCarriageReturn = rows
      .flatMap((row) => Object.values(row))
      .filter((value) => value.includes('\r'));

    expect(withCarriageReturn).toEqual([]);
  });

  it('keeps a non-breaking space that a trim would have eaten', () => {
    const { rows } = parseCsvRows(withDistinctHeaders(fixtureText()));

    // U+00A0, mid-value, in the French cell. `String.prototype.trim` counts it
    // as whitespace, which is one reason values are never trimmed. The
    // substitution that anonymised this file left it where the exporter put it.
    expect(rows[0]['fr-FR']).toContain('hbavthapxbl\u00A007');
  });

  it('keeps every empty cell rather than collapsing the row', () => {
    const { headers, rows } = parseCsvRows(withDistinctHeaders(fixtureText()));
    const first = rows[0];

    expect(Object.keys(first)).toHaveLength(46);
    expect(headers.filter((name) => first[name] === '')).toHaveLength(30);
  });

  it('carries scripts and symbols through untouched', () => {
    const { rows } = parseCsvRows(withDistinctHeaders(fixtureText()));

    // Cyrillic asserted by range rather than by literal: the point is that the
    // script survived the read, and a hand-copied string of scrambled Cyrillic
    // would only add a way for the test itself to be wrong.
    expect(rows[0]['ru-RU']).toMatch(/^IPWCAHJL™ [Ѐ-ӿ]/);
    expect(rows[0]['en-GB']).toBe('IPWCAHJL™ Hbav Alhk 07 Balht Ipvsvnpjhs Pukpjhavy  (51977)');
  });
});
