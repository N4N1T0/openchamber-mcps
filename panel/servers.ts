// Where MCP servers are configured, what one looks like once read, and which
// entry wins when two files name the same server.
//
// Everything here is pure: it takes the text of a config file and gives back
// servers, or takes text and gives back edited text. `bun test` covers the
// rules without a host; the file reads and writes are in main.ts.

import {
  dropMember,
  isObject,
  JsoncError,
  lineOf,
  member,
  objectAt,
  parseJsonc,
  setMember,
  type JsonNode,
  type JsonValue,
  type ObjectNode,
} from './jsonc';

export type Scope = 'global' | 'project';

export type ConfigFile = {
  id: string;
  scope: Scope;
  /** As the host wants it: `~/…` for global, project-relative for a project. */
  path: string;
};

/**
 * The config files this panel reads, lowest precedence first.
 *
 * A folder can hold both a `.json` and a `.jsonc`: OpenCode reads both and
 * merges them, and for a name in both the `.jsonc` wins. That was checked with
 * `opencode mcp list` against OpenCode V2, and it is why `.jsonc` follows
 * `.json` here rather than the other way round.
 *
 * OpenCode reads more than these: `opencode.json(c)` in every ancestor folder
 * of the open one, and `OPENCODE_CONFIG`. A server configured there is not
 * listed here, which the README says plainly. Global `~/.config/opencode` is
 * the XDG default; a user who moves `XDG_CONFIG_HOME` is out of reach too,
 * because the panel's file access is declared as fixed paths in the manifest.
 */
export const CONFIG_FILES: ConfigFile[] = [
  { id: 'global', scope: 'global', path: '~/.config/opencode/opencode.json' },
  { id: 'global-jsonc', scope: 'global', path: '~/.config/opencode/opencode.jsonc' },
  { id: 'project', scope: 'project', path: 'opencode.json' },
  { id: 'project-jsonc', scope: 'project', path: 'opencode.jsonc' },
  { id: 'project-dir', scope: 'project', path: '.opencode/opencode.json' },
  { id: 'project-dir-jsonc', scope: 'project', path: '.opencode/opencode.jsonc' },
];

export const filesFor = (scope: Scope): ConfigFile[] =>
  CONFIG_FILES.filter((file) => file.scope === scope);

/**
 * `servers` is V2: `mcp.servers.<name>`, switched with `disabled`. `legacy` is
 * the V1 placement `mcp.<name>`, which OpenCode still loads and which is
 * switched with `enabled` — the two keys are not interchangeable, and which
 * one the switch writes follows from this.
 */
export type Placement = 'servers' | 'legacy';

export type ServerKind = 'local' | 'remote' | 'unknown';

export type Server = {
  name: string;
  scope: Scope;
  file: ConfigFile;
  placement: Placement;
  kind: ServerKind;
  /** `type` as written, which is `kind` unless it is missing or misspelled. */
  type: string | null;
  /** The entry exactly as written in the file. */
  raw: string;
  /** The line the entry starts on, so the panel can point at it. */
  line: number;
  /** False when the config keeps it from connecting. */
  on: boolean;
  /** `disabled`, when the key is there at all. */
  disabled: boolean | null;
  /** `enabled`, which only counts in the V1 placement. */
  enabled: boolean | null;
  url: string | null;
  command: string[] | null;
  cwd: string | null;
  environment: [string, string][];
  headers: [string, string][];
  /** `off` is `oauth: false`; `configured` is an oauth object. */
  oauth: 'default' | 'off' | 'configured';
  /** Code Mode is on unless the entry turns it off. */
  codemode: boolean;
  /** Null when the entry does not set it: `legacy`, or `auto` when pooled. */
  protocol: string | null;
  pool: boolean;
  timeout: [string, number][];
  /** A V1 `timeout: 5000`, which V2 replaced with an object of three. */
  timeoutLegacy: number | null;
  /** Keys this panel does not read, kept as written and listed in the detail. */
  extraKeys: string[];
  /** Set when the entry is not an object, so nothing can be read from it. */
  broken: string | null;
  /** A file with higher precedence has an entry with this name, which replaces this one. */
  overriddenBy: ConfigFile | null;
};

export type ReadResult = {
  file: ConfigFile;
  servers: Server[];
  /** The file is there but could not be read; the panel says so, loudly. */
  error: string | null;
};

const asString = (value: JsonValue | undefined): string | null =>
  typeof value === 'string' ? value : null;

const asBoolean = (value: JsonValue | undefined): boolean | null =>
  typeof value === 'boolean' ? value : null;

/** A record of strings, with anything else shown as the JSON it is. */
const asPairs = (value: JsonValue | undefined): [string, string][] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, item]) => [
    key,
    typeof item === 'string' ? item : JSON.stringify(item),
  ]);
};

const asNumbers = (value: JsonValue | undefined): [string, number][] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    typeof item === 'number' ? [[key, item] as [string, number]] : [],
  );
};

const KNOWN_KEYS = [
  'type',
  'url',
  'command',
  'cwd',
  'environment',
  'headers',
  'oauth',
  'disabled',
  'enabled',
  'codemode',
  'timeout',
  'protocol',
  'pool',
];

/** Keys that mark an object as an MCP server entry rather than another setting. */
const SERVER_SHAPE = ['type', 'url', 'command'];

export const looksLikeServer = (node: JsonNode): boolean =>
  isObject(node) && SERVER_SHAPE.some((key) => key in node.value);

const toServer = (
  text: string,
  file: ConfigFile,
  placement: Placement,
  name: string,
  node: JsonNode,
): Server => {
  const base = {
    name,
    scope: file.scope,
    file,
    placement,
    raw: text.slice(node.start, node.end),
    line: lineOf(text, node.start),
    overriddenBy: null,
  };

  if (!isObject(node)) {
    return {
      ...base,
      kind: 'unknown',
      type: null,
      on: false,
      disabled: null,
      enabled: null,
      url: null,
      command: null,
      cwd: null,
      environment: [],
      headers: [],
      oauth: 'default',
      codemode: true,
      protocol: null,
      pool: false,
      timeout: [],
      timeoutLegacy: null,
      extraKeys: [],
      broken: `${name} is not an object, so OpenCode cannot read it as a server.`,
    };
  }

  const fields = node.value;
  const type = asString(fields.type);
  const command = Array.isArray(fields.command)
    ? fields.command.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    : null;
  const disabled = asBoolean(fields.disabled);
  const enabled = asBoolean(fields.enabled);

  return {
    ...base,
    // Both V1 and V2 require `type`; a missing or misspelled one is reported
    // rather than guessed at from the other keys.
    kind: type === 'local' || type === 'remote' ? type : 'unknown',
    type,
    // Under `mcp.servers` OpenCode reads `disabled` and ignores `enabled`
    // (checked against OpenCode V2, and said again in checks.ts). In the V1
    // placement it is the other way round.
    on: placement === 'servers' ? disabled !== true : enabled !== false,
    disabled,
    enabled,
    url: asString(fields.url),
    command,
    cwd: asString(fields.cwd),
    environment: asPairs(fields.environment),
    headers: asPairs(fields.headers),
    oauth: fields.oauth === false ? 'off' : fields.oauth === undefined ? 'default' : 'configured',
    codemode: asBoolean(fields.codemode) !== false,
    protocol: asString(fields.protocol),
    pool: asBoolean(fields.pool) === true,
    timeout: asNumbers(fields.timeout),
    timeoutLegacy: typeof fields.timeout === 'number' ? fields.timeout : null,
    extraKeys: Object.keys(fields).filter((key) => !KNOWN_KEYS.includes(key)),
    broken: null,
  };
};

/**
 * The servers one config file configures: the V2 ones under `mcp.servers`,
 * then the V1 ones written straight under `mcp`. A file without an `mcp` block
 * simply has none; one that does not parse is reported, never skipped, because
 * a server the panel cannot see is a server the user cannot switch off here.
 */
export const readConfig = (file: ConfigFile, text: string): ReadResult => {
  if (text.trim() === '') return { file, servers: [], error: null };

  let root: JsonNode;
  try {
    root = parseJsonc(text);
  } catch (error) {
    const message =
      error instanceof JsoncError
        ? `${file.path} does not parse: ${error.message} (line ${lineOf(text, error.offset)}).`
        : `${file.path} could not be read.`;
    return { file, servers: [], error: message };
  }

  const mcp = objectAt(root, ['mcp']);
  if (!mcp) return { file, servers: [], error: null };

  const servers: Server[] = [];
  const v2 = member(mcp, 'servers')?.node;
  if (v2 && isObject(v2)) {
    for (const entry of v2.members) {
      servers.push(toServer(text, file, 'servers', entry.key, entry.node));
    }
  }
  for (const entry of mcp.members) {
    if (entry.key === 'servers' || entry.key === 'timeout') continue;
    if (!looksLikeServer(entry.node)) continue;
    servers.push(toServer(text, file, 'legacy', entry.key, entry.node));
  }

  return { file, servers, error: null };
};

/**
 * Mark every server that a later entry with the same name replaces. `found`
 * has to be in precedence order, lowest first; OpenCode replaces the whole
 * server object, not field by field, so the losing entry does nothing at all.
 */
export const markOverridden = (found: Server[]): Server[] => {
  const winner = new Map<string, number>();
  found.forEach((server, index) => winner.set(server.name, index));
  return found.map((server, index) => {
    const at = winner.get(server.name);
    return at === index ? server : { ...server, overriddenBy: found[at!]!.file };
  });
};

/** Alphabetical, the order the list shows them in. */
export const sortServers = (found: Server[]): Server[] =>
  [...found].sort((left, right) => left.name.localeCompare(right.name));

// --------------------------------------------------------------- names, tools

/**
 * OpenCode names a tool `<server>_<tool>` and replaces anything other than
 * letters, numbers, `_` and `-` with `_`, so two servers whose names differ
 * only in a dot or a space end up fighting over one tool namespace.
 */
export const normalizeName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * How the server's tools are addressed under Code Mode, and without it. A
 * normalized name that is not a JavaScript identifier — `n8n-mcp`, with its
 * dash — is only reachable in brackets, which is how the catalog writes it.
 */
export const toolNames = (name: string): { codemode: string; direct: string } => {
  const normalized = normalizeName(name);
  const dotted = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized);
  return {
    codemode: dotted ? `tools.${normalized}.*` : `tools["${normalized}"].*`,
    direct: `${normalized}_*`,
  };
};

// ------------------------------------------------------------------- secrets

export const isEnvRef = (value: string): boolean => /\{env:[^}]+\}/.test(value);

const SECRET_KEY = /(token|secret|password|passwd|api[-_ ]?key|authorization|auth|credential|cookie)/i;
const SECRET_VALUE = /^(?:Bearer\s+\S+|[A-Za-z0-9_\-.=+/]{20,})$/;

/**
 * True when a header or environment value looks like a credential written into
 * the file. `{env:NAME}` never does: that is the shape the panel asks for.
 */
export const looksSecret = (key: string, value: string): boolean => {
  const text = value.trim();
  if (text === '' || isEnvRef(text)) return false;
  return SECRET_KEY.test(key) || SECRET_VALUE.test(text);
};

/** Enough of a value to recognise it, never enough to use it. */
export const mask = (value: string): string =>
  value.length <= 8 ? '••••••' : `••••••${value.slice(-4)}`;

// ------------------------------------------------------------------- editing

const pathOf = (server: Server): string[] =>
  server.placement === 'servers' ? ['mcp', 'servers', server.name] : ['mcp', server.name];

const entryOf = (text: string, server: Server): ObjectNode => {
  const object = objectAt(parseJsonc(text), pathOf(server));
  if (!object) {
    throw new Error(
      `${server.name} is no longer at ${pathOf(server).join('.')} in ${server.file.path}. Reload the panel.`,
    );
  }
  return object;
};

/**
 * Apply `updates` to one server entry: a string is JSON text that replaces or
 * adds the key, `null` removes it. The file is re-read between keys because
 * every edit moves the offsets of everything after it.
 */
export const editServer = (
  text: string,
  server: Server,
  updates: Record<string, string | null>,
): string => {
  let out = text;
  for (const [key, value] of Object.entries(updates)) {
    const entry = entryOf(out, server);
    out = value === null ? dropMember(out, entry, key) : setMember(out, entry, key, value);
  }
  return out;
};

/** What switching a server on or off writes, which depends on where it lives. */
export const switchUpdates = (server: Server, on: boolean): Record<string, string | null> =>
  server.placement === 'servers'
    ? { disabled: on ? null : 'true' }
    : { enabled: on ? null : 'false' };

/** Remove the whole entry from its config file. */
export const dropServer = (text: string, server: Server): string => {
  const parent = objectAt(
    parseJsonc(text),
    server.placement === 'servers' ? ['mcp', 'servers'] : ['mcp'],
  );
  if (!parent) {
    throw new Error(`${server.file.path} no longer holds that block. Reload the panel.`);
  }
  return dropMember(text, parent, server.name);
};
