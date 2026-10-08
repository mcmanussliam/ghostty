import SwiftUI
import WebKit

/// Local, ephemeral webviews with a JSON-only bridge to their owning plugin.
struct PluginWebView: NSViewRepresentable {
    let manager: PluginManager
    let pane: PluginPane
    let context: PluginContext?
    let backgroundColor: Color
    @Binding var readyRevision: Int?
    @Environment(\.colorScheme) private var colorScheme

    func makeCoordinator() -> Coordinator {
        Coordinator(manager: manager, pane: pane, context: context, readyRevision: $readyRevision)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(context.coordinator, name: "ghostty")
        configuration.userContentController.addUserScript(WKUserScript(source: """
            window.ghostty = Object.freeze({
                send: payload => window.webkit.messageHandlers.ghostty.postMessage(payload),
                onState: handler => {
                    const listener = event => handler(event.detail);
                    window.addEventListener('ghostty:state', listener);
                    return () => window.removeEventListener('ghostty:state', listener);
                }
            });
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        context.coordinator.setAppearance(background: NSColor(backgroundColor), scheme: colorScheme)
        OfflineRules.load { [weak coordinator = context.coordinator] list in
            guard let coordinator, let webView = coordinator.webView else { return }
            guard let list else {
                Ghostty.logger.warning("could not install plugin webview content rules")
                return
            }
            webView.configuration.userContentController.add(list)
            coordinator.rulesReady = true
            coordinator.load()
        }
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        let coordinator = context.coordinator
        let reload = coordinator.pane.entry != pane.entry || coordinator.pane.root != pane.root
        coordinator.pane = pane
        coordinator.context = self.context
        coordinator.setAppearance(background: NSColor(backgroundColor), scheme: colorScheme)
        if reload {
            coordinator.load()
        } else {
            coordinator.publish()
        }
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "ghostty")
        coordinator.webView = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let manager: PluginManager
        var pane: PluginPane
        var context: PluginContext?
        var rulesReady = false
        weak var webView: WKWebView?
        private var readyRevision: Binding<Int?>
        private var loaded = false
        private var lastContext: PluginContext?
        private var lastData: PluginJSON?
        private var appearance = ""

        init(manager: PluginManager, pane: PluginPane, context: PluginContext?, readyRevision: Binding<Int?>) {
            self.manager = manager
            self.pane = pane
            self.context = context
            self.readyRevision = readyRevision
        }

        func load() {
            // updateNSView can run before asynchronous rule installation finishes.
            guard rulesReady else { return }
            loaded = false
            lastContext = nil
            lastData = nil
            webView?.loadFileURL(URL(fileURLWithPath: pane.entry), allowingReadAccessTo: URL(fileURLWithPath: pane.root))
        }

        func setAppearance(background: NSColor, scheme: ColorScheme) {
            webView?.underPageBackgroundColor = background
            webView?.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
            guard let hex = background.hexString else { return }
            let script = """
                document.documentElement.style.setProperty('--ghostty-background', '\(hex)');
                document.documentElement.style.colorScheme = '\(scheme == .dark ? "dark" : "light")';
                """
            guard script != appearance else { return }
            appearance = script
            if loaded { webView?.evaluateJavaScript(script) }
        }

        func publish() {
            guard loaded, let context else { return }
            guard context != lastContext || pane.data != lastData else { return }
            struct State: Encodable {
                let context: PluginContext
                let data: PluginJSON
            }
            guard let state = try? JSONEncoder().encode(State(context: context, data: pane.data)),
                  let json = String(data: state, encoding: .utf8) else { return }
            lastContext = context
            lastData = pane.data
            webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('ghostty:state', {detail: \(json)}));") { [weak self] _, error in
                guard let self, self.webView != nil else { return }
                if error != nil {
                    self.lastContext = nil
                    self.lastData = nil
                    return
                }
                guard self.context == context else { return }
                self.readyRevision.wrappedValue = context.revision
            }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            loaded = false
            readyRevision.wrappedValue = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = true
            lastContext = nil
            lastData = nil
            webView.evaluateJavaScript(appearance)
            publish()
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard navigationAction.targetFrame?.isMainFrame == true,
                  let url = navigationAction.request.url, url.isFileURL else {
                decisionHandler(.cancel)
                return
            }
            let root = URL(fileURLWithPath: pane.root).resolvingSymlinksInPath().path + "/"
            let path = url.resolvingSymlinksInPath().path
            decisionHandler(path.hasPrefix(root) ? .allow : .cancel)
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard pane.loading != true, message.frameInfo.isMainFrame,
                  let data = try? JSONSerialization.data(withJSONObject: message.body, options: [.fragmentsAllowed]),
                  data.count <= 16 * 1024,
                  let payload = try? JSONDecoder().decode(PluginJSON.self, from: data) else { return }
            manager.paneMessage(pane, payload: payload)
        }
    }
}

/// Compile once, share across open panes, and reuse WebKit's persisted rule list on launch.
private enum OfflineRules {
    private static var cached: WKContentRuleList?
    private static var waiting: [(WKContentRuleList?) -> Void] = []
    private static let identifier = "ghostty-plugin-offline-v1"
    private static let rules = """
        [{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}}]
        """

    static func load(_ completion: @escaping (WKContentRuleList?) -> Void) {
        if let cached { completion(cached); return }
        waiting.append(completion)
        guard waiting.count == 1 else { return }
        guard let store = WKContentRuleListStore.default() else { finish(nil); return }
        store.lookUpContentRuleList(forIdentifier: identifier) { list, _ in
            if let list {
                finish(list)
            } else {
                store.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: rules) { list, _ in
                    finish(list)
                }
            }
        }
    }

    private static func finish(_ list: WKContentRuleList?) {
        DispatchQueue.main.async {
            cached = list
            let callbacks = waiting
            waiting = []
            for callback in callbacks { callback(list) }
        }
    }
}
