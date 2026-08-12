/**
 * A CSV reader for data rows, written here rather than taken from a package.
 *
 * The format is small enough to own: RFC 4180 is four rules — a comma separates
 * fields, a newline ends a record, a double quote wraps a field that contains
 * either, and a doubled quote inside a quoted field is one literal quote. What a
 * dependency would add over this file is the parts of the wider CSV world that
 * are deliberately *not* accepted here (see below), and it would add them on the
 * path that carries credentials: a data row's whole purpose is to hold the
 * identity a request runs as, so every byte of every row passes through this
 * code. A package on that path is a permanent thing to read, trust and re-audit.
 *
 * The decisive reason, though, is the errors. The reader of a rejection here is
 * an agent that must repair the file, and it can only do that if the message
 * names the line and the column. A library reports its own position in its own
 * vocabulary — "Invalid Closing Quote" at an offset — which says nothing about
 * which credential in which row is malformed.
 *
 * What is accepted: comma as the only delimiter, `"` as the only quote, `""` as
 * the only escape, and LF, CRLF or a bare CR as a record separator. What is
 * rejected, with a reason: any other delimiter (semicolon-separated exports from
 * a European locale, tab-separated files), a quote appearing after a field has
 * already begun, characters between a closing quote and the next delimiter, and
 * a row whose field count disagrees with the header row.
 *
 * Every value is a string. A CSV cell cannot say whether `1` is a number, and
 * nothing here guesses; a data file that needs typed values should be `.json`.
 */

/** Written as an escape because the character itself is invisible in a source file. */
const BOM = /^\uFEFF/;

/** Separators of the wider CSV world, used to recognise a file this reader cannot take. */
const FOREIGN_DELIMITERS = [';', '\t'];

/** Cap on the column positions a duplicate-name error lists, so a wide file stays readable. */
const MAX_REPORTED_POSITIONS = 3;

/** A parsed data file: the column names in file order, and one object per row. */
export interface CsvRows {
  headers: string[];
  rows: Record<string, string>[];
}

/** One record as scanned, with the line it started on for error reporting. */
interface CsvRecord {
  fields: string[];
  /** 1-based line where the record began — a quoted field may span several. */
  line: number;
  /** Whether the record's only field was written as `""` rather than left empty. */
  singleQuotedEmpty: boolean;
}

/**
 * Split the text into records of fields.
 *
 * A hand-rolled scan rather than a split on commas and newlines, because both
 * characters are legal inside a quoted field and a split cannot see the quotes.
 *
 * Error messages carry positions and never cell contents. A cell holds the very
 * password the run is about, and a parser that echoes the offending text back
 * copies it into wherever the diagnosis is written — the same reason
 * `describeParseFailure` drops the code frames `yaml` appends.
 */
function scanRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let line = 1;
  let recordLine = 1;
  let inQuotes = false;
  let fieldQuoted = false;
  let quoteClosed = false;
  let i = 0;

  const endField = (): void => {
    fields.push(field);
    field = '';
    quoteClosed = false;
  };

  const endRecord = (): void => {
    endField();
    records.push({
      fields,
      line: recordLine,
      singleQuotedEmpty: fields.length === 1 && fields[0] === '' && fieldQuoted,
    });
    fields = [];
    fieldQuoted = false;
    recordLine = line;
  };

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        quoteClosed = true;
        i += 1;
        continue;
      }
      // A newline inside quotes is part of the value, but it is normalised to a
      // bare LF: a value that kept its CR would carry it into an HTTP header the
      // request interpolates it into, and a header value containing CR is how a
      // data file turns into header injection.
      if (char === '\r') {
        field += '\n';
        i += text[i + 1] === '\n' ? 2 : 1;
        line += 1;
        continue;
      }
      if (char === '\n') {
        field += '\n';
        line += 1;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      // A quote opens a field or it is a mistake. Accepting `a"b` as a literal
      // would make `"a,b"` and `x"a,b"` mean different things about that comma,
      // so the shape that most often means a hand-edited file gets a diagnosis
      // instead of a silently different row.
      if (field !== '' || quoteClosed) {
        throw new Error(
          `Line ${line}: a quote may only open a field, and this one appears after the field `
            + 'has already begun. Write a literal quote inside a quoted field as two quotes ("").',
        );
      }
      inQuotes = true;
      fieldQuoted = true;
      i += 1;
      continue;
    }

    if (quoteClosed && char !== ',' && char !== '\n' && char !== '\r') {
      throw new Error(
        `Line ${line}: a closing quote must be followed by a comma or the end of the line. `
          + 'To include a quote in the value, write it as two quotes ("").',
      );
    }

    if (char === ',') {
      endField();
      i += 1;
      continue;
    }

    // LF, CRLF and a bare CR all end a record. A bare CR is not RFC 4180, but a
    // file that uses it would otherwise scan as one enormous single-line record,
    // and reading a whole file as one row is a worse failure than accepting a
    // separator no current tool emits.
    if (char === '\r') {
      i += text[i + 1] === '\n' ? 2 : 1;
      line += 1;
      endRecord();
      continue;
    }
    if (char === '\n') {
      i += 1;
      line += 1;
      endRecord();
      continue;
    }

    field += char;
    i += 1;
  }

  if (inQuotes) {
    throw new Error(
      `Line ${recordLine}: a quoted field is never closed — the file ends inside it. `
        + 'Add the missing closing quote, or write a literal quote as two quotes ("").',
    );
  }

  // A file ending in a newline has no trailing record; anything else does.
  if (fields.length > 0 || field !== '' || fieldQuoted) endRecord();

  return records;
}

/**
 * Records that carry data, with blank lines dropped.
 *
 * A blank line is a record of one empty field, which is indistinguishable from a
 * single-column row whose value is empty — so in a one-column file an
 * intentionally empty value has to be written `""`, which is why the scanner
 * tracks that. Dropping blank lines rather than rejecting them is what lets a
 * file end with a newline, and a trailing newline is what every editor writes.
 */
function dataRecords(records: CsvRecord[]): CsvRecord[] {
  return records.filter(
    (record) => record.singleQuotedEmpty || record.fields.length > 1 || record.fields[0] !== '',
  );
}

/**
 * The column names, checked for the two shapes that would hide a column.
 *
 * Names are trimmed because a header is a variable name, and a name with
 * surrounding whitespace cannot be referenced as `{{name}}` by anything — so the
 * whitespace can never have been intended. Values are never trimmed: there a
 * space may well be the point.
 */
function readHeaders(record: CsvRecord): string[] {
  const headers = record.fields.map((name) => name.trim());

  // A file separated by something else does not fail to parse — it parses as one
  // column whose name is the whole header line, and then every row matches that
  // one column and the run proceeds with a single variable nobody named. Only a
  // header row of exactly one column can be this, and a real one-column file
  // cannot be caught by it: a Bruno variable name holding one of these
  // characters could not be referenced as `{{name}}` in the first place.
  const foreign = headers.length === 1
    ? FOREIGN_DELIMITERS.find((delimiter) => headers[0].includes(delimiter))
    : undefined;
  if (foreign !== undefined) {
    throw new Error(
      `Line ${record.line}: the header row is a single column named "${headers[0]}", which `
        + `contains ${foreign === '\t' ? 'a tab' : `a "${foreign}"`}. Fields here are separated `
        + 'by commas only, so re-export the file comma-separated.',
    );
  }

  const blank = headers.indexOf('');
  if (blank !== -1) {
    throw new Error(
      `Line ${record.line}: column ${blank + 1} of the header row has no name. Every column `
        + 'needs one, since a column name is the variable name its values are bound to.',
    );
  }

  // Reported with a count and positions rather than as "names it twice", because
  // a real export repeats a name once per group of columns — a glossary with
  // fourteen languages carries fourteen columns called "Notes" — and a message
  // that says "twice" sends the reader looking for the wrong thing. The
  // positions are capped so a wide file cannot turn one error into a list.
  const duplicate = headers.find((name, index) => headers.indexOf(name) !== index);
  if (duplicate !== undefined) {
    const at = headers
      .map((name, index) => (name === duplicate ? index + 1 : 0))
      .filter((position) => position !== 0);
    const shown = at.slice(0, MAX_REPORTED_POSITIONS).join(', ');
    throw new Error(
      `Line ${record.line}: the header row uses the name "${duplicate}" for ${at.length} columns `
        + `(${shown}${at.length > MAX_REPORTED_POSITIONS ? ', …' : ''}). A column name is the `
        + 'variable name its values bind to, so all but one of them would be unreachable. Give '
        + 'each column a distinct name.',
    );
  }

  return headers;
}

/**
 * Parse a CSV data file into rows keyed by column name.
 *
 * Throws on a malformed file rather than returning what it could read. A row
 * whose fields do not line up with the header row is the case that decides
 * this: padding or truncating it would bind a value to the wrong column, and a
 * run that authenticates with one row's password under another row's username
 * still comes back green — it just proves something nobody asked about.
 */
export function parseCsvRows(text: string): CsvRows {
  // A BOM is what a spreadsheet writes when it exports UTF-8, and left in place
  // it becomes part of the first column's name, so the first variable in the
  // file is the one that silently never binds.
  const records = dataRecords(scanRecords(text.replace(BOM, '')));

  const header = records[0];
  if (header === undefined) {
    throw new Error(
      'The data file has no rows. It needs a header row naming the columns, and at least one '
        + 'row of values.',
    );
  }

  const headers = readHeaders(header);
  const rows = records.slice(1).map((record) => {
    if (record.fields.length !== headers.length) {
      throw new Error(
        `Line ${record.line}: this row has ${record.fields.length} `
          + `field${record.fields.length === 1 ? '' : 's'} but the header row names `
          + `${headers.length} columns (${headers.join(', ')}). A row that does not line up `
          + 'would bind values to the wrong columns.',
      );
    }

    const row: Record<string, string> = {};
    headers.forEach((name, index) => {
      row[name] = record.fields[index];
    });
    return row;
  });

  if (rows.length === 0) {
    throw new Error(
      `The data file has a header row naming ${headers.length} columns but no rows of values, `
        + 'so there is nothing to run.',
    );
  }

  return { headers, rows };
}
