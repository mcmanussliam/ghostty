import AppKit
import Foundation
import SwiftUI
import WebKit

@main
struct NativePluginCheck {
    @MainActor
    static func main() throws {
        let decoder = JSONDecoder()
        let source = Data("""
            {"type":"snapshot","contextId":"window","contextRevision":3,
             "statuses":[{"id":"branch","pluginId":"git","contextId":"window","text":"main 👻",
              "tooltip":"Repo","alignment":"left","priority":0,"command":null}],
             "panes":[{"id":"changes","pluginId":"git","contextId":"window","title":"Changes",
              "entry":"/plugin/view.html","root":"/plugin","width":320,"retainOnContextChange":true,
              "data":{"files":["日本語"],"clean":false}}],
             "commands":[]}
            """.utf8)
        let message = try decoder.decode(PluginHostMessage.self, from: source)
        precondition(message.contextRevision == 3)
        precondition(message.statuses?.first?.text == "main 👻")
        precondition(message.statuses?.first?.command == nil)
        var snapshot = PluginSnapshot(statuses: message.statuses!, panes: message.panes!)
        let originalPane = snapshot.panes[0]
        snapshot.invalidate()
        precondition(snapshot.statuses.isEmpty)
        precondition(snapshot.panes.count == 1)
        precondition(snapshot.panes[0].key == originalPane.key)
        precondition(snapshot.panes[0].width == originalPane.width)
        precondition(snapshot.panes[0].data == .null && snapshot.panes[0].loading == true)
        let transientSource = String(decoding: source, as: UTF8.self)
            .replacingOccurrences(of: "\"retainOnContextChange\":true,", with: "")
        let transient = try decoder.decode(PluginHostMessage.self, from: Data(transientSource.utf8))
        snapshot = PluginSnapshot(panes: transient.panes!)
        snapshot.invalidate()
        precondition(snapshot.panes.isEmpty)
        let value = message.panes!.first!.data
        let roundTrip = try decoder.decode(PluginJSON.self, from: JSONEncoder().encode(value))
        precondition(value == roundTrip)
        let nullValue = try decoder.decode(PluginJSON.self, from: Data("null".utf8))
        precondition(nullValue == .null)
        let configuration = try decoder.decode(PluginConfiguration.self, from: Data("""
            {"version":1,"nodePath":"/opt/homebrew/bin/node","plugins":[{"path":"/plugin","settings":{}}]}
            """.utf8))
        precondition(configuration.plugins.first?.enabled == nil)
        precondition(CommandLine.arguments.count == 4, "Usage: native-check <supervisor.mjs> <node> <git-view.html>")
        try checkTransport(host: CommandLine.arguments[1], node: CommandLine.arguments[2])
        checkGitView(path: CommandLine.arguments[3])
        try checkPaneAppearance()
        print("Native plugin components compile; protocol and transport checks passed")
    }

    @MainActor
    static func checkPaneAppearance() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let entry = root.appendingPathComponent("view.html")
        try Data("""
            <!doctype html><html><head><script>
                window.startBackground = document.documentElement.style.backgroundColor;
                window.startScheme = document.documentElement.style.colorScheme;
                window.paintedRevision = null;
                window.ghostty.onState(({context}) => {
                    document.documentElement.dataset.revision = context.revision;
                    requestAnimationFrame(() => { window.paintedRevision = context.revision; });
                });
            </script></head><body>Pane</body></html>
            """.utf8).write(to: entry)
        let pane = PluginPane(id: "pane", pluginId: "test", contextId: "test", title: "Pane",
                              entry: entry.path, root: root.path, width: 320,
                              retainOnContextChange: true, data: .null, loading: false)
        let context = PluginContext(id: "test", surfaceId: "surface", cwd: root.path, revision: 1)
        var ready: Int?
        var accepted: [Int] = []
        let coordinator = PluginWebView.Coordinator(manager: PluginManager(), pane: pane, context: context,
            readyRevision: Binding(get: { ready }, set: { revision in
                ready = revision
                if let revision { accepted.append(revision) }
            }))
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 240))
        let window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        window.displayIfNeeded()
        defer { window.close() }
        webView.navigationDelegate = coordinator
        coordinator.webView = webView
        coordinator.rulesReady = true
        coordinator.setAppearance(background: NSColor(srgbRed: 24 / 255, green: 33 / 255, blue: 42 / 255, alpha: 1),
                                  scheme: .dark)
        coordinator.load()
        waitUntil { ready == 1 }
        if ready != 1 {
            var inspected = false
            webView.evaluateJavaScript("""
                JSON.stringify({ready: document.readyState, hidden: document.hidden,
                    background: window.startBackground, scheme: window.startScheme,
                    bridge: typeof window.ghostty, revision: document.documentElement.dataset.revision,
                    painted: window.paintedRevision});
                """) { value, error in
                print("Pane diagnostics: \(value ?? "nil"), error: \(String(describing: error))")
                inspected = true
            }
            waitUntil { inspected }
            fflush(stdout)
        }
        precondition(ready == 1, "Pane did not acknowledge its first rendered frame")

        // An obsolete frame must not reveal newer state, including an entry reload at the same revision.
        coordinator.context = PluginContext(id: "test", surfaceId: "surface", cwd: root.path, revision: 2)
        coordinator.pane.loading = true
        coordinator.publish()
        var loadingChecked = false
        webView.evaluateJavaScript("document.documentElement.dataset.revision") { value, error in
            precondition(error == nil && (value as? String) == "1", "Loading state must not be published as ready")
            loadingChecked = true
        }
        waitUntil { loadingChecked }
        precondition(loadingChecked && ready == 1)
        coordinator.pane.loading = false
        coordinator.publish()
        coordinator.context = PluginContext(id: "test", surfaceId: "surface", cwd: root.path, revision: 3)
        coordinator.publish()
        waitUntil { ready == 3 }
        precondition(ready == 3 && !accepted.contains(2), "An obsolete publication was accepted")
        coordinator.load()
        precondition(ready == nil, "Reload must cover the previous page immediately")
        waitUntil { ready == 3 }
        precondition(ready == 3, "Reloaded pane did not become ready")

        var verified = false
        webView.evaluateJavaScript("""
            window.startBackground === 'rgb(24, 33, 42)' && window.startScheme === 'dark' &&
            window.paintedRevision === 3 && document.documentElement.dataset.revision === '3';
            """) { value, error in
            precondition(error == nil)
            verified = (value as? Bool) == true
        }
        waitUntil { verified }
        precondition(verified, "Appearance must be installed before page content and state before revealing the pane")
        print("Native pane applies appearance at document start and reveals only current rendered state")
    }

    @MainActor
    static func waitUntil(_ predicate: () -> Bool) {
        let deadline = Date(timeIntervalSinceNow: 10)
        while !predicate() && Date() < deadline {
            while let event = NSApp.nextEvent(matching: .any, until: Date(), inMode: .default, dequeue: true) {
                NSApp.sendEvent(event)
            }
            NSApp.updateWindows()
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
        }
    }

    @MainActor
    static func checkGitView(path: String) {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.regular)
        NSApp.finishLaunching()
        NSApp.activate(ignoringOtherApps: true)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(WKUserScript(source: """
            window.ghostty = {
                send: payload => { window.testSent = payload; },
                onState: handler => window.addEventListener('ghostty:state', event => handler(event.detail))
            };
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 420, height: 680), configuration: configuration)
        let window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        let check = GitViewCheck()
        webView.navigationDelegate = check
        let url = URL(fileURLWithPath: path)
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        waitUntil { check.done }
        webView.stopLoading()
        precondition(check.done, "Git view loading timed out")
        precondition(check.failure == nil, check.failure ?? "Git view failed")
        print("Compiled Git pane loads under WebKit CSP and renders bridge state")
    }

    /// Exercise the actual Swift pipe adapter and Node supervisor together, without GUI stubs for IO.
    static func checkTransport(host: String, node: String) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("""
            {"id":"native-test","name":"Native Test","version":"0.1.0","apiVersion":1,
             "capabilities":["context","ui.statusBar"],"main":"index.mjs"}
            """.utf8).write(to: root.appendingPathComponent("plugin.json"))
        try Data("""
            export default { activate(api) {
              api.on('context.changed', async ({context}, next) => {
                await api.ui.statusBar.set({id:'cwd', contextId:context.id,
                  revision:context.revision, text:'main 👻 日本語', alignment:'left'});
                return next();
              });
            }};
            """.utf8).write(to: root.appendingPathComponent("index.mjs"))
        let config = root.appendingPathComponent("config.json")
        try JSONSerialization.data(withJSONObject: [
            "version": 1, "nodePath": node, "plugins": [["path": root.path]]
        ]).write(to: config)
        let transport = PluginTransport()
        let snapshot = DispatchSemaphore(value: 0)
        let stopped = DispatchSemaphore(value: 0)
        transport.start(configURL: config, hostURL: URL(fileURLWithPath: host), receive: { message in
            if message.type == "ready" {
                transport.send(.object([
                    "type": .string("context"), "context": .object([
                        "id": .string("native-window"), "surfaceId": .string("surface"),
                        "cwd": .string(root.path), "revision": .number(7)
                    ])
                ]))
            } else if message.type == "snapshot", message.statuses?.first?.text == "main 👻 日本語" {
                precondition(message.contextRevision == 7)
                precondition(message.contextId == "native-window")
                snapshot.signal()
            }
        }, stopped: { error in
            precondition(error == nil, error ?? "Unexpected transport failure")
            stopped.signal()
        })
        precondition(snapshot.wait(timeout: .now() + 10) == .success, "Swift/Node snapshot timed out")
        transport.stop()
        precondition(stopped.wait(timeout: .now() + 3) == .success, "Transport shutdown timed out")

        // A disabled configuration must succeed without a Node executable or bundled host.
        try JSONSerialization.data(withJSONObject: [
            "version": 1, "nodePath": "/does-not-exist", "plugins": [["enabled": false]]
        ]).write(to: config)
        transport.start(configURL: config, hostURL: nil, receive: { _ in
            preconditionFailure("Disabled plugins unexpectedly started a host")
        }, stopped: { error in
            precondition(error == nil)
            stopped.signal()
        })
        precondition(stopped.wait(timeout: .now() + 3) == .success, "Disabled config did not stop")
    }
}

@MainActor
private final class GitViewCheck: NSObject, WKNavigationDelegate {
    var done = false
    var failure: String?

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("""
            window.dispatchEvent(new CustomEvent('ghostty:state', {detail: {
                context: {id: 'test', surfaceId: 'surface', cwd: '/repo', revision: 1},
                data: {root: '/repo', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1,
                  detached: false, unborn: false, upstreamGone: false, total: 2,
                  counts: {conflicts: 0, staged: 1, unstaged: 1, untracked: 1},
                  files: [{status: 'MM', path: 'src/main.ts', groups: ['staged', 'unstaged']},
                          {status: '??', path: '日本語<file>.txt', groups: ['untracked']}] }
            }}));
            const folder = document.querySelector('.folder');
            folder.open = false;
            folder.dispatchEvent(new Event('toggle'));
            const heading = folder.querySelector('summary');
            heading.focus();
            const focusedId = heading.parentElement.id;
            window.dispatchEvent(new CustomEvent('ghostty:state', {detail: {
                context: {id: 'test', surfaceId: 'surface', cwd: '/repo', revision: 1},
                data: {root: '/repo', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1,
                  detached: false, unborn: false, upstreamGone: false, total: 3,
                  counts: {conflicts: 0, staged: 1, unstaged: 1, untracked: 2},
                  files: [{status: 'MM', path: 'src/main.ts', groups: ['staged', 'unstaged']},
                          {status: '??', path: '日本語<file>.txt', groups: ['untracked']},
                          {status: '??', path: 'new.txt', groups: ['untracked']}] }
            }}));
            const preserved = document.querySelector('.folder').open === false &&
                document.activeElement.parentElement.id === focusedId;
            document.getElementById('list').click();
            const flat = !document.querySelector('.folder');
            document.getElementById('tree').click();
            const filter = document.getElementById('filter');
            filter.value = '日本語';
            filter.dispatchEvent(new Event('input'));
            document.getElementById('refresh').click();
            ({branch: document.getElementById('branch').textContent,
              file: [...document.querySelectorAll('#files .name')].find(node => node.textContent === '日本語<file>.txt').textContent,
              groups: String(document.querySelectorAll('.change-group').length),
              preserved: String(preserved), flat: String(flat),
              tracking: document.getElementById('tracking').textContent,
              action: window.testSent.action});
            """) { value, error in
            if let error {
                self.failure = error.localizedDescription
            } else if let result = value as? [String: String],
                      result["branch"] == "main", result["file"] == "日本語<file>.txt",
                      result["action"] == "refresh", result["groups"] == "1",
                      result["preserved"] == "true", result["flat"] == "true",
                      result["tracking"] == "origin/main · 2 ahead · 1 behind" {
                self.failure = nil
            } else {
                self.failure = "Git view did not render compiled state or send refresh"
            }
            self.done = true
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failure = error.localizedDescription
        done = true
    }
}
