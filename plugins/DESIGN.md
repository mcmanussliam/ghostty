# Plugin architecture and implementation plan

## Goals

Let users and coding agents write small, inspectable TypeScript/JavaScript plugins
that react to terminal context, register commands, supply native status items, and
open rich custom panes. Keep Ghostty's fast terminal engine and native application
structure. A broken plugin must not block keystrokes, parsing, or rendering.

## Boundaries

The macOS application owns terminal surfaces, focus, layouts, status chrome, and
webview lifecycle. A Node supervisor owns manifest validation, routing, budgets,
and UI snapshots. Each plugin runs in its own Node child. Only the child imports
plugin code; stdout is detached from the supervisor's JSONL channel.

The app/supervisor protocol is versioned JSONL over pipes. Plugin children use
Node IPC. Values are JSON only. The SDK never exposes a native pointer, C ABI,
Swift object, or direct window mutation. Rich views have a separate, scoped
webview-to-plugin JSON bridge.

This is reliability isolation. Node plugins are trusted user code with the user's
OS permissions. Host capabilities are enforceable API scopes, not a claim that
arbitrary Node code is sandboxed. A future untrusted marketplace needs real OS
isolation or a constrained runtime, plus permission/installation UX.

The host, SDK, and Git example are authored in strict TypeScript. Development
builds compile them to JavaScript; the app bundles only `plugins/dist/host`.
The SDK emits its declarations from the same implementation. Node and browser
settings are separate, and typed linting checks async work and unsafe values.

## Integration points

| Source                         | Responsibility                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `Ghostty.App.swift`            | Start/reload the host; forward existing command-finished events before desktop-notification filters |
| `BaseTerminalController.swift` | Stable context IDs, focused surface/cwd transitions, closed-context cleanup                         |
| `TerminalView.swift`           | Wrap the unchanged split tree in plugin workspace chrome                                            |
| `PluginTransport.swift`        | Background process startup, pipe IO, frame decoding, generation-safe reload/shutdown                |
| `PluginManager.swift`          | Main-queue snapshots, revision filtering, status visibility preferences, native actions             |
| `PluginWorkspaceView.swift`    | Native status groups/menu and resizable side panes                                                  |
| `PluginWebView.swift`          | Offline local view loading, ephemeral storage, scoped messaging and state updates                   |
| `plugins/host`                 | Manifest checks, plugin children, deadlines, hooks, UI state and protocol                           |
| `plugins/sdk`                  | Agent-friendly TypeScript contract and identity helper                                              |

No Zig parser, renderer, PTY, input, or shared action structures change. The host
scripts are copied into the macOS app by Xcode's Resources phase. Activation is
explicit through `plugins.json`; repository-local files do not auto-execute.

## Context and state

A context represents a native window/tab controller. It follows its focused
terminal surface and remains stable while a plugin pane has keyboard focus.
Changes carry a monotonically increasing revision. The host clears statuses and
closes ordinary panes on focus/cwd changes. Panes registered with
`retainOnContextChange` keep their webview and split width while discarding old
data and masking content until the plugin opens, publishes, or closes them.
Native code ignores old-revision snapshots and waits for the webview to accept
the new revision before revealing content. Plugin UI writes can include
the revision to reject stale async results atomically in the supervisor.

Status/pane/command IDs are namespaced by plugin. Closing a context removes its
UI and sends a cleanup event. Reload replaces every plugin process and replays
live contexts. User-hidden status item IDs persist through UserDefaults; custom
pane layout and plugin data persistence are future work.

## Hook contract

Hooks run by explicit event name and priority. Immutable event input and
single-use `next` make ordering and pre/post behavior predictable. UI API actions
use the same middleware path as native pane close and status clicks. A handler
can transform supported action inputs, continue, or suppress its plugin's action.
Recursion guards are scoped to the async dispatch chain, so a hook's nested call
does not recursively invoke itself or suppress unrelated concurrent work.

Notifications cannot veto shell commands. This version does not implement
pre-execution shell interception or synchronous hooks in the terminal hot path.
Cross-plugin middleware composition is intentionally not part of version 1;
plugins own their extension contributions independently.

## Performance contract

- No enabled config: no child process, polling, or webview.
- Plugin code never executes on the native UI queue or terminal threads.
- Native actions enqueue messages; ordinary terminal operations never await them.
- Children have bounded event queues, API call rates, execution deadlines, and
  V8 heap budgets. The supervisor can kill a CPU loop independently of native IO.
- Only open rich panes allocate webviews. Plain status items render natively.
- Per-context UI updates are batched and compared before publishing state.
- Unchanged API writes do not schedule snapshots; per-context native subscriptions
  avoid invalidating other windows. Pane state is compared before encoding.
- Offline content rules are looked up/compiled once and shared across open panes.
- Opening with initial data is atomic; no empty initial pane snapshot is required.
- Example Git work is asynchronous, read-only, timeout-limited, and revision-guarded.
- Git refresh bursts have one running query and one coalesced follow-up per
  context; directory changes cancel obsolete subprocesses. Root discovery is
  reused until the context changes.

Startup, RSS, CPU, input latency, and output throughput still need native
measurements. Do not equate process isolation with zero cost. Git polling and
webviews incur overhead that should be measured in ReleaseLocal builds.

## Delivery sequence

1. **Implemented:** isolated host, manifests and explicit capabilities, SDK,
   activation/disposal, local middleware, validation CLI, bounded routing.
2. **Implemented:** native macOS status bar/commands and context events; custom
   right-docked panes with resizable layout and scoped JSON messaging.
3. **Implemented:** Git status example with automatic opening, user dismissal,
   manual refresh, optional polling, and tested async context handling.
4. **CI validation:** runtime/SDK tests, native component/protocol/pipe checks,
   SwiftLint, and a full app build/unit-test job. Manual native UI checks and a
   performance comparison remain release gates.
5. **Next:** native config/error UI, explicit settings schemas, saved panel layout,
   more placement sites, automated hot reload, persistent plugin state.
6. **Next:** GTK adapter implementing the same JSON protocol with native status
   chrome and an appropriate embedded view; measure dependency/startup impact.
7. **Later:** true pre-execution shell integrations, host terminal/window action
   interception with asynchronous cancellation semantics, richer native UI slots.
8. **Before a marketplace:** stable semver/API migration, package integrity,
   reviewed trust/permission flow, and an actual untrusted-code sandbox.

AI authoring should operate against these types, manifests, examples and tests:
generate → validate paths/schema → type-check → run event tests → preview/reload.
Changes remain ordinary files that users can inspect and version-control.

## Validation limits

Runtime tests exercise real IPC and Git execution. Native component CI typechecks
the real plugin sources with lightweight Ghostty model stubs and validates JSON
round trips, Swift/Node pipe communication, and disabled-host behavior. A separate
CI job uses Ghostty's Zig/Xcode tooling to build the full app and run unit tests.
Automated builds alone do not prove terminal layout, responder-chain, fullscreen,
quick-terminal behavior, or performance. Those checks remain explicit release gates.

Written with OpenAI Codex assistance. No upstream issue or discussion is created
by this work; the requested review is in the user's fork.
