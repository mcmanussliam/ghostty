// Compile the actual native plugin components without building GhosttyKit. The full
// application still needs the normal Ghostty/Xcode build and manual UI verification.
import Foundation
import os

enum Ghostty {
    static let logger = Logger(subsystem: "ghostty.plugin.tests", category: "tests")

    final class SurfaceView {
        let id = UUID()
        var pwd: String?
    }
}
