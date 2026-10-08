import Foundation

/// All process/file operations and framing run on a private queue. The only main-thread
/// work is applying a bounded, decoded UI snapshot. This is process isolation for
/// reliability, not an OS sandbox for untrusted Node code.
final class PluginTransport: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.mitchellh.ghostty.plugins", qos: .utility)
    private let writer = DispatchQueue(label: "com.mitchellh.ghostty.plugins.write", qos: .utility)
    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var errors: FileHandle?
    private var pending = Data()
    private var generation = UUID()
    private var queuedBytes = 0
    private let byteLock = NSLock()
    private static let maxFrame = 256 * 1024

    private var receive: (@Sendable (PluginHostMessage) -> Void)?
    private var stopped: (@Sendable (String?) -> Void)?

    func start(configURL: URL, hostURL: URL?,
               receive: @escaping @Sendable (PluginHostMessage) -> Void,
               stopped: @escaping @Sendable (String?) -> Void) {
        queue.async { [self] in
            stopOnQueue()
            self.receive = receive
            self.stopped = stopped
            let token = generation
            guard FileManager.default.fileExists(atPath: configURL.path) else {
                self.stopped?(nil)
                return
            }
            do {
                let attributes = try FileManager.default.attributesOfItem(atPath: configURL.path)
                guard let size = attributes[.size] as? NSNumber, size.intValue <= Self.maxFrame else {
                    throw PluginTransportError("Plugin configuration exceeds 256 KiB")
                }
                let config = try JSONDecoder().decode(PluginConfiguration.self, from: Data(contentsOf: configURL))
                guard config.version == 1, config.plugins.count <= 16 else {
                    throw PluginTransportError("Unsupported plugin configuration")
                }
                guard config.plugins.contains(where: { $0.enabled != false }) else {
                    self.stopped?(nil)
                    return
                }
                guard config.nodePath.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: config.nodePath),
                      let hostURL else {
                    throw PluginTransportError("Set an absolute executable nodePath; the bundled plugin host must exist")
                }

                let task = Process()
                let stdinPipe = Pipe()
                let stdoutPipe = Pipe()
                let stderrPipe = Pipe()
                task.executableURL = URL(fileURLWithPath: config.nodePath)
                task.arguments = [hostURL.path, configURL.path]
                // Do not let ambient NODE_OPTIONS inject code into the supervisor.
                var environment = ProcessInfo.processInfo.environment
                environment.removeValue(forKey: "NODE_OPTIONS")
                environment.removeValue(forKey: "NODE_PATH")
                task.environment = environment
                task.standardInput = stdinPipe
                task.standardOutput = stdoutPipe
                task.standardError = stderrPipe
                input = stdinPipe.fileHandleForWriting
                output = stdoutPipe.fileHandleForReading
                errors = stderrPipe.fileHandleForReading
                stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                    let data = handle.availableData
                    if data.isEmpty { handle.readabilityHandler = nil; return }
                    self?.queue.async { [weak self] in
                        guard let self, self.generation == token, !data.isEmpty else { return }
                        self.read(data)
                    }
                }
                stderrPipe.fileHandleForReading.readabilityHandler = { handle in
                    // Drain the pipe even when logs are disabled; a full stderr must not stall a child.
                    let data = handle.availableData
                    if data.isEmpty { handle.readabilityHandler = nil; return }
                    if !data.isEmpty {
                        let message = String(bytes: data.prefix(4096), encoding: .utf8) ?? "<invalid UTF-8>"
                        Ghostty.logger.debug("plugin host: \(message)")
                    }
                }
                task.terminationHandler = { [weak self] task in
                    self?.queue.async { [weak self] in
                        guard let self, self.generation == token else { return }
                        self.stopOnQueue()
                        self.stopped?("Plugin host exited with status \(task.terminationStatus)")
                    }
                }
                process = task
                try task.run()
            } catch {
                stopOnQueue()
                self.stopped?(error.localizedDescription)
            }
        }
    }

    func send(_ message: PluginJSON) {
        guard var data = try? JSONEncoder().encode(message), data.count <= Self.maxFrame else { return }
        data.append(10)
        byteLock.lock()
        guard queuedBytes + data.count <= 1024 * 1024 else {
            byteLock.unlock()
            stop()
            return
        }
        queuedBytes += data.count
        byteLock.unlock()
        let frame = data
        queue.async { [self] in
            let handle = input
            let token = generation
            writer.async { [self] in
                defer {
                    byteLock.lock()
                    queuedBytes -= frame.count
                    byteLock.unlock()
                }
                guard let handle else { return }
                do {
                    try handle.write(contentsOf: frame)
                } catch {
                    queue.async { [self] in
                        guard generation == token else { return }
                        stopOnQueue()
                        stopped?(error.localizedDescription)
                    }
                }
            }
        }
    }

    func stop() {
        queue.async { [self] in
            stopOnQueue()
            stopped?(nil)
        }
    }

    private func stopOnQueue() {
        generation = UUID()
        output?.readabilityHandler = nil
        errors?.readabilityHandler = nil
        try? input?.close()
        try? output?.close()
        try? errors?.close()
        input = nil
        output = nil
        errors = nil
        pending.removeAll(keepingCapacity: false)
        if let task = process, task.isRunning {
            task.terminationHandler = nil
            task.terminate()
        }
        process = nil
    }

    private func read(_ data: Data) {
        pending.append(data)
        while let newline = pending.firstIndex(of: 10) {
            let frame = pending[..<newline]
            guard frame.count <= Self.maxFrame else {
                stopOnQueue()
                stopped?("Plugin protocol frame exceeds 256 KiB")
                return
            }
            do {
                let message = try JSONDecoder().decode(PluginHostMessage.self, from: frame)
                receive?(message)
            } catch {
                stopOnQueue()
                stopped?("Invalid plugin protocol frame: \(error.localizedDescription)")
                return
            }
            pending.removeSubrange(...newline)
        }
        if pending.count > Self.maxFrame {
            stopOnQueue()
            stopped?("Plugin protocol frame exceeds 256 KiB")
        }
    }
}

private struct PluginTransportError: LocalizedError {
    let message: String

    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
