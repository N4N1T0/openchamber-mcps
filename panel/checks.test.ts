import { describe, expect, test } from 'bun:test';
import { checkServer, type Check } from './checks';
import { CONFIG_FILES, readConfig, type ConfigFile, type Server } from './servers';

const GLOBAL = CONFIG_FILES[0] as ConfigFile;

/** One server out of a config written for the test. */
const serverIn = (entries: string, name = 'a'): Server => {
  const found = readConfig(GLOBAL, `{ "mcp": { ${entries} } }`).servers.find(
    (server) => server.name === name,
  );
  if (!found) throw new Error(`no server called ${name}`);
  return found;
};

const v2 = (entry: string, name = 'a'): Server => serverIn(`"servers": { ${entry} }`, name);

const texts = (checks: Check[]): string => checks.map((check) => check.text).join(' | ');

const run = (server: Server, clashes: string[] = []): Check[] => checkServer({ server, clashes });

describe('an entry that cannot work', () => {
  test('a type that is neither local nor remote', () => {
    expect(texts(run(v2('"a": { "type": "stdio", "url": "https://x" }')))).toContain('No usable "type"');
  });

  test('a remote server without a usable url', () => {
    expect(texts(run(v2('"a": { "type": "remote", "url": "mcp.example.com" }')))).toContain(
      'not an absolute http(s) URL',
    );
  });

  test('a local server without a command', () => {
    expect(texts(run(v2('"a": { "type": "local", "command": [] }')))).toContain('needs a "command"');
  });

  test('an entry that is not an object says only that', () => {
    const checks = run(v2('"a": "https://x"'));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.tone).toBe('error');
  });
});

describe('the switch keys', () => {
  test('enabled under mcp.servers is called out as ignored', () => {
    const checks = run(v2('"a": { "type": "local", "command": ["x"], "enabled": false }'));
    const found = checks.find((check) => check.text.includes('does nothing'));
    expect(found?.tone).toBe('warning');
    expect(found?.text).toContain('connecting despite it');
    expect(found?.fix).toEqual({ dropKey: 'enabled', label: 'Remove "enabled"' });
  });

  test('enabled: true under mcp.servers is noise that can go', () => {
    const found = run(v2('"a": { "type": "local", "command": ["x"], "enabled": true }')).find(
      (check) => check.text.includes('does nothing'),
    );
    expect(found?.text).toContain('It can go.');
  });

  test('the V1 placement explains itself and what to do about it', () => {
    const found = run(serverIn('"a": { "type": "local", "command": ["x"] }')).find((check) =>
      check.text.includes('V1 placement'),
    );
    expect(found?.tone).toBe('warning');
    expect(found?.text).toContain('"enabled" is what switches it');
  });

  test('disabled: false offers to go, since that is the default', () => {
    const found = run(v2('"a": { "type": "local", "command": ["x"], "disabled": false }')).find(
      (check) => check.fix?.dropKey === 'disabled',
    );
    expect(found?.tone).toBe('info');
  });
});

describe('credentials', () => {
  test('a secret written into the file asks for {env:NAME}', () => {
    const found = run(
      v2('"a": { "type": "remote", "url": "https://x", "headers": { "Authorization": "Bearer eyJhbGciOi.abc.def" } }'),
    ).find((check) => check.text.includes('{env:NAME}'));
    expect(found?.tone).toBe('warning');
    expect(found?.text).toContain('headers.Authorization');
  });

  test('an {env:NAME} reference raises nothing', () => {
    expect(
      texts(
        run(
          v2('"a": { "type": "remote", "url": "https://x", "oauth": false, "headers": { "KEY": "{env:MCP_API_KEY}" } }'),
        ),
      ),
    ).not.toContain('{env:NAME}');
  });

  test('a shell variable is named as the mistake it is', () => {
    const found = run(
      v2('"a": { "type": "local", "command": ["x"], "environment": { "TOKEN": "$MCP_TOKEN" } }'),
    ).find((check) => check.text.includes('not expanded'));
    expect(found?.text).toContain('{env:MCP_TOKEN}');
  });

  test('a credential over plain http is a warning, over loopback it is not', () => {
    const open = run(
      v2('"a": { "type": "remote", "url": "http://192.168.0.54/mcp", "headers": { "Authorization": "Bearer {env:T}" } }'),
    );
    expect(texts(open)).toContain('clear text');

    const local = run(
      v2('"a": { "type": "remote", "url": "http://127.0.0.1:5678/mcp", "headers": { "Authorization": "Bearer {env:T}" } }'),
    );
    expect(texts(local)).not.toContain('clear text');
  });

  test('oauth: false with no credential at all leaves nothing to sign in with', () => {
    expect(texts(run(v2('"a": { "type": "remote", "url": "https://x", "oauth": false }')))).toContain(
      'nothing authenticates',
    );
  });

  test('a header credential with OAuth left on suggests turning it off', () => {
    expect(
      texts(
        run(v2('"a": { "type": "remote", "url": "https://x", "headers": { "X-Api-Key": "{env:K}" } }')),
      ),
    ).toContain('"oauth": false');
  });
});

describe('how it runs', () => {
  test('pool without cwd cannot share a local process', () => {
    expect(
      texts(run(v2('"a": { "type": "local", "command": ["x"], "pool": true }'))),
    ).toContain('cannot share one process');
  });

  test('pool with protocol legacy shares nothing', () => {
    expect(
      texts(run(v2('"a": { "type": "remote", "url": "https://x", "pool": true, "protocol": "legacy" }'))),
    ).toContain('turns "pool" into nothing');
  });

  test('codemode off is spelled out as context in every session', () => {
    expect(texts(run(v2('"a": { "type": "remote", "url": "https://x", "codemode": false }')))).toContain(
      'take context in each session',
    );
  });

  test('a V1 timeout number names the V2 shape', () => {
    expect(texts(run(v2('"a": { "type": "remote", "url": "https://x", "timeout": 5000 }')))).toContain(
      'V1 shape',
    );
  });

  test('keys OpenCode does not define are reported as kept and useless', () => {
    expect(texts(run(v2('"a": { "type": "remote", "url": "https://x", "note": "mine" }')))).toContain(
      'Keys OpenCode does not define',
    );
  });
});

describe('names and precedence', () => {
  test('a name that changes on the way to a tool name says so', () => {
    expect(texts(run(v2('"a.b": { "type": "remote", "url": "https://x" }', 'a.b')))).toContain('a_b_<tool>');
  });

  test('two names that end up as one prefix are a warning', () => {
    const checks = run(v2('"a.b": { "type": "remote", "url": "https://x" }', 'a.b'), ['a-b', 'a b']);
    const found = checks.find((check) => check.text.includes('same tool prefix'));
    expect(found?.tone).toBe('warning');
    expect(found?.text).toContain('a-b, a b');
  });

  test('an overridden entry says nothing here is in use', () => {
    const server = v2('"a": { "type": "remote", "url": "https://x" }');
    const checks = run({ ...server, overriddenBy: CONFIG_FILES[4] as ConfigFile });
    const found = checks.find((check) => check.text.includes('higher precedence'));
    expect(found?.tone).toBe('warning');
    expect(found?.text).toContain('.opencode/opencode.json');
  });

  test('a server that is off says what that means for a running session', () => {
    expect(
      texts(run(v2('"a": { "type": "remote", "url": "https://x", "disabled": true }'))),
    ).toContain('Configured but not connected');
  });

  test('an entry with nothing to say raises nothing', () => {
    expect(run(v2('"a": { "type": "remote", "url": "https://x" }'))).toEqual([]);
  });
});
