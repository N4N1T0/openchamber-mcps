import { connectHost, HostRequestError } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountSearchField,
  mountSpinner,
  mountSwitch,
  mountTabs,
} from '@openchamber/sdk/ui';
import { checkServer } from './checks';
import {
  dropServer,
  editServer,
  filesFor,
  isEnvRef,
  looksSecret,
  markOverridden,
  mask,
  readConfig,
  sortServers,
  switchUpdates,
  toolNames,
  type ConfigFile,
  type Scope,
  type Server,
} from './servers';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;

let directory: string | null = null;
let scope: Scope = 'global';
let query = '';
let loading = false;
let loadError: string | null = null;
let servers: Server[] = [];
/** Config files that exist but could not be read; said out loud, never hidden. */
let fileErrors: string[] = [];
/** The files of this scope that exist, so a row is only badged when it helps. */
let present: ConfigFile[] = [];
/** Names configured globally, to mark a project entry that replaces one. */
let globalNames = new Set<string>();
let viewing: {
  server: Server;
  error: string | null;
  /** `headers.X` / `environment.X` the user asked to see in full. */
  revealed: Set<string>;
} | null = null;
let started = false;

const ARROW_LEFT = 'M7.828 11H20v2H7.828l5.364 5.364-1.414 1.414L4 12l7.778-7.778 1.414 1.414z';

const iconSvg = (path: string, size = 14): SVGSVGElement => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
};

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const failure = (error: unknown): string => {
  if (error instanceof HostRequestError) {
    if (error.code === 'NOT_GRANTED') return 'OpenChamber has not granted file access to this extension yet.';
    if (error.code === 'NO_DIRECTORY') return 'Open a project first.';
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
};

/** Two records stand for the same entry when they sit in the same place. */
const same = (left: Server, right: Server): boolean =>
  left.name === right.name && left.file.id === right.file.id && left.placement === right.placement;

// ------------------------------------------------------------------ reading

const readScope = async (
  target: Scope,
): Promise<{ servers: Server[]; errors: string[]; present: ConfigFile[] }> => {
  const found: Server[] = [];
  const errors: string[] = [];
  const files: ConfigFile[] = [];
  /** A refusal, kept in case no file could be read at all: then it is the answer. */
  let refused: unknown = null;

  // In precedence order, lowest first: markOverridden depends on it.
  for (const file of filesFor(target)) {
    let text: string;
    try {
      const info = await host.stat(file.path);
      if (info.kind !== 'file') continue;
      text = (await host.readFile(file.path)).content;
    } catch (error) {
      // A config that is not there configures no servers; one the host refuses
      // to look at is worth reporting when no file could be read at all.
      const code = error instanceof HostRequestError ? error.code : '';
      if (code === 'NOT_GRANTED' || code === 'DENIED' || code === 'NO_DIRECTORY') refused = error;
      continue;
    }
    files.push(file);
    const result = readConfig(file, text);
    if (result.error) errors.push(result.error);
    found.push(...result.servers);
  }

  if (files.length === 0 && refused) throw refused;
  return { servers: sortServers(markOverridden(found)), errors, present: files };
};

const load = async (): Promise<void> => {
  if (scope === 'project' && !directory) {
    servers = [];
    fileErrors = [];
    present = [];
    loadError = null;
    render();
    return;
  }
  loading = true;
  loadError = null;
  render();
  try {
    const read = await readScope(scope);
    servers = read.servers;
    fileErrors = read.errors;
    present = read.present;
    loadError = null;
  } catch (error) {
    servers = [];
    fileErrors = [];
    present = [];
    loadError = failure(error);
  }

  // A project entry replaces the global one of the same name, which is worth
  // saying on the row, so the global names are read alongside.
  if (scope === 'project') {
    try {
      globalNames = new Set((await readScope('global')).servers.map((server) => server.name));
    } catch {
      globalNames = new Set();
    }
  } else {
    globalNames = new Set();
  }

  // Keep the detail open on the entry it was opened for, with fresh values.
  if (viewing) {
    const fresh = servers.find((server) => same(server, viewing!.server));
    if (fresh) viewing = { ...viewing, server: fresh };
    else viewing = null;
  }

  loading = false;
  render();
};

// ------------------------------------------------------------------ writing

/** Apply `updates` to one entry in its own config file, reading it fresh first. */
const write = async (server: Server, updates: Record<string, string | null>): Promise<void> => {
  const { content } = await host.readFile(server.file.path);
  const next = editServer(content, server, updates);
  if (next !== content) await host.writeFile(server.file.path, next);
};

/**
 * Switch a server on or off from the list. `paint` moves the row to that state
 * at once and moves it back if the write fails, so the list is never rebuilt
 * and keeps its scroll position, the search text and the focused switch.
 */
const setOn = async (
  server: Server,
  on: boolean,
  paint: (on: boolean) => void,
): Promise<void> => {
  paint(on);
  try {
    await write(server, switchUpdates(server, on));
  } catch (error) {
    paint(!on);
    await host.toast({ kind: 'error', message: failure(error) });
    return;
  }
  server.on = on;
  if (server.placement === 'servers') server.disabled = on ? null : true;
  else server.enabled = on ? null : false;
  await host.toast({
    kind: 'success',
    message: on
      ? `${server.name} connects again. OpenCode picks the config up without a restart.`
      : `${server.name} stays configured but will not connect. A session already running keeps the tools it started with.`,
  });
};

const report = async (message: string): Promise<void> => {
  if (viewing) {
    viewing.error = message;
    render();
  } else {
    await host.toast({ kind: 'error', message });
  }
};

/** Remove one key from an entry, for the notices that offer it. */
const dropKey = async (server: Server, key: string): Promise<void> => {
  try {
    await write(server, { [key]: null });
  } catch (error) {
    await report(failure(error));
    return;
  }
  await host.toast({ kind: 'success', message: `Removed "${key}" from ${server.name}.` });
  await load();
};

/** Remove the whole entry from its config file. Nothing else in the file moves. */
const remove = async (server: Server): Promise<void> => {
  try {
    const { content } = await host.readFile(server.file.path);
    await host.writeFile(server.file.path, dropServer(content, server));
  } catch (error) {
    await report(failure(error));
    return;
  }
  viewing = null;
  await host.toast({
    kind: 'success',
    message:
      server.kind === 'remote'
        ? `Removed ${server.name} from ${server.file.path}. A sign-in OpenCode stored for it lives outside the config: opencode mcp logout ${server.name}.`
        : `Removed ${server.name} from ${server.file.path}.`,
  });
  await load();
};

// ---------------------------------------------------------------- list view

const open = (server: Server): void => {
  viewing = { server, error: null, revealed: new Set() };
  render();
};

/** What the row says under the name: where the server is, in one line. */
const summary = (server: Server): string => {
  if (server.kind === 'remote') return server.url ?? 'no url';
  if (server.command && server.command.length > 0) return server.command.join(' ');
  return 'no command';
};

const paintRows = (into: HTMLElement): void => {
  into.replaceChildren();

  if (loading) {
    mountSpinner(into, { label: 'Reading the config…' });
    return;
  }
  if (loadError) {
    mountBanner(into, { tone: 'error', title: 'Could not read the config', body: loadError });
    return;
  }
  if (scope === 'project' && !directory) {
    mountEmpty(into, {
      title: 'No project open',
      body: 'A project configures its servers in opencode.json or .opencode/opencode.json.',
    });
    return;
  }

  for (const message of fileErrors) {
    const holder = el('div');
    into.append(holder);
    mountBanner(holder, { tone: 'error', title: 'A config file did not parse', body: message });
  }

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? servers.filter(
        (server) =>
          server.name.toLowerCase().includes(needle) ||
          summary(server).toLowerCase().includes(needle),
      )
    : servers;

  if (shown.length === 0) {
    mountEmpty(into, {
      title: servers.length === 0 ? 'No MCP servers here' : 'Nothing matches',
      body:
        servers.length === 0
          ? scope === 'global'
            ? 'Add one from a terminal: opencode mcp add <name> --global --url <url>. It lands in ~/.config/opencode/opencode.json and shows up here.'
            : 'Global servers apply to this project too. Add a project one with: opencode mcp add <name> --url <url>.'
          : 'Clear the search to see every server.',
    });
    return;
  }

  // Only worth naming the file on a row when this scope reads from more than one.
  const manyFiles = present.length > 1;

  const rows = el('div', 'rows');
  for (const server of shown) {
    const row = el('div', 'row');
    row.dataset.off = String(!server.on || server.overriddenBy !== null);

    const main = el('button', 'row-main');
    main.type = 'button';
    const top = el('div', 'row-top');
    top.append(el('span', 'row-name', server.name));
    mountBadge(top, { label: server.kind, tone: 'neutral' });
    if (manyFiles) mountBadge(top, { label: server.file.path, tone: 'neutral' });
    if (server.placement === 'legacy') mountBadge(top, { label: 'V1 placement', tone: 'warning' });
    if (server.overriddenBy) mountBadge(top, { label: 'overridden', tone: 'warning' });
    if (server.broken || server.kind === 'unknown') {
      mountBadge(top, { label: 'incomplete', tone: 'error' });
    }
    if (scope === 'project' && globalNames.has(server.name) && !server.overriddenBy) {
      mountBadge(top, { label: 'replaces the global one', tone: 'info' });
    }
    main.append(top);
    main.append(el('div', 'row-desc', summary(server)));
    main.append(el('div', 'row-id', `${server.file.path}:${server.line}`));
    main.addEventListener('click', () => open(server));

    const side = el('div', 'row-side');
    const frozen = server.overriddenBy !== null;
    const toggle = mountSwitch(side, {
      label: server.on ? 'On' : 'Off',
      checked: server.on,
      disabled: frozen,
      onChange: (checked) => {
        void setOn(server, checked, paint);
      },
    });
    const paint = (on: boolean): void => {
      row.dataset.off = String(!on);
      toggle.update({ label: on ? 'On' : 'Off', checked: on });
    };

    row.append(main, side);
    rows.append(row);
  }
  into.append(rows);
};

const renderList = (): void => {
  const bar = el('div', 'bar');
  root.append(bar);

  const tabsHolder = el('div');
  bar.append(tabsHolder);
  const tabs = mountTabs(tabsHolder, {
    items: [
      { id: 'global', label: 'Global' },
      { id: 'project', label: 'Project' },
    ],
    activeId: scope,
    onChange: (next) => {
      scope = next as Scope;
      tabs.update({ activeId: scope });
      void load();
    },
  });

  bar.append(el('div', 'grow'));
  const reloadHolder = el('div');
  bar.append(reloadHolder);
  mountButton(reloadHolder, {
    label: 'Reload',
    variant: 'ghost',
    size: 'sm',
    onClick: () => {
      void load();
    },
  });

  const searchHolder = el('div');
  root.append(searchHolder);
  const rowsHolder = el('div');
  root.append(rowsHolder);

  mountSearchField(searchHolder, {
    value: query,
    placeholder: 'Search servers',
    onChange: (next) => {
      query = next;
      paintRows(rowsHolder); // keeps the field focused while typing
    },
  });

  paintRows(rowsHolder);

  root.append(
    el(
      'div',
      'muted',
      scope === 'global'
        ? '~/.config/opencode/opencode.json(c) · Off writes "disabled": true, so OpenCode stops connecting the server and its entry stays as it is.'
        : 'opencode.json(c) and .opencode/opencode.json(c) of this project · global servers apply here too, and a project entry of the same name replaces one.',
    ),
  );
};

// -------------------------------------------------------------- detail view

const fact = (into: HTMLElement, label: string, value: string | Node): void => {
  into.append(el('dt', undefined, label));
  const cell = el('dd', typeof value === 'string' ? undefined : 'plain');
  if (typeof value === 'string') cell.textContent = value;
  else cell.append(value);
  into.append(cell);
};

/**
 * A header or environment value. A credential written into the file is masked
 * until the user asks for it; an `{env:NAME}` reference is shown as it is,
 * because that is the shape the checks ask for.
 */
const valueCell = (kind: 'headers' | 'environment', key: string, value: string): Node => {
  const current = viewing!;
  const id = `${kind}.${key}`;
  const hidden = looksSecret(key, value) && !current.revealed.has(id);
  const wrap = el('div', 'secret');
  wrap.append(el('span', 'mono', hidden ? mask(value) : value));
  if (isEnvRef(value)) mountBadge(wrap, { label: 'from the environment', tone: 'success' });
  if (looksSecret(key, value)) {
    const holder = el('span');
    wrap.append(holder);
    mountButton(holder, {
      label: hidden ? 'Reveal' : 'Hide',
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        if (hidden) current.revealed.add(id);
        else current.revealed.delete(id);
        render();
      },
    });
  }
  return wrap;
};

const pairSection = (
  into: HTMLElement,
  title: string,
  kind: 'headers' | 'environment',
  pairs: [string, string][],
): void => {
  if (pairs.length === 0) return;
  const section = el('div', 'section');
  section.append(el('div', 'section-title', title));
  const list = el('dl', 'facts');
  for (const [key, value] of pairs) fact(list, key, valueCell(kind, key, value));
  section.append(list);
  into.append(section);
};

const renderDetail = (): void => {
  const current = viewing!;
  const { server } = current;
  const tools = toolNames(server.name);

  const bar = el('div', 'bar');
  const backHolder = el('div');
  bar.append(backHolder);
  mountButton(backHolder, {
    label: 'Back',
    variant: 'ghost',
    size: 'sm',
    onClick: () => {
      viewing = null;
      render();
    },
  });
  // The kit's button only repaints its label span, so an icon prepended here stays.
  backHolder.querySelector('button')?.prepend(iconSvg(ARROW_LEFT));
  bar.append(el('div', 'grow'));
  bar.append(el('div', 'muted mono', `${server.file.path}:${server.line}`));
  root.append(bar);

  if (current.error) {
    const banner = el('div');
    root.append(banner);
    mountBanner(banner, { tone: 'error', title: current.error });
  }

  const head = el('div', 'head');
  head.append(el('span', 'head-name', server.name));
  mountBadge(head, { label: server.on ? 'On' : 'Off', tone: server.on ? 'success' : 'neutral' });
  mountBadge(head, { label: server.kind, tone: 'neutral' });
  if (server.placement === 'legacy') mountBadge(head, { label: 'V1 placement', tone: 'warning' });
  if (server.overriddenBy) mountBadge(head, { label: 'overridden', tone: 'warning' });
  root.append(head);

  const facts = el('dl', 'facts');
  root.append(facts);
  if (server.kind === 'unknown') fact(facts, 'Type', server.type ?? 'missing');
  if (server.url !== null) fact(facts, 'URL', server.url);
  if (server.command !== null) fact(facts, 'Command', server.command.join(' '));
  if (server.cwd) fact(facts, 'Runs in', server.cwd);
  if (server.kind === 'remote') {
    fact(
      facts,
      'Sign-in',
      server.oauth === 'off'
        ? 'oauth: false — headers only'
        : server.oauth === 'configured'
          ? 'OAuth, with client settings in the entry'
          : 'OAuth, discovered by OpenCode',
    );
  }
  fact(facts, 'Tools', `${tools.codemode}  ·  without Code Mode: ${tools.direct}`);
  fact(facts, 'Code Mode', server.codemode ? 'on' : 'off — tools go on the model’s own list');
  if (server.protocol) fact(facts, 'Protocol', server.protocol);
  if (server.pool) fact(facts, 'Pooled', 'one connection shared between directories');
  for (const [key, value] of server.timeout) fact(facts, `Timeout · ${key}`, `${value} ms`);
  if (server.timeoutLegacy !== null) fact(facts, 'Timeout', `${server.timeoutLegacy} ms`);
  fact(
    facts,
    'Switched by',
    server.placement === 'servers'
      ? `"disabled"${server.disabled === null ? ' — not set, so it connects' : `: ${server.disabled}`}`
      : `"enabled"${server.enabled === null ? ' — not set, so it connects' : `: ${server.enabled}`}`,
  );

  pairSection(root, 'Headers', 'headers', server.headers);
  pairSection(root, 'Environment', 'environment', server.environment);

  const checks = el('div', 'checks');
  root.append(checks);
  const clashes = servers
    .filter(
      (other) =>
        !same(other, server) && toolNames(other.name).direct === tools.direct,
    )
    .map((other) => other.name);
  for (const check of checkServer({ server, clashes })) {
    const holder = el('div');
    checks.append(holder);
    mountBanner(holder, {
      tone: check.tone,
      title: check.text,
      action: check.fix
        ? {
            label: check.fix.label,
            onClick: () => {
              void dropKey(server, check.fix!.dropKey);
            },
          }
        : undefined,
    });
  }

  const raw = el('div', 'section');
  raw.append(el('div', 'section-title', 'The entry as written'));
  raw.append(el('pre', 'block', server.raw));
  root.append(raw);

  const foot = el('div', 'foot');
  root.append(foot);
  const copyHolder = el('div');
  foot.append(copyHolder);
  mountButton(copyHolder, {
    label: 'Copy the entry',
    variant: 'ghost',
    size: 'sm',
    onClick: () => {
      void host
        .writeClipboard(server.raw)
        .then(() => host.toast({ kind: 'success', message: 'Copied.' }))
        .catch(async (error: unknown) => {
          await host.toast({ kind: 'error', message: failure(error) });
        });
    },
  });
  foot.append(el('div', 'grow'));

  const deleteHolder = el('div');
  foot.append(deleteHolder);
  let armed = false;
  const deleteButton = mountButton(deleteHolder, {
    label: 'Delete',
    variant: 'destructive',
    size: 'sm',
    onClick: () => {
      if (!armed) {
        // First click arms it, the second one deletes: no dialog to mis-click.
        armed = true;
        deleteButton.update({ label: `Remove ${server.name} from the config?` });
        return;
      }
      deleteButton.update({ label: 'Removing…', loading: true });
      void remove(server);
    },
  });

  root.append(
    el(
      'div',
      'muted',
      'Deleting takes the entry out of this file and leaves everything else in it untouched. A sign-in OpenCode stored for the server is kept outside the config; remove it with opencode mcp logout <name>.',
    ),
  );
};

/** The credit line under both views. The sandboxed frame cannot open a link itself, so the host does. */
const footer = (): HTMLElement => {
  const foot = el('div', 'site-foot');
  const link = el('a', undefined, 'built with love by nano');
  link.href = 'https://www.adrian-alvarez.com/en/';
  link.addEventListener('click', (event) => {
    event.preventDefault();
    void host.openUrl(link.href).catch(async (error: unknown) => {
      await host.toast({ kind: 'error', message: failure(error) });
    });
  });
  foot.append(link);
  return foot;
};

const render = (): void => {
  root.replaceChildren();
  if (viewing) renderDetail();
  else renderList();
  root.append(footer());
};

host.onDirectory((next) => {
  const changed = next !== directory;
  directory = next;
  if (!started) return;
  if (changed && scope === 'project') void load();
  else if (changed) render();
});

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  directory = context.directory;
  if (started) return;
  started = true;
  void load();
});
