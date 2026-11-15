// What is worth saying about one MCP server entry. Pure, so `bun test` can
// cover every rule without a host.
//
// What it can know: what the entry says, and which entries the panel loaded
// from the config files it reads. What it cannot know: whether the server is
// reachable, whether a sign-in is still valid, what tools it offers, or what
// an ancestor folder's config adds. Those limits are in the README, not
// guessed at here.
//
// Two rules below come from checking OpenCode V2 rather than from reading its
// docs, and the wording says so where it matters:
//   * under `mcp.servers`, `enabled` does nothing — only `disabled` keeps a
//     server from connecting;
//   * the V1 placement `mcp.<name>` is still loaded, and there `enabled: false`
//     does keep it off.

import { looksSecret, normalizeName, type Server } from './servers';

export type Tone = 'error' | 'warning' | 'info';

/**
 * A check, and for the few that are one key too many, what removing it is
 * called. The panel turns `fix` into a button on the notice; nothing here
 * writes anything itself.
 */
export type Check = {
  tone: Tone;
  text: string;
  fix?: { dropKey: string; label: string };
};

export type CheckInput = {
  server: Server;
  /** Other loaded server names that end up with the same tool prefix. */
  clashes: string[];
};

const credentialHeaders = (server: Server): string[] =>
  server.headers
    .filter(([key]) => /(authorization|token|key|secret|api)/i.test(key))
    .map(([key]) => key);

const literalSecrets = (server: Server): string[] => [
  ...server.headers.filter(([key, value]) => looksSecret(key, value)).map(([key]) => `headers.${key}`),
  ...server.environment
    .filter(([key, value]) => looksSecret(key, value))
    .map(([key]) => `environment.${key}`),
];

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\]|::1)$/i;

export const checkServer = ({ server, clashes }: CheckInput): Check[] => {
  const out: Check[] = [];

  if (server.broken) {
    out.push({ tone: 'error', text: server.broken });
    return out;
  }

  // ---- is the entry even usable

  if (server.kind === 'unknown') {
    out.push({
      tone: 'error',
      text: `No usable "type"${
        server.type === null ? '' : `: ${JSON.stringify(server.type)}`
      }. It has to be "local" (a command) or "remote" (a URL), and OpenCode skips the entry without one.`,
    });
  }
  if (server.kind === 'remote') {
    if (!server.url) {
      out.push({ tone: 'error', text: 'A remote server needs an absolute "url".' });
    } else if (!/^https?:\/\/\S+$/i.test(server.url)) {
      out.push({
        tone: 'error',
        text: `"${server.url}" is not an absolute http(s) URL, so the connection cannot be made.`,
      });
    }
  }
  if (server.kind === 'local' && (!server.command || server.command.length === 0)) {
    out.push({
      tone: 'error',
      text: 'A local server needs a "command": the executable and its arguments.',
    });
  }

  // ---- placement and the switch

  if (server.placement === 'legacy') {
    out.push({
      tone: 'warning',
      text: `This entry sits under "mcp" instead of "mcp.servers", which is the V1 placement. OpenCode still loads it, and there "enabled" is what switches it, so that is what this panel writes. Move it under "mcp.servers" and use "disabled" to be on V2.`,
    });
  }
  if (server.placement === 'servers' && server.enabled !== null) {
    out.push({
      tone: 'warning',
      text: `"enabled": ${server.enabled} does nothing under "mcp.servers" — OpenCode V2 reads "disabled" there and ignores "enabled". ${
        server.enabled === false
          ? 'This server is connecting despite it. Switch it off here to write "disabled": true.'
          : 'It can go.'
      }`,
      fix: { dropKey: 'enabled', label: 'Remove "enabled"' },
    });
  }
  if (server.placement === 'servers' && server.disabled === false) {
    out.push({
      tone: 'info',
      text: '"disabled": false is the default. Switching the server on removes the key instead of writing it.',
      fix: { dropKey: 'disabled', label: 'Remove "disabled"' },
    });
  }

  // ---- what reaches the server

  const literals = literalSecrets(server);
  if (literals.length > 0) {
    out.push({
      tone: 'warning',
      text: `${literals.join(', ')} ${
        literals.length === 1 ? 'holds' : 'hold'
      } a value written into the config file. Config files get copied, shared and committed; put the secret in an environment variable and write {env:NAME} here.`,
    });
  }

  if (server.kind === 'remote' && server.url) {
    const host = /^https?:\/\/([^/:]+)/i.exec(server.url)?.[1] ?? '';
    const credentials = credentialHeaders(server);
    if (server.url.toLowerCase().startsWith('http://') && !LOOPBACK.test(host) && credentials.length > 0) {
      out.push({
        tone: 'warning',
        text: `${credentials.join(', ')} ${
          credentials.length === 1 ? 'crosses' : 'cross'
        } the network in clear text: the URL is http://, not https://.`,
      });
    }
    if (server.oauth === 'off' && credentials.length === 0 && server.headers.length === 0) {
      out.push({
        tone: 'warning',
        text: 'OAuth is off and no header carries a credential, so nothing authenticates this server. Remove "oauth": false to let OpenCode sign in, or add the key the server expects.',
      });
    }
    if (server.oauth === 'default' && credentials.length > 0) {
      out.push({
        tone: 'info',
        text: `OAuth is on by default for a remote server. When ${credentials.join(', ')} is all this one needs, add "oauth": false so OpenCode stops trying to sign in.`,
      });
    }
  }

  for (const [key, value] of [...server.headers, ...server.environment]) {
    if (/^\$[A-Za-z_]/.test(value.trim())) {
      out.push({
        tone: 'warning',
        text: `${key} is "${value.trim()}". A shell variable is not expanded in a JSON string; write {env:${value.trim().replace(/^\$\{?/, '').replace(/\}$/, '')}} instead.`,
      });
    }
  }

  // ---- how it is run

  if (server.pool && server.kind === 'local' && !server.cwd) {
    out.push({
      tone: 'warning',
      text: '"pool": true without a "cwd" cannot share one process: a local server runs in each project\'s folder, so each project starts its own. Set "cwd", such as "~".',
    });
  }
  if (server.pool && server.protocol === 'legacy') {
    out.push({
      tone: 'info',
      text: 'Only connections on the 2026-07-28 revision are shared, so "protocol": "legacy" turns "pool" into nothing. Leave "protocol" out and it means "auto" when pooled.',
    });
  }
  if (!server.codemode) {
    out.push({
      tone: 'info',
      text: '"codemode": false puts every tool of this server on the model\'s own tool list, so they all take context in each session. Leave it out to keep them behind Code Mode.',
    });
  }
  if (server.timeoutLegacy !== null) {
    out.push({
      tone: 'warning',
      text: `"timeout": ${server.timeoutLegacy} is the V1 shape. V2 wants an object: { "startup": …, "catalog": …, "execution": … } in milliseconds.`,
    });
  }
  if (server.extraKeys.length > 0) {
    out.push({
      tone: 'info',
      text: `Keys OpenCode does not define for a server: ${server.extraKeys.join(', ')}. They are kept exactly as written and have no effect.`,
    });
  }

  // ---- names and precedence

  if (clashes.length > 0) {
    out.push({
      tone: 'warning',
      text: `${clashes.join(', ')} ${
        clashes.length === 1 ? 'ends' : 'end'
      } up with the same tool prefix "${normalizeName(server.name)}_", because OpenCode replaces anything but letters, numbers, _ and - in a server name. Rename one.`,
    });
  } else if (normalizeName(server.name) !== server.name) {
    out.push({
      tone: 'info',
      text: `Its tools are named "${normalizeName(server.name)}_<tool>": OpenCode replaces anything but letters, numbers, _ and - in a server name.`,
    });
  }

  if (server.overriddenBy) {
    out.push({
      tone: 'warning',
      text: `${server.overriddenBy.path} configures ${server.name} too and has higher precedence. It replaces this whole entry — not field by field — so nothing here is in use.`,
    });
  }

  if (!server.on && !server.overriddenBy) {
    out.push({
      tone: 'info',
      text: 'Configured but not connected. OpenCode picks the change up without a restart; a session that is already running keeps the tools it started with.',
    });
  }

  return out;
};
