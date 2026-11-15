import { describe, expect, test } from 'bun:test';
import { parseJsonc } from './jsonc';
import {
  CONFIG_FILES,
  dropServer,
  editServer,
  filesFor,
  isEnvRef,
  looksSecret,
  markOverridden,
  mask,
  normalizeName,
  readConfig,
  switchUpdates,
  toolNames,
  type ConfigFile,
  type Server,
} from './servers';

const GLOBAL = CONFIG_FILES[0] as ConfigFile;
const PROJECT = CONFIG_FILES[4] as ConfigFile;

const read = (text: string, file: ConfigFile = GLOBAL): Server[] =>
  readConfig(file, text).servers;

const only = (text: string, file: ConfigFile = GLOBAL): Server => {
  const [first, ...rest] = read(text, file);
  if (!first || rest.length > 0) throw new Error(`expected one server, got ${rest.length + 1}`);
  return first;
};

describe('where configs live', () => {
  test('a scope lists its files lowest precedence first', () => {
    expect(filesFor('global').map((file) => file.path)).toEqual([
      '~/.config/opencode/opencode.json',
      '~/.config/opencode/opencode.jsonc',
    ]);
    expect(filesFor('project').map((file) => file.path)).toEqual([
      'opencode.json',
      'opencode.jsonc',
      '.opencode/opencode.json',
      '.opencode/opencode.jsonc',
    ]);
  });
});

describe('reading a config', () => {
  test('finds the V2 servers and reads their fields', () => {
    const server = only(`{
      "mcp": {
        "servers": {
          "docs": {
            "type": "remote",
            "url": "https://mcp.example.com/mcp",
            "headers": { "Authorization": "Bearer abc" },
            "oauth": false,
            "codemode": false,
            "protocol": "auto",
            "pool": true,
            "timeout": { "startup": 45000 }
          }
        }
      }
    }`);
    expect(server.name).toBe('docs');
    expect(server.placement).toBe('servers');
    expect(server.kind).toBe('remote');
    expect(server.url).toBe('https://mcp.example.com/mcp');
    expect(server.headers).toEqual([['Authorization', 'Bearer abc']]);
    expect(server.oauth).toBe('off');
    expect(server.codemode).toBe(false);
    expect(server.protocol).toBe('auto');
    expect(server.pool).toBe(true);
    expect(server.timeout).toEqual([['startup', 45000]]);
    expect(server.on).toBe(true);
    expect(server.scope).toBe('global');
  });

  test('reads a local server, its command, folder and environment', () => {
    const server = only(`{
      "mcp": {
        "servers": {
          "everything": {
            "type": "local",
            "command": ["npx", "-y", "@modelcontextprotocol/server-everything"],
            "cwd": "~",
            "environment": { "LOG_LEVEL": "info", "KEY": "{env:MCP_API_KEY}" }
          }
        }
      }
    }`);
    expect(server.kind).toBe('local');
    expect(server.command).toEqual(['npx', '-y', '@modelcontextprotocol/server-everything']);
    expect(server.cwd).toBe('~');
    expect(server.environment).toEqual([
      ['LOG_LEVEL', 'info'],
      ['KEY', '{env:MCP_API_KEY}'],
    ]);
  });

  test('under mcp.servers only disabled switches a server off', () => {
    const off = only('{"mcp":{"servers":{"a":{"type":"local","command":["x"],"disabled":true}}}}');
    expect(off.on).toBe(false);

    // Checked against OpenCode V2: `enabled` is ignored there, the server runs.
    const ignored = only('{"mcp":{"servers":{"a":{"type":"local","command":["x"],"enabled":false}}}}');
    expect(ignored.on).toBe(true);
    expect(ignored.enabled).toBe(false);
  });

  test('the V1 placement is still found, and there enabled is what counts', () => {
    const servers = read(`{
      "mcp": {
        "old": { "type": "local", "command": ["x"], "enabled": false },
        "timeout": { "startup": 1000 },
        "servers": { "new": { "type": "local", "command": ["y"] } }
      }
    }`);
    expect(servers.map((server) => [server.name, server.placement, server.on])).toEqual([
      ['new', 'servers', true],
      ['old', 'legacy', false],
    ]);
  });

  test('mcp.timeout and anything that is not a server entry are left out', () => {
    expect(read('{"mcp":{"timeout":{"startup":1000}}}')).toEqual([]);
    expect(read('{"mcp":{"servers":{}}}')).toEqual([]);
    expect(read('{"model":"a/b"}')).toEqual([]);
    expect(read('')).toEqual([]);
  });

  test('an entry that is not an object is reported, not hidden', () => {
    const server = only('{"mcp":{"servers":{"a":"https://x"}}}');
    expect(server.broken).toContain('not an object');
    expect(server.kind).toBe('unknown');
    expect(server.on).toBe(false);
  });

  test('a config that does not parse comes back as an error with its line', () => {
    const result = readConfig(GLOBAL, '{\n  "mcp": {\n');
    expect(result.servers).toEqual([]);
    expect(result.error).toContain('~/.config/opencode/opencode.json');
    expect(result.error).toContain('line');
  });

  test('keys OpenCode does not define are listed, not dropped', () => {
    const server = only('{"mcp":{"servers":{"a":{"type":"local","command":["x"],"note":"mine"}}}}');
    expect(server.extraKeys).toEqual(['note']);
    expect(server.raw).toContain('"note":"mine"'); // exactly as written
  });

  test('a server knows the line it starts on', () => {
    const server = only('{\n  "mcp": {\n    "servers": {\n      "a": { "type": "local", "command": ["x"] }\n    }\n  }\n}');
    expect(server.line).toBe(4);
  });

  test('a V1 timeout number is kept apart from the V2 object', () => {
    const server = only('{"mcp":{"servers":{"a":{"type":"remote","url":"https://x","timeout":5000}}}}');
    expect(server.timeoutLegacy).toBe(5000);
    expect(server.timeout).toEqual([]);
  });
});

describe('precedence', () => {
  test('the entry in the file with higher precedence wins', () => {
    const low = read('{"mcp":{"servers":{"a":{"type":"remote","url":"https://low"}}}}', GLOBAL);
    const high = read('{"mcp":{"servers":{"a":{"type":"remote","url":"https://high"}}}}', PROJECT);
    const marked = markOverridden([...low, ...high]);
    expect(marked[0]?.overriddenBy?.path).toBe('.opencode/opencode.json');
    expect(marked[1]?.overriddenBy).toBeNull();
  });

  test('a name configured once is never marked', () => {
    const marked = markOverridden(read('{"mcp":{"servers":{"a":{"type":"local","command":["x"]}}}}'));
    expect(marked[0]?.overriddenBy).toBeNull();
  });
});

describe('tool names', () => {
  test('anything but letters, numbers, _ and - becomes _', () => {
    expect(normalizeName('context 7')).toBe('context_7');
    expect(normalizeName('n8n-mcp')).toBe('n8n-mcp');
    expect(normalizeName('tech.pay/spain')).toBe('tech_pay_spain');
  });

  test('both ways of addressing the tools are spelled out', () => {
    expect(toolNames('context 7')).toEqual({
      codemode: 'tools.context_7.*',
      direct: 'context_7_*',
    });
  });

  test('a name with a dash is only reachable in brackets', () => {
    expect(toolNames('n8n-mcp').codemode).toBe('tools["n8n-mcp"].*');
    expect(toolNames('n8n-mcp').direct).toBe('n8n-mcp_*');
  });
});

describe('secrets', () => {
  test('an {env:NAME} reference is never a secret', () => {
    expect(isEnvRef('{env:MCP_API_KEY}')).toBe(true);
    expect(looksSecret('Authorization', 'Bearer {env:TOKEN}')).toBe(false);
    expect(looksSecret('KEY', '{env:KEY}')).toBe(false);
  });

  test('a credential written into the file is one', () => {
    expect(looksSecret('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).toBe(true);
    expect(looksSecret('CONTEXT7_API_KEY', 'ctx7sk-1234')).toBe(true);
    expect(looksSecret('X-Thing', 'aVeryLongOpaqueLookingValue123456')).toBe(true);
  });

  test('ordinary settings are not', () => {
    expect(looksSecret('LOG_LEVEL', 'info')).toBe(false);
    expect(looksSecret('Accept', 'application/json')).toBe(false);
    expect(looksSecret('EMPTY', '')).toBe(false);
  });

  test('a mask shows enough to recognise a value and no more', () => {
    expect(mask('short')).toBe('••••••');
    expect(mask('abcdefghijkl')).toBe('••••••ijkl');
    expect(mask('abcdefghijkl')).not.toContain('abcd');
  });
});

describe('switching and deleting', () => {
  const config = `{
  "$schema": "https://opencode.ai/config.json",
  // mine
  "model": "anthropic/claude",
  "mcp": {
    "servers": {
      "docs": {
        "type": "remote",
        "url": "https://docs"
      },
      "everything": { "type": "local", "command": ["npx", "-y", "x"] }
    }
  }
}
`;

  test('switching off writes disabled and touches nothing else', () => {
    const server = read(config).find((item) => item.name === 'docs')!;
    const next = editServer(config, server, switchUpdates(server, false));
    expect(next).toBe(`{
  "$schema": "https://opencode.ai/config.json",
  // mine
  "model": "anthropic/claude",
  "mcp": {
    "servers": {
      "docs": {
        "type": "remote",
        "url": "https://docs",
        "disabled": true
      },
      "everything": { "type": "local", "command": ["npx", "-y", "x"] }
    }
  }
}
`);
  });

  test('switching back on removes the key instead of writing false', () => {
    const off = editServer(
      config,
      read(config).find((item) => item.name === 'docs')!,
      switchUpdates(read(config).find((item) => item.name === 'docs')!, false),
    );
    const server = read(off).find((item) => item.name === 'docs')!;
    expect(server.on).toBe(false);
    expect(editServer(off, server, switchUpdates(server, true))).toBe(config);
  });

  test('a V1 entry is switched with enabled, not disabled', () => {
    const text = '{\n  "mcp": {\n    "old": { "type": "local", "command": ["x"] }\n  }\n}';
    const server = only(text);
    expect(switchUpdates(server, false)).toEqual({ enabled: 'false' });
    const off = editServer(text, server, switchUpdates(server, false));
    expect(JSON.parse(off).mcp.old.enabled).toBe(false);
    expect(only(off).on).toBe(false);
  });

  test('deleting removes one entry and leaves the file valid', () => {
    const server = read(config).find((item) => item.name === 'everything')!;
    const next = dropServer(config, server);
    expect(parseJsonc(next).value).toEqual({
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude',
      mcp: { servers: { docs: { type: 'remote', url: 'https://docs' } } },
    });
    expect(next).toContain('// mine');
  });

  test('deleting the last entry leaves an empty servers block', () => {
    const text = '{"mcp":{"servers":{"a":{"type":"local","command":["x"]}}}}';
    expect(JSON.parse(dropServer(text, only(text)))).toEqual({ mcp: { servers: {} } });
  });

  test('an entry that moved away is refused instead of writing to the wrong one', () => {
    const server = read(config).find((item) => item.name === 'docs')!;
    const moved = '{"mcp":{"servers":{"other":{"type":"local","command":["x"]}}}}';
    expect(() => editServer(moved, server, { disabled: 'true' })).toThrow(/no longer/);
    expect(() => dropServer('{"model":"a/b"}', server)).toThrow(/no longer/);
  });
});
