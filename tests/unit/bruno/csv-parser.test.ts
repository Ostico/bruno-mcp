/**
 * What the CSV data-row reader accepts, and what it refuses to guess about.
 *
 * The acceptance tests are ordinary. The ones worth reading are the refusals:
 * every case here is a file that another reader would have taken and turned into
 * rows that bind values to the wrong columns, which is the failure this module
 * exists to make impossible.
 */
import { parseCsvRows } from '../../../src/bruno/csv-parser';

describe('reading CSV data rows', () => {
  it('reads a header row and one row per line', () => {
    const { headers, rows } = parseCsvRows('name,password\nalice,s3cret\nbob,hunter2\n');

    expect(headers).toEqual(['name', 'password']);
    expect(rows).toEqual([
      { name: 'alice', password: 's3cret' },
      { name: 'bob', password: 'hunter2' },
    ]);
  });

  it('leaves every value a string, since a cell cannot say it is a number', () => {
    const { rows } = parseCsvRows('id,active\n7,true\n');

    // Not 7 and not true: the caller binds these as variables, and a variable
    // interpolated into a request is text either way.
    expect(rows[0]).toEqual({ id: '7', active: 'true' });
  });

  it('takes a file with no trailing newline', () => {
    const { rows } = parseCsvRows('name\nalice');

    expect(rows).toEqual([{ name: 'alice' }]);
  });

  it('does not invent a row from the newline that ends the file', () => {
    const { rows } = parseCsvRows('name\nalice\n');

    expect(rows).toHaveLength(1);
  });

  it('keeps an empty trailing field rather than dropping the column', () => {
    const { rows } = parseCsvRows('name,password\nalice,\n');

    expect(rows).toEqual([{ name: 'alice', password: '' }]);
  });

  describe('line endings', () => {
    it('takes CRLF, which is what a spreadsheet exports', () => {
      const { rows } = parseCsvRows('name\r\nalice\r\nbob\r\n');

      expect(rows).toEqual([{ name: 'alice' }, { name: 'bob' }]);
    });

    it('takes a bare CR rather than reading the whole file as one row', () => {
      const { rows } = parseCsvRows('name\ralice\rbob');

      expect(rows).toEqual([{ name: 'alice' }, { name: 'bob' }]);
    });

    it('drops a blank line instead of failing on its field count', () => {
      const { rows } = parseCsvRows('name,password\nalice,a\n\nbob,b\n');

      expect(rows).toEqual([
        { name: 'alice', password: 'a' },
        { name: 'bob', password: 'b' },
      ]);
    });
  });

  describe('quoted fields', () => {
    it('keeps a comma that is inside quotes out of the field split', () => {
      const { rows } = parseCsvRows('name,note\nalice,"one, two"\n');

      expect(rows).toEqual([{ name: 'alice', note: 'one, two' }]);
    });

    it('keeps a newline that is inside quotes in the value', () => {
      const { rows } = parseCsvRows('name,note\nalice,"one\ntwo"\nbob,b\n');

      expect(rows).toEqual([
        { name: 'alice', note: 'one\ntwo' },
        { name: 'bob', note: 'b' },
      ]);
    });

    it('normalises a CRLF inside quotes to a bare LF', () => {
      const { rows } = parseCsvRows('name,note\nalice,"one\r\ntwo"\n');

      // A value that kept its CR would carry it into any header it is
      // interpolated into, which is header injection by data file.
      expect(rows[0].note).toBe('one\ntwo');
    });

    it('normalises a bare CR inside quotes to a bare LF', () => {
      const { rows } = parseCsvRows('name,note\nalice,"one\rtwo"\n');

      expect(rows[0].note).toBe('one\ntwo');
    });

    it('reads a doubled quote as one literal quote', () => {
      const { rows } = parseCsvRows('name,note\nalice,"she said ""hi"""\n');

      expect(rows[0].note).toBe('she said "hi"');
    });

    it('keeps a quoted empty value in a one-column file, unlike a blank line', () => {
      const { rows } = parseCsvRows('password\n""\nhunter2\n');

      // The only way to say "this single-column row is deliberately empty":
      // written bare it is indistinguishable from a blank line.
      expect(rows).toEqual([{ password: '' }, { password: 'hunter2' }]);
    });

    it('counts the lines a quoted value spans when reporting a later row', () => {
      expect(() => parseCsvRows('name,note\nalice,"one\ntwo"\nbob\n')).toThrow(/^Line 4:/);
    });
  });

  describe('header names', () => {
    it('strips the byte-order mark a UTF-8 export writes before the first name', () => {
      const { headers, rows } = parseCsvRows('\uFEFFname,password\nalice,a\n');

      // Left in place it becomes part of the name, so the first variable in the
      // file is the one that silently never binds.
      expect(headers).toEqual(['name', 'password']);
      expect(rows[0].name).toBe('alice');
    });

    it('trims a name, because a name with spaces is not referenceable', () => {
      const { headers } = parseCsvRows('  name , password \nalice,a\n');

      expect(headers).toEqual(['name', 'password']);
    });

    it('never trims a value, where a space may be the point', () => {
      const { rows } = parseCsvRows('password\n  spaced  \n');

      expect(rows[0].password).toBe('  spaced  ');
    });
  });

  describe('refusals', () => {
    it('refuses an empty file', () => {
      expect(() => parseCsvRows('')).toThrow(/no rows/);
    });

    it('refuses a file of nothing but blank lines', () => {
      expect(() => parseCsvRows('\n\n\n')).toThrow(/no rows/);
    });

    it('refuses a header row with no rows under it', () => {
      expect(() => parseCsvRows('name,password\n')).toThrow(/no rows of values/);
    });

    it('refuses an unnamed column, naming its position', () => {
      expect(() => parseCsvRows('name,,password\na,b,c\n')).toThrow(
        /Line 1: column 2 of the header row has no name/,
      );
    });

    it('refuses a repeated column name, naming every column that shares it', () => {
      expect(() => parseCsvRows('name,password,name\na,b,c\n')).toThrow(
        /Line 1: the header row uses the name "name" for 2 columns \(1, 3\)\./,
      );
    });

    it('caps the positions it lists, so a wide file gets an error and not a list', () => {
      expect(() => parseCsvRows('n,n,n,n,n\na,b,c,d,e\n')).toThrow(
        /the name "n" for 5 columns \(1, 2, 3, …\)\./,
      );
    });

    it('refuses a row with fewer fields than there are columns', () => {
      // The case the module exists for: padding this row would bind "b" to
      // `password` on one row and leave it empty on another, and the run would
      // still come back green.
      expect(() => parseCsvRows('name,password\nalice,a\nbob\n')).toThrow(
        /Line 3: this row has 1 field but the header row names 2 columns \(name, password\)/,
      );
    });

    it('refuses a row with more fields than there are columns', () => {
      expect(() => parseCsvRows('name,password\nalice,a,extra\n')).toThrow(
        /Line 2: this row has 3 fields but the header row names 2 columns/,
      );
    });

    it('refuses a semicolon-separated export instead of reading it as one column', () => {
      expect(() => parseCsvRows('name;password\nalice;a\n')).toThrow(
        /Line 1: the header row is a single column named "name;password", which contains a ";"/,
      );
    });

    it('refuses a tab-separated export the same way', () => {
      expect(() => parseCsvRows('name\tpassword\nalice\ta\n')).toThrow(/which contains a tab/);
    });

    it('accepts a semicolon inside a value, where it separates nothing', () => {
      const { rows } = parseCsvRows('name,note\nalice,a;b\n');

      expect(rows[0].note).toBe('a;b');
    });

    it('refuses a quote that opens after the field has begun', () => {
      expect(() => parseCsvRows('name,note\nalice,a"b"\n')).toThrow(
        /Line 2: a quote may only open a field/,
      );
    });

    it('refuses characters between a closing quote and the delimiter', () => {
      expect(() => parseCsvRows('name,note\nalice,"a"b\n')).toThrow(
        /Line 2: a closing quote must be followed by a comma or the end of the line/,
      );
    });

    it('refuses a quoted field that the file ends inside, naming where it opened', () => {
      expect(() => parseCsvRows('name,note\nalice,"one\ntwo\n')).toThrow(
        /Line 2: a quoted field is never closed/,
      );
    });

    it('names no cell contents in a refusal', () => {
      // A cell holds the password the run is about. Positions and column names
      // are safe to report; the value on the offending line is not.
      let message = '';
      try {
        parseCsvRows('name,password\nalice,s3cret,extra\n');
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(/Line 2: this row has 3 fields/);
      expect(message).not.toContain('s3cret');
    });
  });
});
