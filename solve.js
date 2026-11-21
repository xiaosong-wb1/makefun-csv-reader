// Fast drop-in for make.fun csv-reader 1.0.0.
// Same answers, byte for byte in JSON terms. Speed comes from slicing
// fields with native indexOf instead of building every field one
// character at a time. Slow per-character paths are kept only for the
// rare broken cases (stray CR, quote junk, unterminated quote), where
// correctness matters and speed does not.
//
// Semantics (from the reference, vendor/csv-reader/index.js):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr).
// - A field opening with a quote runs to the next quote that is not
//   doubled; "" inside is one quote; CRLF / lone CR inside read as LF.
//   What follows the closing quote, up to the next comma or line break,
//   is appended as it stands (quote_junk when the field ends).
// - A quote that never closes is a literal character, and the text
//   after it is read again as unquoted (unterminated_quote).
// - A quote inside an unquoted field is literal. Fields stay strings.
// - columns is the first record when header is true, else null; rows
//   are the rest, padded (short_row) or cut (long_row) to the first
//   record's width. Errors are {code, line, row} in the order met,
//   line = 1-based line the record starts on, row = its index in rows
//   (null for the header).

const COMMA = 0;
const DELIM = /[,\r\n]/g;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // --- slow paths (rare broken cases) ---------------------------------
  // Read an unquoted field starting at p, with an initial value `init`
  // already in hand. Returns [value, ended, newPos, newLine, added]
  // where `added` counts characters kept after `init`.
  // Only called when a stray CR, junk or an unterminated quote is in
  // play; the hot path below never calls it.
  function readUnquotedSlow(p, ln, init, recordLine, recordRow) {
    let value = init;
    let added = 0;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 44) { // ,
        return [value, COMMA, p + 1, ln, added];
      }
      if (c === 10) { // \n
        return [value, LINE_BREAK, p + 1, ln + 1, added];
      }
      if (c === 13) { // \r
        if (p + 1 < n && text.charCodeAt(p + 1) === 10) {
          return [value, LINE_BREAK, p + 2, ln + 1, added];
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        p += 1;
        continue;
      }
      value += text[p];
      added += 1;
      p += 1;
    }
    return [value, END, p, ln, added];
  }

  // Count line breaks in a quoted chunk: \r\n counts as one, lone \r
  // and \n each count as one. Returns the count.
  function countBreaks(s) {
    let cnt = 0;
    let i = 0;
    const m = s.length;
    while (i < m) {
      const c = s.charCodeAt(i);
      if (c === 13) {
        cnt += 1;
        i += (i + 1 < m && s.charCodeAt(i + 1) === 10) ? 2 : 1;
      } else if (c === 10) {
        cnt += 1;
        i += 1;
      } else {
        i += 1;
      }
    }
    return cnt;
  }

  // --- main record loop ------------------------------------------------
  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = (header && columns === null) ? null : rows.length;
    const fields = [];
    let ended = COMMA;
    let quoted = false;

    do {
      if (text.charCodeAt(pos) === 34) {
        // ---- quoted field ----
        quoted = true;
        const open = pos;
        const openLine = line;
        let value;
        let q = text.indexOf('"', pos + 1);
        if (q === -1) {
          // Unterminated: the quote is literal, re-read as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = readUnquotedSlow(open + 1, openLine, '"', recordLine, recordRow);
          value = r[0]; ended = r[1]; pos = r[2]; line = r[3];
          fields.push(value);
          continue;
        }
        if (text.charCodeAt(q + 1) === 34) {
          // Doubled quotes present: collect segments. If no closing
          // quote ever appears, this is unterminated after all.
          const parts = [];
          let s = pos + 1;
          let cur = q;
          let closedAt = -1;
          let rawHasBreak = false;
          while (true) {
            const seg = text.slice(s, cur);
            if (seg.indexOf('\r') !== -1 || seg.indexOf('\n') !== -1) rawHasBreak = true;
            parts.push(seg);
            if (text.charCodeAt(cur + 1) === 34) {
              parts.push('"');
              s = cur + 2;
              cur = text.indexOf('"', s);
              if (cur === -1) break;
              continue;
            }
            closedAt = cur;
            break;
          }
          if (closedAt === -1) {
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            const r = readUnquotedSlow(open + 1, openLine, '"', recordLine, recordRow);
            value = r[0]; ended = r[1]; pos = r[2]; line = r[3];
            fields.push(value);
            continue;
          }
          value = parts.join('');
          if (rawHasBreak) {
            line += countBreaks(value);
            // Normalise CRLF / lone CR inside quotes to LF.
            if (value.indexOf('\r') !== -1) value = value.replace(/\r\n?/g, '\n');
          }
          pos = closedAt + 1;
        } else {
          // Single closing quote, no doubled quotes: the common case.
          const raw = text.slice(pos + 1, q);
          if (raw.indexOf('\r') === -1 && raw.indexOf('\n') === -1) {
            value = raw;
          } else {
            line += countBreaks(raw);
            value = raw.indexOf('\r') !== -1 ? raw.replace(/\r\n?/g, '\n') : raw;
          }
          pos = q + 1;
        }
        // After the closing quote.
        if (pos >= n) {
          ended = END;
        } else {
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            ended = COMMA;
          } else if (c === 10) {
            pos += 1;
            line += 1;
            ended = LINE_BREAK;
          } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            ended = LINE_BREAK;
          } else {
            // Quote junk: read the rest as unquoted, on top of value.
            const r = readUnquotedSlow(pos, line, value, recordLine, recordRow);
            if (r[4] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            value = r[0]; ended = r[1]; pos = r[2]; line = r[3];
          }
        }
        fields.push(value);
      } else {
        // ---- unquoted field: fast slice to the next delimiter ----
        quoted = false;
        DELIM.lastIndex = pos;
        const m = DELIM.exec(text);
        let end = -1;
        let kind = END;
        if (m) {
          end = m.index;
          const dc = m[0].charCodeAt(0);
          kind = dc === 44 ? COMMA : (dc === 10 ? LINE_BREAK : 3);
        }
        if (end === -1) {
          fields.push(text.slice(pos));
          pos = n;
          ended = END;
        } else if (kind === 3) {
          if (end + 1 < n && text.charCodeAt(end + 1) === 10) {
            fields.push(text.slice(pos, end));
            pos = end + 2;
            line += 1;
            ended = LINE_BREAK;
          } else {
            // Stray CR in play: slow path from the field start.
            const r = readUnquotedSlow(pos, line, '', recordLine, recordRow);
            fields.push(r[0]); ended = r[1]; pos = r[2]; line = r[3];
          }
        } else if (kind === COMMA) {
          fields.push(text.slice(pos, end));
          pos = end + 1;
          ended = COMMA;
        } else {
          fields.push(text.slice(pos, end));
          pos = end + 1;
          line += 1;
          ended = LINE_BREAK;
        }
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
