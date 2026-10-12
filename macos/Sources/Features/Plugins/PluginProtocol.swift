import Foundation

/// Plain data crosses the plugin boundary; no native objects or pointers are exposed.
indirect enum PluginJSON: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([PluginJSON])
    case object([String: PluginJSON])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([PluginJSON].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: PluginJSON].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

struct PluginContext: Codable, Equatable, Sendable {
    let id: String
    let surfaceId: String
    let cwd: String
    let revision: Int
}

struct PluginStatusItem: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let pluginId: String
    let contextId: String
    let text: String
    let tooltip: String
    let alignment: String
    let priority: Double
    let command: String?

    var key: String { "\(pluginId)/\(id)" }
}

struct PluginPane: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let pluginId: String
    let contextId: String
    let title: String
    let entry: String
    let root: String
    let width: Double
    let retainOnContextChange: Bool?
    var data: PluginJSON
    var loading: Bool?

    var key: String { "\(pluginId)/\(id)" }
}

struct PluginCommand: Decodable, Equatable, Sendable {
    let id: String
    let pluginId: String
    let title: String

    var key: String { "\(pluginId)/\(id)" }
}

struct PluginSnapshot: Equatable, Sendable {
    var statuses: [PluginStatusItem] = []
    var panes: [PluginPane] = []
    var commands: [PluginCommand] = []

    mutating func invalidate() {
        statuses = []
        panes.removeAll { $0.retainOnContextChange != true }
        for index in panes.indices {
            panes[index].data = .null
            panes[index].loading = true
        }
    }
}

struct PluginHostMessage: Decodable, Sendable {
    let type: String
    let version: Int?
    let contextId: String?
    let contextRevision: Int?
    let statuses: [PluginStatusItem]?
    let panes: [PluginPane]?
    let commands: [PluginCommand]?
    let pluginId: String?
    let message: String?
}

struct PluginConfiguration: Decodable {
    struct Entry: Decodable {
        let enabled: Bool?
    }

    let version: Int
    let nodePath: String
    let plugins: [Entry]
}
