import { describe, expect, test } from 'bun:test';
import {
  dropMember,
  isObject,
  JsoncError,
  lineOf,
  member,
  objectAt,
  parseJsonc,
  setMember,
} from './jsonc';

/** The object at `path`, or a failed expectation: every test here needs one. */
const objectIn = (text: string, path: string[]) => {
  const found = objectAt(parseJsonc(text), path);
  if (!found) throw new Error(`no object at ${path.join('.')}`);
  return found;
};

describe('parsing', () => {
  test('reads the same values JSON.parse would', () => {
    const text = `{
      "model": "anthropic/claude",
      "numbers": [1, -2, 3.5, 1e3],
      "flags": { "on": true, "off": false, "none": null },
      "escaped": "a\\"b\\\\c\\n\\u0041"
    }`;
    expect(parseJsonc(text).value).toEqual(JSON.parse(text));
  });

  test('accepts comments and trailing commas', () => {
    const text = `{
      // the model to use
      "model": "a/b", /* inline */
      "mcp": { "servers": {} },
    }`;
    const root = parseJsonc(text);
    expect(root.value).toEqual({ model: 'a/b', mcp: { servers: {} } });
  });

  test('a repeated key reads as the last one, as JSON does', () => {
    const text = '{ "a": 1, "a": 2 }';
    expect(parseJsonc(text).value).toEqual({ a: 2 });
    const root = parseJsonc(text);
    expect(isObject(root) && root.members.length).toBe(2);
    expect(member(objectIn(text, []), 'a')?.node.value).toBe(2);
  });

  test('a node knows where it starts and ends', () => {
    const text = '{ "a": { "b": 2 } }';
    const inner = objectIn(text, ['a']);
    expect(text.slice(inner.start, inner.end)).toBe('{ "b": 2 }');
  });

  test('a broken document says where it broke', () => {
    const text = '{\n  "a": 1\n  "b": 2\n}';
    try {
      parseJsonc(text);
      throw new Error('should have failed');
    } catch (error) {
      expect(error).toBeInstanceOf(JsoncError);
      expect(lineOf(text, (error as JsoncError).offset)).toBe(3);
    }
  });

  test('an unclosed string, object or comment is an error', () => {
    expect(() => parseJsonc('{ "a": "x }')).toThrow(JsoncError);
    expect(() => parseJsonc('{ "a": 1 ')).toThrow(JsoncError);
    expect(() => parseJsonc('{ /* "a": 1 }')).toThrow(JsoncError);
    expect(() => parseJsonc('{ "a": 1 } trailing')).toThrow(JsoncError);
  });

  test('objectAt stops at anything that is not an object', () => {
    const root = parseJsonc('{ "mcp": { "servers": 4 } }');
    expect(objectAt(root, ['mcp'])).not.toBeNull();
    expect(objectAt(root, ['mcp', 'servers'])).toBeNull();
    expect(objectAt(root, ['nothing', 'here'])).toBeNull();
  });
});

describe('setMember', () => {
  test('replaces a value and leaves the rest of the file alone', () => {
    const text = `{
  // keep me
  "mcp": {
    "servers": {
      "a": { "type": "remote", "url": "https://x", "disabled": false }
    }
  }
}
`;
    const next = setMember(text, objectIn(text, ['mcp', 'servers', 'a']), 'disabled', 'true');
    expect(next).toBe(text.replace('"disabled": false', '"disabled": true'));
  });

  test('adds a key on its own line, with the indentation of the last one', () => {
    const text = `{
  "mcp": {
    "servers": {
      "a": {
        "type": "remote",
        "url": "https://x"
      }
    }
  }
}
`;
    const next = setMember(text, objectIn(text, ['mcp', 'servers', 'a']), 'disabled', 'true');
    expect(next).toBe(`{
  "mcp": {
    "servers": {
      "a": {
        "type": "remote",
        "url": "https://x",
        "disabled": true
      }
    }
  }
}
`);
  });

  test('keeps a trailing-comma style', () => {
    const text = `{
  "a": {
    "type": "local",
  },
}`;
    const next = setMember(text, objectIn(text, ['a']), 'disabled', 'true');
    expect(next).toBe(`{
  "a": {
    "type": "local",
    "disabled": true,
  },
}`);
  });

  test('a one-line object stays on one line', () => {
    expect(setMember('{ "a": 1 }', objectIn('{ "a": 1 }', []), 'b', '2')).toBe('{ "a": 1, "b": 2 }');
    expect(setMember('{}', objectIn('{}', []), 'b', '2')).toBe('{ "b": 2 }');
    expect(setMember('{ "a": 1, }', objectIn('{ "a": 1, }', []), 'b', '2')).toBe('{ "a": 1, "b": 2, }');
  });

  test('an empty object written over lines gets an indented member', () => {
    const text = `{
  "servers": {
  }
}`;
    expect(setMember(text, objectIn(text, ['servers']), 'a', '1')).toBe(`{
  "servers": {
    "a": 1
  }
}`);
  });

  test('a comment on the last member keeps its line', () => {
    const text = `{
  "a": {
    "type": "local", // a note
    "command": ["x"] // another
  }
}`;
    const next = setMember(text, objectIn(text, ['a']), 'disabled', 'true');
    expect(next).toBe(`{
  "a": {
    "type": "local", // a note
    "command": ["x"], // another
    "disabled": true
  }
}`);
  });

  test('CRLF files get CRLF lines', () => {
    const text = '{\r\n  "a": {\r\n    "type": "local"\r\n  }\r\n}\r\n';
    const next = setMember(text, objectIn(text, ['a']), 'disabled', 'true');
    expect(next).toBe('{\r\n  "a": {\r\n    "type": "local",\r\n    "disabled": true\r\n  }\r\n}\r\n');
  });

  test('tab indentation is copied, not replaced with spaces', () => {
    const text = '{\n\t"a": {\n\t\t"type": "local"\n\t}\n}';
    const next = setMember(text, objectIn(text, ['a']), 'disabled', 'true');
    expect(next).toBe('{\n\t"a": {\n\t\t"type": "local",\n\t\t"disabled": true\n\t}\n}');
  });

  test('what it writes parses back to what was asked for', () => {
    const text = '{\n  "a": {\n    "type": "local"\n  }\n}';
    const next = setMember(text, objectIn(text, ['a']), 'disabled', 'true');
    expect(parseJsonc(next).value).toEqual({ a: { type: 'local', disabled: true } });
  });
});

describe('dropMember', () => {
  test('removes a key in the middle and the comma with it', () => {
    const text = `{
  "a": 1,
  "b": 2,
  "c": 3
}`;
    expect(dropMember(text, objectIn(text, []), 'b')).toBe(`{
  "a": 1,
  "c": 3
}`);
  });

  test('removes the last key without leaving a trailing comma', () => {
    const text = `{
  "a": 1,
  "b": 2
}`;
    const next = dropMember(text, objectIn(text, []), 'b');
    expect(next).toBe(`{
  "a": 1
}`);
    expect(JSON.parse(next)).toEqual({ a: 1 });
  });

  test('removes the only key', () => {
    const text = `{
  "b": 2
}`;
    expect(JSON.parse(dropMember(text, objectIn(text, []), 'b'))).toEqual({});
  });

  test('keeps a trailing comma that was already there', () => {
    const text = '{\n  "a": 1,\n  "b": 2,\n}';
    expect(dropMember(text, objectIn(text, []), 'b')).toBe('{\n  "a": 1,\n}');
  });

  test('a missing key changes nothing', () => {
    const text = '{ "a": 1 }';
    expect(dropMember(text, objectIn(text, []), 'zzz')).toBe(text);
  });

  test('removes a whole server entry from mcp.servers', () => {
    const text = `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      // the docs one
      "docs": { "type": "remote", "url": "https://docs" },
      "local": {
        "type": "local",
        "command": ["npx", "-y", "thing"]
      }
    }
  }
}
`;
    const next = dropMember(text, objectIn(text, ['mcp', 'servers']), 'local');
    expect(next).toBe(`{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      // the docs one
      "docs": { "type": "remote", "url": "https://docs" }
    }
  }
}
`);
    expect(parseJsonc(next).value).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: { servers: { docs: { type: 'remote', url: 'https://docs' } } },
    });
  });

  test('a comment before the removed key goes with it, one after stays', () => {
    const text = `{
  "a": 1, // about a
  // about b
  "b": 2
}`;
    expect(dropMember(text, objectIn(text, []), 'b')).toBe(`{
  "a": 1 // about a
}`);
  });

  test('a one-line object stays on one line', () => {
    const text = '{ "a": 1, "b": 2 }';
    expect(dropMember(text, objectIn(text, []), 'a')).toBe('{ "b": 2 }');
    expect(dropMember(text, objectIn(text, []), 'b')).toBe('{ "a": 1 }');
  });
});
