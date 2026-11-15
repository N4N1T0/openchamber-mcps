# MCPs — an OpenChamber extension

A panel on OpenChamber's rail that lists the MCP servers OpenCode is configured
with, says which of them are switched on, and lets you switch one off, look at
everything it is configured with, and remove it. Your servers stay where
OpenCode keeps them — in `opencode.json` — and this is a front end for that
file, not another place to keep them.

The sister extensions are
[openchamber-agents](https://github.com/N4N1T0/openchamber-agents) and
[openchamber-skills](https://github.com/N4N1T0/openchamber-skills).

## Install

Requirements: OpenChamber 2.7.2 or newer, and OpenCode V2.

1. Click **Install in OpenChamber**, or open OpenChamber's Settings → Extensions
   and add the repository URL `https://github.com/N4N1T0/openchamber-mcps`.

   [**Install in OpenChamber**](openchamber://extensions/install?url=https%3A%2F%2Fgithub.com%2FN4N1T0%2Fopenchamber-mcps)

2. Approve what the extension asks for: your global OpenCode config and the open
   project's files. If the panel says OpenChamber has not granted file access,
   grant it in Settings → Extensions.
3. Open the **MCPs** icon on the rail. The **Global** tab lists
   `~/.config/opencode/opencode.json(c)`; the **Project** tab needs a project
   open.

There is no local service and no network origin: the panel only reads and writes
those config files.

### Updates

OpenChamber tells you when a new version is out, and you update it in Settings →
Extensions. A version is a release tag such as `v1.0.0`. To stay on one version,
add the tag to the install URL: `…/openchamber-mcps#v1.0.0`.

## What it does

- **Lists every configured server**, under two tabs: **Global**
  (`~/.config/opencode/opencode.json` and `.jsonc`) and **Project**
  (`opencode.json(c)` and `.opencode/opencode.json(c)` of the project you have
  open). Each row shows the name, whether it is local or remote, the URL or the
  command, and the file and line it comes from.
- **A switch on each row** keeps a server from connecting, or lets it connect
  again. Off writes `"disabled": true` into that server's entry, and switching
  back on removes the key instead of writing `false`. The row changes
  immediately and only moves back if the write fails, so the list keeps its
  scroll position and your search text.

  The entry itself stays as it is: a server that is off is still configured,
  with its URL, its headers and its sign-in. OpenCode picks the change up
  without a restart; a session that is already running keeps the tools it
  started with.
- **Click a row for the detail**: type, URL or command, working folder, sign-in,
  how its tools are named, Code Mode, protocol, pooling, timeouts, which key
  switches it, its headers and environment, every notice about it, and the
  entry exactly as written in your file.
- **Headers and environment values are masked** when they look like a
  credential, with **Reveal** on the ones you want to see. A `{env:NAME}`
  reference is never masked — that is the shape the panel asks you for.
- **Notices** explain what would make a server misbehave, and say what to do:

  | Notice | Tone | When |
  |---|---|---|
  | No usable `type` | error | neither `local` nor `remote`, so OpenCode skips the entry |
  | A remote server without an absolute http(s) `url` | error | the connection cannot be made |
  | A local server without a `command` | error | there is nothing to start |
  | `enabled` under `mcp.servers` | warning | OpenCode V2 ignores it there; only `disabled` keeps a server off |
  | The V1 placement `mcp.<name>` | warning | still loaded, but switched by `enabled`, not `disabled` |
  | A credential written into the file | warning | config files get copied, shared and committed |
  | A credential over plain `http://` | warning | it crosses the network in clear text |
  | `$VAR` in a header or environment value | warning | a shell variable is not expanded in JSON; `{env:VAR}` is |
  | `oauth: false` with no credential at all | warning | nothing authenticates the server |
  | `pool: true` on a local server without `cwd` | warning | each project starts its own process anyway |
  | A V1 `timeout: 5000` | warning | V2 wants `{ startup, catalog, execution }` |
  | Another file configures the same name | warning | that entry replaces this one whole |
  | Two names that end up with one tool prefix | warning | OpenCode normalizes both to the same thing |
  | A header credential with OAuth left on | info | `oauth: false` stops OpenCode trying to sign in |
  | `codemode: false` | info | every tool of that server takes context in each session |
  | `pool: true` with `protocol: "legacy"` | info | only 2026-07-28 connections are shared |
  | Keys OpenCode does not define for a server | info | kept as written, and ignored |
  | A name that changes on the way to a tool name | info | says what the tools are actually called |
  | `disabled: false` | info | that is the default; offers to remove the key |
  | A server that is off | info | configured but not connected |

  A notice that is one key too many — `enabled` where it does nothing,
  `disabled: false` — carries the button that removes it.
- **Delete** sits in the detail and takes two clicks. It removes that one entry
  from that one file and leaves everything else in it untouched.
- **Search** filters by name, URL or command.
- **Reload** re-reads the files, for when you change them in an editor.

### What the badges mean

| Badge | Meaning |
|---|---|
| `local`, `remote` | A command OpenCode starts, or a URL it connects to |
| `V1 placement` | The entry sits under `mcp` instead of `mcp.servers`; `enabled` is what switches it |
| `overridden` | A file with higher precedence configures the same name, so this entry does nothing |
| `incomplete` | No usable `type`, so OpenCode cannot connect it |
| `replaces the global one` | A project entry with the same name as a global one; the project wins |
| A file path | Which of the scope's config files the entry is in, shown when more than one has servers |

## Which key switches a server, and why it matters

Two shapes of configuration are in the wild, and the key is not the same in
both. Both were checked against OpenCode V2 with `opencode mcp list`, not
guessed from the docs:

| Placement | Switched off with | `enabled` there |
|---|---|---|
| `mcp.servers.<name>` (V2) | `"disabled": true` | **ignored** — the server connects anyway |
| `mcp.<name>` (V1, still loaded) | `"enabled": false` | honoured |

So an `"enabled": false` left under `mcp.servers` after a V1 config was moved
over does nothing at all, and the server it was meant to stop is running. The
panel reports that where it finds it, and the switch always writes the key that
counts for where the entry actually sits.

## Where servers are read from

The same files, in the same order of precedence, that OpenCode merges:

```
~/.config/opencode/opencode.json(c)      global, lowest precedence
<project>/opencode.json(c)
<project>/.opencode/opencode.json(c)     highest
```

A server name is replaced **whole** by a higher-precedence entry — not field by
field — so the losing entry does nothing, which is what the `overridden` badge
means. Use different names for separate connections or accounts.

Not read, so not listed:

- `opencode.json(c)` in folders above the open project, which OpenCode also
  merges, and `OPENCODE_CONFIG`.
- A global config somewhere other than `~/.config/opencode`, such as under a
  moved `XDG_CONFIG_HOME`. The panel's file access is declared as fixed paths in
  its manifest, so it cannot follow an environment variable.
- Servers OpenChamber or another client configures for itself.

## Writing never reformats the rest of your file

The config file is yours: it holds your model, your permissions, your plugins
and your comments. So the panel never re-serializes it. It parses the text into
nodes that remember where they begin and end, and every change splices one span:

- Switching a server writes or removes one key inside that one entry.
- Deleting removes one entry, with the comma that held it in place.
- Comments, key order, indentation (spaces or tabs, whatever the file uses),
  trailing commas and CRLF line endings are kept exactly as they were.
- A key is added on its own line with the indentation of the key before it, and
  an entry written on a single line stays on one line.

`bun test` covers the round trip, including that switching a server off and on
again gives back the original file byte for byte.

JSONC is accepted (`opencode.jsonc`, and comments in a `.json` file too). A file
that does not parse is reported with the line that broke it, and nothing in it
is touched.

## What it asks for, and why

| It asks for | For |
|---|---|
| Project files | Reading and writing `opencode.json(c)` and `.opencode/opencode.json(c)` of the open project |
| `~/.config/opencode/opencode.json` and `.jsonc` | Your global OpenCode config |

The extension declares no network origins and no local service, so nothing it
reads leaves your machine, and it runs with nothing more than the file access
you grant.

## Limits

- **Configuration, not connections.** The panel says what is configured, not
  what is connected right now. It cannot show that a server is unreachable,
  that a sign-in expired, or which tools a server offers; that needs a live
  OpenCode, and this extension talks to no server. Run `opencode mcp list` or
  `/mcps` for connection state.
- **Switching off is not disconnecting.** Off is a config change. A session
  already running keeps the tools it started with, and OpenCode reloads the
  config without a restart.
- **Adding a server is not in the panel.** Use the CLI, which writes the file
  this panel reads:

  ```sh
  opencode mcp add <name> --global --url <url>
  opencode mcp add <name> -- npx -y <package>
  ```

- **Sign-ins live outside the config.** Deleting an entry leaves the OAuth
  credentials OpenCode stored for it; `opencode mcp logout <name>` removes
  those.
- **Permissions are not edited here.** A `permissions` entry can hide or deny a
  server's tools without touching its configuration, and this panel edits
  `mcp`, not `permissions`.
- VS Code and the phone load no extensions.

## Development

Requires [Bun](https://bun.sh) (CI uses the latest).

```sh
bun install
bun test
bunx tsc --noEmit
bunx openchamber-guest-bundle panel/main.ts panel/main.js
bunx openchamber-guest-check
```

After you change `package.json` or its dependencies, run `bun install` and commit
`bun.lock`. CI installs with `--frozen-lockfile` and fails when the lockfile does
not match.

The built `panel/main.js` is committed, because installing an extension never
builds it. CI (`.github/workflows/check.yml`) runs the tests, the type check,
rebuilds the bundle and fails if it differs from the sources, then packages the
extension, so a stale bundle cannot reach anyone. Rebuild and commit
`panel/main.js` after every change to its sources.

| Path | What it is |
|---|---|
| `panel/main.ts` | The panel: list, detail, file reads and writes |
| `panel/jsonc.ts` | Reading and editing JSON/JSONC without disturbing the rest of the file |
| `panel/jsonc.test.ts` | Tests for the parse and for every kind of splice |
| `panel/servers.ts` | Where servers live, what one is once read, precedence, tool names, secrets |
| `panel/servers.test.ts` | Tests for reading, precedence, switching and deleting |
| `panel/checks.ts` | The notices shown in the detail |
| `panel/checks.test.ts` | Tests for each notice |
| `panel/index.html` | The panel's page and its styles |
| `package.json` | The extension manifest: id, name, icon, permissions and filesystem scope |
| `assets/mcps.svg` | The rail icon |

## Licence

MIT. See [LICENSE](LICENSE).
