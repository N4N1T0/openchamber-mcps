// Surgical reader and writer for the JSON (and JSONC) files OpenCode reads.
//
// An MCP server is not a file of its own: it is one member of the `mcp.servers`
// object inside a config file that also holds the user's model, permissions,
// plugins and comments. So this module never re-serializes a document. It
// parses the text into nodes that remember where they start and end, and every
// edit splices one span of that text. Everything the panel does not touch —
// comments, key order, indentation, trailing commas, CRLF — stays byte for
// byte as the user wrote it.
//
// Everything here is pure, so `bun test` can cover the round trip without a
// host. The reading and writing of the files themselves is in main.ts.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ObjectNode = {
  kind: 'object';
  /** Offset of `{`, and one past `}`. */
  start: number;
  end: number;
  members: Member[];
  value: { [key: string]: JsonValue };
};

export type JsonNode =
  | ObjectNode
  | { kind: 'array'; start: number; end: number; items: JsonNode[]; value: JsonValue[] }
  | { kind: 'scalar'; start: number; end: number; value: JsonValue };

export type Member = {
  key: string;
  /** Offset of the key's opening quote. */
  start: number;
  /** One past the end of the value, which is `node.end`. */
  end: number;
  node: JsonNode;
};

export class JsoncError extends Error {
  /** Offset in the document where the text stopped making sense. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = 'JsoncError';
    this.offset = offset;
  }
}

// ------------------------------------------------------------------ reading

type Cursor = { text: string; at: number };

const WHITESPACE = /[ \t\n\r]/;

// Annotated on the variable, not just on the arrow, so TypeScript treats a
// call to it as the end of that branch.
const fail: (cursor: Cursor, message: string) => never = (cursor, message) => {
  throw new JsoncError(message, cursor.at);
};

/**
 * Step over whitespace and comments. OpenCode reads `opencode.jsonc`, and a
 * plain `.json` file with comments in it is common enough to accept too: the
 * panel's job is to keep what it finds, not to judge it.
 */
const skipBlank = (cursor: Cursor): void => {
  const { text } = cursor;
  for (;;) {
    while (cursor.at < text.length && WHITESPACE.test(text[cursor.at]!)) cursor.at += 1;
    if (text.startsWith('//', cursor.at)) {
      const line = text.indexOf('\n', cursor.at);
      cursor.at = line === -1 ? text.length : line + 1;
      continue;
    }
    if (text.startsWith('/*', cursor.at)) {
      const close = text.indexOf('*/', cursor.at + 2);
      if (close === -1) fail(cursor, 'a block comment is never closed');
      cursor.at = close + 2;
      continue;
    }
    return;
  }
};

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

const parseString = (cursor: Cursor): string => {
  const { text } = cursor;
  cursor.at += 1; // the opening quote
  let out = '';
  for (;;) {
    if (cursor.at >= text.length) fail(cursor, 'a string is never closed');
    const char = text[cursor.at]!;
    if (char === '"') {
      cursor.at += 1;
      return out;
    }
    if (char === '\\') {
      const code = text[cursor.at + 1];
      if (code === undefined) fail(cursor, 'a string is never closed');
      if (code === 'u') {
        const hex = text.slice(cursor.at + 2, cursor.at + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(cursor, 'a \\u escape needs four hex digits');
        out += String.fromCharCode(Number.parseInt(hex, 16));
        cursor.at += 6;
        continue;
      }
      const mapped = ESCAPES[code];
      if (mapped === undefined) fail(cursor, `\\${code} is not an escape`);
      out += mapped;
      cursor.at += 2;
      continue;
    }
    out += char;
    cursor.at += 1;
  }
};

const LITERAL = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

const parseValue = (cursor: Cursor): JsonNode => {
  skipBlank(cursor);
  const { text } = cursor;
  if (cursor.at >= text.length) fail(cursor, 'the document ends where a value was expected');
  const char = text[cursor.at]!;

  if (char === '{') return parseObject(cursor);
  if (char === '[') return parseArray(cursor);
  if (char === '"') {
    const start = cursor.at;
    const value = parseString(cursor);
    return { kind: 'scalar', start, end: cursor.at, value };
  }

  const match = LITERAL.exec(text.slice(cursor.at));
  if (!match) fail(cursor, `${JSON.stringify(char)} does not start a value`);
  const raw = match[0];
  const start = cursor.at;
  cursor.at += raw.length;
  const value: JsonValue =
    raw === 'true' ? true : raw === 'false' ? false : raw === 'null' ? null : Number(raw);
  return { kind: 'scalar', start, end: cursor.at, value };
};

const parseObject = (cursor: Cursor): ObjectNode => {
  const { text } = cursor;
  const start = cursor.at;
  cursor.at += 1; // `{`
  const members: Member[] = [];
  const value: { [key: string]: JsonValue } = {};

  for (;;) {
    skipBlank(cursor);
    if (cursor.at >= text.length) fail(cursor, 'an object is never closed');
    if (text[cursor.at] === '}') {
      cursor.at += 1;
      break;
    }
    if (text[cursor.at] !== '"') fail(cursor, 'a key has to be a quoted string');
    const keyStart = cursor.at;
    const key = parseString(cursor);
    skipBlank(cursor);
    if (text[cursor.at] !== ':') fail(cursor, `no : after the key ${JSON.stringify(key)}`);
    cursor.at += 1;
    const node = parseValue(cursor);
    members.push({ key, start: keyStart, end: node.end, node });
    // A repeated key is last-wins, as JSON.parse reads it; both members are
    // kept so an edit can still find the one that counts.
    value[key] = node.value;
    skipBlank(cursor);
    if (text[cursor.at] === ',') {
      cursor.at += 1;
      continue; // a trailing comma lands on `}` next time round
    }
    if (text[cursor.at] === '}') {
      cursor.at += 1;
      break;
    }
    fail(cursor, 'no , or } after a value');
  }

  return { kind: 'object', start, end: cursor.at, members, value };
};

const parseArray = (cursor: Cursor): JsonNode => {
  const { text } = cursor;
  const start = cursor.at;
  cursor.at += 1; // `[`
  const items: JsonNode[] = [];
  const value: JsonValue[] = [];

  for (;;) {
    skipBlank(cursor);
    if (cursor.at >= text.length) fail(cursor, 'an array is never closed');
    if (text[cursor.at] === ']') {
      cursor.at += 1;
      break;
    }
    const node = parseValue(cursor);
    items.push(node);
    value.push(node.value);
    skipBlank(cursor);
    if (text[cursor.at] === ',') {
      cursor.at += 1;
      continue;
    }
    if (text[cursor.at] === ']') {
      cursor.at += 1;
      break;
    }
    fail(cursor, 'no , or ] after a value');
  }

  return { kind: 'array', start, end: cursor.at, items, value };
};

/** Parse a whole document. Throws `JsoncError` with the offset that broke it. */
export const parseJsonc = (text: string): JsonNode => {
  const cursor: Cursor = { text, at: 0 };
  const node = parseValue(cursor);
  skipBlank(cursor);
  if (cursor.at < text.length) fail(cursor, 'there is more text after the document');
  return node;
};

/** The line (1-based) an offset sits on, for an error a person has to act on. */
export const lineOf = (text: string, offset: number): number =>
  text.slice(0, Math.max(0, offset)).split('\n').length;

export const isObject = (node: JsonNode | null | undefined): node is ObjectNode =>
  node?.kind === 'object';

/** The member that counts for a key: the last one, as JSON itself reads it. */
export const member = (object: ObjectNode, key: string): Member | null => {
  for (let index = object.members.length - 1; index >= 0; index -= 1) {
    const found = object.members[index]!;
    if (found.key === key) return found;
  }
  return null;
};

/** Walk down nested objects. `null` when a step is missing or is not an object. */
export const objectAt = (node: JsonNode, path: string[]): ObjectNode | null => {
  let here: JsonNode | null = node;
  for (const key of path) {
    if (!isObject(here)) return null;
    here = member(here, key)?.node ?? null;
  }
  return isObject(here) ? here : null;
};

// ------------------------------------------------------------------ writing

const splice = (text: string, from: number, to: number, insert: string): string =>
  text.slice(0, from) + insert + text.slice(to);

/** The document's own line ending, so an inserted line matches the rest. */
const newlineOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

const lineStart = (text: string, at: number): number => text.lastIndexOf('\n', at - 1) + 1;

/** The offset of the line's `\n` (before a `\r\n`, so splicing keeps it whole). */
const lineEnd = (text: string, at: number): number => {
  const index = text.indexOf('\n', at);
  if (index === -1) return text.length;
  return index > 0 && text[index - 1] === '\r' ? index - 1 : index;
};

const indentAt = (text: string, at: number): string => {
  const from = lineStart(text, at);
  return /^[ \t]*/.exec(text.slice(from, at))![0];
};

/** One indent step, read from the document; two spaces when it has none. */
const indentUnit = (text: string): string => {
  const found = /\n([ \t]+)[^ \t\r\n]/.exec(text);
  return found?.[1] ?? '  ';
};

/** The comma that separates a member from what follows, or -1. */
const commaAfter = (text: string, node: JsonNode): number => {
  const cursor: Cursor = { text, at: node.end };
  try {
    skipBlank(cursor);
  } catch {
    return -1;
  }
  return text[cursor.at] === ',' ? cursor.at : -1;
};

/**
 * Set `key` inside `object` to the JSON text `valueJson`, or add it when it is
 * not there yet. A new member is written on its own line after the last one,
 * with that member's indentation, and keeps the object's trailing-comma style;
 * an object written on a single line stays on one line. Anything already on
 * the line it is added after — a trailing comment, say — stays where it is.
 */
export const setMember = (
  text: string,
  object: ObjectNode,
  key: string,
  valueJson: string,
): string => {
  const existing = member(object, key);
  if (existing) return splice(text, existing.node.start, existing.node.end, valueJson);

  const entry = `${JSON.stringify(key)}: ${valueJson}`;
  const oneLine = !text.slice(object.start, object.end).includes('\n');
  const last = object.members[object.members.length - 1];

  if (!last) {
    // An empty object: `{}` or `{ }` or one holding only comments.
    if (oneLine) return splice(text, object.start + 1, object.end - 1, ` ${entry} `);
    const inner = indentAt(text, object.start) + indentUnit(text);
    const newline = newlineOf(text);
    return splice(text, object.start + 1, object.start + 1, `${newline}${inner}${entry}`);
  }

  const comma = commaAfter(text, last.node);
  const at = comma === -1 ? last.node.end : comma + 1;
  if (oneLine) {
    return splice(text, at, at, comma === -1 ? `, ${entry}` : ` ${entry},`);
  }

  const newline = newlineOf(text);
  const indent = indentAt(text, last.start);
  const restOfLine = text.slice(at, lineEnd(text, at));
  return splice(
    text,
    at,
    at + restOfLine.length,
    `${comma === -1 ? ',' : ''}${restOfLine}${newline}${indent}${entry}${comma === -1 ? '' : ','}`,
  );
};

/**
 * Remove `key` from `object`, with the comma that held it in place, so the
 * result is still valid JSON — a trailing comma left behind would break a
 * plain `.json` file. When the member had a line to itself, the line goes too.
 *
 * A comment on its own line before the key is taken as the key's own and goes
 * with it; one that trails the member before it stays where it is. Without the
 * key the text comes back unchanged.
 */
export const dropMember = (text: string, object: ObjectNode, key: string): string => {
  const target = member(object, key);
  if (!target) return text;

  let from = target.start;
  let to = target.node.end;
  /** What was on the previous member's line and has to survive the cut. */
  let keep = '';

  const comma = commaAfter(text, target.node);
  if (comma !== -1) {
    // Not the last member: the comma after it goes too, and the spaces that
    // separated it from the next key, so a one-line object keeps its spacing.
    to = comma + 1;
    let after = to;
    while (after < text.length && (text[after] === ' ' || text[after] === '\t')) after += 1;
    if (text[after] === '"' || text[after] === '}') to = after;
  } else {
    // The last member: the comma that separates it from the one before does.
    const index = object.members.indexOf(target);
    const previous = index > 0 ? object.members[index - 1] : undefined;
    const before = previous ? commaAfter(text, previous.node) : -1;
    if (before !== -1) {
      from = before;
      // When the key sat on a line of its own, whatever trailed the comma is a
      // comment about the member before it and has to stay.
      if (text.slice(from, target.start).includes('\n')) {
        const trailing = text.slice(from + 1, lineEnd(text, from));
        if (trailing.trim() !== '') keep = trailing;
      }
    }
  }

  // Swallow the whole line when the member had it to itself.
  const start = lineStart(text, from);
  if (keep === '' && text.slice(start, from).trim() === '') {
    const end = lineEnd(text, to);
    if (text.slice(to, end).trim() === '') {
      from = start;
      to = Math.min(end + newlineOf(text).length, text.length);
    }
  }

  return splice(text, from, to, keep);
};
