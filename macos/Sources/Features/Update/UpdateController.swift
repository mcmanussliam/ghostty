import Sparkle
import Cocoa
import Combine
import SwiftUI

/// Standard controller for managing Sparkle updates in Ghostty.
///
/// This controller wraps SPUStandardUpdaterController to provide a simpler interface
/// for managing updates with Ghostty's custom driver and delegate. It handles
/// initialization, starting the updater, and provides the check for updates action.
class UpdateController {
    private(set) var updater: SPUUpdater
    private let userDriver: UpdateDriver

    var viewModel: UpdateViewModel {
        userDriver.viewModel
    }

    /// True if we're installing an update triggered manually.
    var shouldTerminateWithoutWarning: Bool {
        viewModel.state.shouldTerminateWithoutWarning
    }

    /// Initialize a new update controller.
    init() {
        let hostBundle = Bundle.main
        self.userDriver = UpdateDriver(
            viewModel: .init(),
            hostBundle: hostBundle)
        self.updater = SPUUpdater(
            hostBundle: hostBundle,
            applicationBundle: hostBundle,
            userDriver: userDriver,
            delegate: userDriver
        )
    }

    /// Start the updater.
    ///
    /// This must be called before the updater can check for updates. If starting fails,
    /// the error will be shown to the user.
    func startUpdater() {
        // Fork releases are installed manually. Starting Sparkle could replace
        // this app with an official build, so do not start it in this fork.
    }

    /// Check for updates.
    ///
    /// This is typically connected to a menu item action.
    func checkForUpdates() {
        guard let url = URL(string: "https://github.com/mcmanussliam/ghostty/releases") else { return }
        NSWorkspace.shared.open(url)
    }
}

private struct InstallingAccessoryView: View {
    let installing: UpdateState.Installing

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Restart Required")
                    .font(.system(size: 13, weight: .semibold))

                Text("The update is ready. Please restart the application to complete the installation.")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let item = installing.appcastItem, let releaseNotesURL = installing.releaseNotes?.url {
                    VStack(alignment: .leading, spacing: 4) {
                        Link(destination: releaseNotesURL) {
                            HStack(spacing: 6) {
                                Text("Version:")
                                    .foregroundColor(.secondary)
                                    .frame(width: 60, alignment: .trailing)
                                Text(item.displayVersionString)
                            }
                            .font(.system(size: 11))
                        }

                        if let date = item.date {
                            HStack(spacing: 6) {
                                Text("Released:")
                                    .foregroundColor(.secondary)
                                    .frame(width: 60, alignment: .trailing)
                                Text(date.formatted(date: .abbreviated, time: .omitted))
                            }
                            .font(.system(size: 11))
                        }
                    }
                    .textSelection(.enabled)
                }
            }
        }
    }
}
