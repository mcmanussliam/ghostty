# Experimental Ghostty plugins

This fork adds opt-in **macOS** plugins with a TypeScript host and SDK,
pre/post middleware hooks, a native bottom status bar, plugin
commands, and resizable HTML/React side panes. The terminal parser, input stack,
and Metal renderer remain Ghostty's existing implementation.

This is a fork feature, not an upstream Ghostty plugin API. API version 1 is
experimental. Linux/GTK integration is not implemented yet.

## Try the Git plugin

1. Install Node.js **22 or newer** and Git. Find your Node executable with
   `command -v node`; GUI apps should use an absolute path rather than rely on
   your shell's `PATH`.
   Development tooling requires Node **22.13 or newer**.
2. Build and run this branch's macOS application using Ghostty's normal tooling:

   ```sh
   npm --prefix plugins ci --ignore-scripts
   zig build -Demit-macos-app=false
   macos/build.nu --configuration Debug --action build
   open macos/build/Debug/Ghostty.app
   ```

   See [HACKING.md](../HACKING.md) for Zig, Xcode, Metal, and Nushell prerequisites.
   Debug builds are deliberately slower; use a ReleaseLocal build for performance
   comparisons. The Zig app build and `macos/build.nu` compile TypeScript first; Xcode packages
   `plugins/dist/host`. Before building directly in Xcode, run
   `npm --prefix plugins run build`.

3. Create `~/.config/ghostty/plugins.json`, substituting **your actual absolute
   paths**:

   ```json
   {
     "version": 1,
     "nodePath": "/opt/homebrew/bin/node",
     "plugins": [
       {
         "path": "/Users/you/src/ghostty/plugins/examples/git-status",
         "enabled": true,
         "settings": {
           "autoOpen": true,
           "pollIntervalMs": 4000
         }
       }
     ]
   }
   ```

   The macOS Application Support directory is also supported:
   `~/Library/Application Support/com.mitchellh.ghostty/plugins.json`.
   The XDG file takes precedence when present. `XDG_CONFIG_HOME` changes the XDG
   location. `GHOSTTY_PLUGIN_CONFIG` can select a different absolute config path
   when launching from a shell. Plugins use a separate JSON file so the fork
   does not introduce unknown keys into Ghostty's shared Zig configuration.

4. Validate the example and configuration without executing plugin code:

   ```sh
   node plugins/dist/host/cli.mjs validate "$PWD/plugins/examples/git-status"
   node plugins/dist/host/cli.mjs check-config "$HOME/.config/ghostty/plugins.json"
   ```

5. Reload Ghostty's configuration, or restart the built app. Enter a local Git
   repository. The bottom bar shows the branch and change count; a Git Changes
   pane opens beside the terminal. Click the status item to reopen it.

The example refreshes on directory changes, command completion, its Refresh
button, and every four seconds. Set `pollIntervalMs` to `0` to disable polling;
positive intervals have a four-second minimum. Set `autoOpen` to `false` for a
status-only default. Closing the pane remembers your choice for that repo in
that window/tab until plugin reload, even when navigating away and back.
Changing the focused split makes the window's plugin context follow that split.
Refresh bursts coalesce into one running query and one follow-up per context.
Changing context cancels obsolete Git subprocesses; ordinary refreshes reuse the
discovered repository root for up to 30 seconds. Command completion and manual
refresh recheck repository identity immediately. A shared queue starts at most
20 refreshes per second, with at most four Git subprocesses running across tabs.

Existing shell integration must report the working directory; command-completion
events likewise depend on supported shell integration. No command text or raw
terminal output is sent to plugins. The Git example interprets directories on
the **local machine**; it does not implement remote SSH repository discovery.

## Trust and installation

Only explicitly enabled directories in your config are loaded. A project cannot
install or activate a plugin merely by containing a manifest. Disabled entries
are not read or imported. No configuration, or no enabled plugins, means no Node
host and no webviews are started.

**Install only plugins you trust.** Plugin logic runs as your user in a separate
Node process and can use Node's filesystem, network, and subprocess APIs.
Declared capabilities restrict the Ghostty host API; they are **not an OS
sandbox** for Node code. Process isolation protects the native UI from plugin
crashes/stalls, not your files from deliberately harmful plugins. Pane webviews
use an ephemeral data store, block HTTP/WebSocket resources and external
navigation, and communicate with their owning plugin through JSON messages.

## Create a plugin

A plugin is a directory containing:

```text
plugin.json
index.mjs
view.html       (optional, for a custom pane)
```

Use an ESM `.mjs` entry, or `.js` with the appropriate `package.json` module
setting. TypeScript authors install the SDK locally and compile/bundle to ESM:

```sh
npm install /absolute/path/to/ghostty/plugins/sdk
```

The SDK has no runtime dependencies. `definePlugin` preserves type inference:

```ts
import { definePlugin } from "@ghostty/plugin-sdk";

export default definePlugin({
  activate(api) {
    api.on("context.changed", async ({ context }, next) => {
      await api.ui.statusBar.set({
        id: "cwd",
        contextId: context.id,
        revision: context.revision,
        alignment: "left",
        text: context.cwd,
        tooltip: "Current working directory",
      });
      return next();
    });
  },
});
```

Its manifest would be:

```json
{
  "id": "directory-status",
  "name": "Directory Status",
  "version": "0.1.0",
  "apiVersion": 1,
  "capabilities": ["context", "ui.statusBar"],
  "main": "index.mjs"
}
```

IDs are namespaced by plugin and limited to 96 ASCII identifier characters.
Supported capabilities are `context`, `commands`, `shell.command.finished`,
`ui.statusBar`, and `ui.panes`. The worker checks hook declarations and the
supervisor checks API calls. All manifest and pane entry files must resolve
inside the plugin directory, including through symlinks.

## Hooks and commands

`api.on(event, handler, { priority })` registers middleware. Lower priorities run
first; equal priorities keep registration order. Inputs are deeply frozen. Call
`next()` once to continue, or `next({ ...event, changedField })` to transform
supported action inputs. Code before the call is a pre hook; code after awaiting
it is a post hook. Returning without calling `next` suppresses the remaining
handlers and core action in that plugin's chain.

```ts
api.on("ui.pane.close", async (event, next) => {
  if (event.id === "notes" && hasUnsavedNotes()) {
    return { cancel: true }; // Core close does not run.
  }
  const result = await next();
  await api.log(`Closed ${event.id}`);
  return result;
});
```

Supported events:

| Event                               | Meaning                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| `session.start`, `session.end`      | Plugin activation/reload and best-effort shutdown               |
| `context.changed`, `context.closed` | Focused terminal/cwd changed, or window/tab closed              |
| `shell.command.finished`            | Shell reported exit code (or null) and duration in milliseconds |
| `command.run`                       | A command registered by this plugin is about to run             |
| `ui.status.press`                   | Native status item clicked; core invokes its command            |
| `ui.status.update`                  | This plugin calls `statusBar.set`                               |
| `ui.pane.open`, `ui.pane.close`     | Pane opening/closing; close includes `person`/`plugin` reason   |
| `ui.pane.message`                   | JSON message from the owning pane                               |

Hooks are plugin-local; one plugin cannot rewrite another plugin's hooks or
core terminal behavior. Cwd and command-finished events are notifications, not
cancellable shell execution. Terminal/window close interception, pre-execution
shell hooks, and arbitrary native UI replacements are future extension points.
`next()` on pane actions commits supervisor state; the native UI applies the
subsequent batched snapshot asynchronously.

Register commands with `api.commands.register({ id, title, run })`. Commands
appear in the status bar's Plugins menu and can be attached to a status item's
`command`. A registered command can also run through `api.commands.run`.

## Custom panes

```ts
await api.ui.panes.register({
  id: "changes",
  title: "Changes",
  entry: "dist/view.html",
  width: 320,
  retainOnContextChange: true,
});
await api.ui.panes.open("changes", context.id, {
  revision: context.revision,
  data: { files: [] },
});
await api.ui.panes.publish(
  "changes",
  context.id,
  { files: [] },
  {
    revision: context.revision,
  },
);
```

Entries are local HTML files. Bundle React and all assets locally, with relative
asset paths; network CDNs and remote navigation are blocked. An entry can use:

```js
const unsubscribe = window.ghostty.onState(({ context, data }) => {
  // Render data, for example by updating React state.
});
window.ghostty.send({ action: "refresh" });
```

`send` generates `ui.pane.message` only for the owning plugin and context.
`onState` receives the latest context and published JSON after the document loads.
The host creates webviews only for open panes. The native `HSplitView` supplies
resizing and the title/close control. Initial support docks panes on the right;
other placements and saved layouts are planned.

Pass `data` to `open` to commit initial content with the pane, avoiding an empty
first snapshot. Pane chrome follows the focused terminal's background and colour
scheme. Views can use the CSS variable `--ghostty-background` to match it.

By default, focus/cwd changes close panes and clear statuses. Opt in to
`retainOnContextChange` to reuse a pane's webview and split width: old data becomes
`null` and native chrome hides content while the new context is loading. Handle
`context.changed` and call `open` with new data, `publish`, or `close` to settle the
pane. Retained webviews still disappear when their context closes or plugins
reload; there is no cache of closed panes.

Manual close prevents automatic reopening at the same terminal/cwd. An explicit
user command may pass `{ reveal: true }` to reopen. The Git example additionally
remembers dismissal by repo root. Use `revision` for every UI write that follows
async work: stale revisions return `{ stale: true }` and never overwrite the
current terminal's UI. Closed context IDs are rejected.

## Reload, limits, and performance

Edit a plugin, then select **Plugins → Reload Plugins**, or reload Ghostty's
configuration. Reload starts fresh child processes, imports updated files,
clears old UI, and replays current contexts. Roll back a plugin by restoring its
previous files/version and reloading. Automatic filesystem hot reload, a plugin
marketplace, and persistent plugin storage are not implemented in this version.

The supervisor allows 16 plugins, 128 window/tab contexts, 32 status items and
four open panes per context, 128 commands in total, eight pane types per plugin,
and a 64-discrete-event queue per plugin, with room for one coalesced context
update per supported context. Plugin processes have a 128 MiB V8 heap limit
(not a total process RSS limit). Protocol frames/JSON files are capped at 256 KiB;
pane data and incoming pane messages at 16 KiB. API calls are capped at 128 per
second per plugin. Text fields have byte limits.

Activation has a five-second deadline. Each dispatched hook chain has a 1.5-second
deadline. A missed deadline kills the plugin process and removes its UI. A
five-second heartbeat also catches background CPU loops. Shutdown gives cleanup
a brief best-effort window. Core terminal operations do not await any plugin.
UI snapshots are coalesced to at most roughly 30 updates per second, and identical
status/pane writes do not schedule snapshots. Native subscriptions are scoped to
each context, unchanged pane state is not re-encoded, and offline rules are
shared across webviews. Long I/O should run as cancellable
background work that publishes revision-guarded results; the Git example shows
that pattern. Avoid shell/process work in render or typing paths.

## Validation

```sh
cd plugins
npm ci --ignore-scripts
npm test
npm run check
npm run lint
```

Tests launch the real supervisor/child processes, run the Git example against a
real temporary repository, and cover middleware, cancellation, context separation,
manual dismissal, revision guards, path containment, capability checks, framing,
and CPU-bound failure isolation. SDK checks compile supported usage and ensure
unknown events/invalid options fail typing.

The host, SDK, Git plugin, and pane script are authored in TypeScript. `npm run
build` emits ordinary JavaScript into ignored `dist/` directories; `npm test`
builds before running the real process tests. Runtime code has no package
dependencies or TypeScript loader. The SDK declarations are generated from
`sdk/index.mts`. Node and browser code use separate strict compiler settings.

Typed ESLint checks reject unsafe values, forgotten promises, and unbound
callbacks. See [AGENTS.md](AGENTS.md) for the local conventions and their sources.

The `Plugin checks` workflow compiles the actual native plugin components on
macOS with minimal Ghostty model stubs, tests Swift/Node pipe communication and
disabled-host behavior, loads the compiled Git pane under WebKit/CSP, and runs
SwiftLint. A separate job builds GhosttyKit and
the complete app, runs its unit tests, and verifies the bundled host resource.
Manual UI checks and native performance measurements remain necessary:

```sh
zig build -Demit-macos-app=false
macos/build.nu --configuration Debug --action test
macos/build.nu --configuration ReleaseLocal --action build
```

Verify splits/tabs, pane resizing and focus, fullscreen, quick terminal, reload,
and quitting. Compare ReleaseLocal startup, idle RSS/CPU, typing latency, and
high-volume output with plugins disabled, with the Git status widget, and with an
open pane. No native performance result is claimed before those measurements.

This implementation and documentation were written with OpenAI Codex assistance.
