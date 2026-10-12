import Combine
import Foundation

/// Application/UI state is accessed only on the main queue, like Ghostty's existing
/// App model. Transport callbacks explicitly hop back before touching this state.
final class PluginManager: ObservableObject, @unchecked Sendable {
    @Published private(set) var isRunning = false
    @Published private(set) var snapshots: [String: PluginSnapshot] = [:]
    @Published private(set) var hiddenStatusItems: Set<String>
    private(set) var contexts: [String: PluginContext] = [:]
    private let transport = PluginTransport()
    private var revision = 0
    private var generation = UUID()

    init() {
        hiddenStatusItems = Set(UserDefaults.standard.stringArray(forKey: "plugin-hidden-status-items") ?? [])
    }

    func reload() {
        let token = UUID()
        generation = token
        isRunning = false
        snapshots = [:]
        let receive: @Sendable (PluginHostMessage) -> Void = { [weak self] message in
            DispatchQueue.main.async { [weak self] in
                guard let self, self.generation == token else { return }
                self.receive(message)
            }
        }
        let stopped: @Sendable (String?) -> Void = { [weak self] error in
            DispatchQueue.main.async { [weak self] in
                guard let self, self.generation == token else { return }
                self.isRunning = false
                self.snapshots = [:]
                if let error { Ghostty.logger.warning("plugins: \(error)") }
            }
        }
        transport.start(
            configURL: Self.configurationURL,
            hostURL: Bundle.main.url(forResource: "supervisor", withExtension: "mjs", subdirectory: "host"),
            receive: receive, stopped: stopped)
    }

    func stop() {
        generation = UUID()
        transport.stop()
        isRunning = false
        snapshots = [:]
    }

    func setContext(id: String, surface: Ghostty.SurfaceView) {
        let cwd = surface.pwd ?? ""
        if let previous = contexts[id], previous.surfaceId == surface.id.uuidString, previous.cwd == cwd { return }
        revision += 1
        let context = PluginContext(id: id, surfaceId: surface.id.uuidString, cwd: cwd, revision: revision)
        contexts[id] = context
        // Clear stale content without destroying the pane's webview or split position.
        snapshots[id]?.invalidate()
        if isRunning { sendContext(context) }
    }

    func removeContext(id: String) {
        guard contexts.removeValue(forKey: id) != nil else { return }
        snapshots.removeValue(forKey: id)
        if isRunning { send(type: "context.close", contextId: id) }
    }

    func commandFinished(surface: Ghostty.SurfaceView, exitCode: Int?, durationMs: Double) {
        guard isRunning else { return }
        for context in contexts.values where context.surfaceId == surface.id.uuidString {
            transport.send(.object([
                "type": .string("shell.command.finished"), "contextId": .string(context.id),
                "exitCode": exitCode.map { .number(Double($0)) } ?? .null,
                "durationMs": .number(durationMs),
            ]))
        }
    }

    func press(_ item: PluginStatusItem) {
        send(type: "ui.status.press", contextId: item.contextId, pluginId: item.pluginId, id: item.id)
    }

    func run(_ command: PluginCommand, contextId: String) {
        send(type: "command.run", contextId: contextId, pluginId: command.pluginId, id: command.id)
    }

    func close(_ pane: PluginPane) {
        send(type: "ui.pane.close", contextId: pane.contextId, pluginId: pane.pluginId, id: pane.id)
    }

    func paneMessage(_ pane: PluginPane, payload: PluginJSON) {
        send(type: "ui.pane.message", contextId: pane.contextId, pluginId: pane.pluginId, id: pane.id, payload: payload)
    }

    func toggleStatusItem(_ key: String) {
        if hiddenStatusItems.contains(key) {
            hiddenStatusItems.remove(key)
        } else {
            hiddenStatusItems.insert(key)
        }
        UserDefaults.standard.set(hiddenStatusItems.sorted(), forKey: "plugin-hidden-status-items")
    }

    private func send(type: String, contextId: String, pluginId: String? = nil, id: String? = nil, payload: PluginJSON? = nil) {
        guard isRunning else { return }
        var message: [String: PluginJSON] = ["type": .string(type), "contextId": .string(contextId)]
        if let pluginId { message["pluginId"] = .string(pluginId) }
        if let id { message["id"] = .string(id) }
        if let payload { message["payload"] = payload }
        transport.send(.object(message))
    }

    private func sendContext(_ context: PluginContext) {
        transport.send(.object([
            "type": .string("context"),
            "context": .object([
                "id": .string(context.id), "surfaceId": .string(context.surfaceId),
                "cwd": .string(context.cwd), "revision": .number(Double(context.revision)),
            ]),
        ]))
    }

    private func receive(_ message: PluginHostMessage) {
        switch message.type {
        case "ready":
            guard message.version == 1 else { stop(); return }
            isRunning = true
            for context in contexts.values { sendContext(context) }
        case "snapshot":
            guard let id = message.contextId, let context = contexts[id],
                  message.contextRevision == context.revision else { return }
            let snapshot = PluginSnapshot(
                statuses: message.statuses ?? [], panes: message.panes ?? [], commands: message.commands ?? [])
            if snapshots[id] != snapshot { snapshots[id] = snapshot }
        case "error", "log":
            Ghostty.logger.warning("plugin \(message.pluginId ?? "host"): \(message.message ?? "unknown error")")
        default:
            break
        }
    }

    private static var configurationURL: URL {
        let environment = ProcessInfo.processInfo.environment
        if let override = environment["GHOSTTY_PLUGIN_CONFIG"], override.hasPrefix("/") {
            return URL(fileURLWithPath: override)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let xdg = environment["XDG_CONFIG_HOME"].map { URL(fileURLWithPath: $0) }
            ?? home.appendingPathComponent(".config")
        let config = xdg.appendingPathComponent("ghostty/plugins.json")
        if FileManager.default.fileExists(atPath: config.path) { return config }
        return home.appendingPathComponent("Library/Application Support/com.mitchellh.ghostty/plugins.json")
    }
}
