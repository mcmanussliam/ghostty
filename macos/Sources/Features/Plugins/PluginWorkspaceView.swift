import Combine
import SwiftUI

/// Plugin chrome surrounds the terminal without replacing its surface tree.
struct PluginWorkspaceView<Content: View>: View {
    let manager: PluginManager
    let contextId: String
    var backgroundColor: Color = Color(nsColor: .windowBackgroundColor)
    @ViewBuilder var content: () -> Content
    @State private var snapshot = PluginSnapshot()
    @State private var isRunning = false

    private var colorScheme: ColorScheme {
        NSColor(backgroundColor).isLightColor ? .light : .dark
    }

    var body: some View {
        VStack(spacing: 0) {
            HSplitView {
                content().frame(minWidth: 160, maxWidth: .infinity, maxHeight: .infinity)
                ForEach(snapshot.panes, id: \.key) { pane in
                    PluginPaneView(manager: manager, pane: pane, context: manager.contexts[contextId],
                                   backgroundColor: backgroundColor)
                        .environment(\.colorScheme, colorScheme)
                }
            }
            if isRunning {
                PluginStatusBar(manager: manager, contextId: contextId, snapshot: snapshot)
                    .environment(\.colorScheme, colorScheme)
                    .background(backgroundColor)
                    .overlay(alignment: .top) {
                        Rectangle().fill(Color.primary.opacity(0.08)).frame(height: 1)
                    }
            }
        }
        // A different window's updates must not invalidate this terminal's layout.
        .onReceive(manager.$snapshots.map { $0[contextId] ?? PluginSnapshot() }.removeDuplicates()) {
            snapshot = $0
        }
        .onReceive(manager.$isRunning.removeDuplicates()) { isRunning = $0 }
    }
}

private struct PluginPaneView: View {
    let manager: PluginManager
    let pane: PluginPane
    let context: PluginContext?
    let backgroundColor: Color
    @State private var readyRevision: Int?

    private var isReady: Bool { readyRevision != nil && readyRevision == context?.revision && pane.loading != true }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(pane.title)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Button { manager.close(pane) } label: {
                    Image(systemName: "xmark").font(.system(size: 10, weight: .medium))
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Close \(pane.title)")
                .accessibilityLabel("Close \(pane.title)")
            }
            .padding(.horizontal, 12)
            .frame(height: 32)
            ZStack {
                PluginWebView(manager: manager, pane: pane, context: context,
                              backgroundColor: backgroundColor, readyRevision: $readyRevision)
                    .opacity(isReady ? 1 : 0)
                    .allowsHitTesting(isReady)
                    .accessibilityHidden(!isReady)
                if !isReady {
                    Text("Loading…")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .frame(minWidth: 160, idealWidth: pane.width, maxWidth: 1200, maxHeight: .infinity)
        .background(backgroundColor)
    }
}

private struct PluginStatusBar: View {
    let manager: PluginManager
    let contextId: String
    let snapshot: PluginSnapshot
    @State private var hiddenItems: Set<String> = []

    var body: some View {
        PluginStatusLayout {
            group("left")
            group("center")
            group("right")
            Menu {
                ForEach(snapshot.commands, id: \.key) { command in
                    Button(command.title) { manager.run(command, contextId: contextId) }
                }
                if !snapshot.statuses.isEmpty {
                    Divider()
                    Menu("Status Items") {
                        ForEach(snapshot.statuses, id: \.key) { item in
                            Toggle(item.text, isOn: Binding(
                                get: { !hiddenItems.contains(item.key) },
                                set: { _ in manager.toggleStatusItem(item.key) }))
                        }
                    }
                }
                Divider()
                Button("Reload Plugins") { manager.reload() }
            } label: {
                Image(systemName: "puzzlepiece.extension")
                    .frame(width: 20, height: 20)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Plugin commands and status items")
            .accessibilityLabel("Plugins")
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .controlSize(.mini)
        .padding(.horizontal, 10)
        .frame(height: 26)
        .onReceive(manager.$hiddenStatusItems.removeDuplicates()) { hiddenItems = $0 }
    }

    private func group(_ alignment: String) -> some View {
        HStack(spacing: 10) {
            ForEach(snapshot.statuses.filter {
                $0.alignment == alignment && !hiddenItems.contains($0.key)
            }, id: \.key) { item in
                if item.command != nil {
                    Button(item.text) { manager.press(item) }
                        .buttonStyle(.plain)
                        .lineLimit(1)
                        .help(item.tooltip)
                } else {
                    Text(item.text).lineLimit(1).help(item.tooltip)
                }
            }
        }
    }
}

/// Centre items stay centred; empty groups leave room for a long branch name.
private struct PluginStatusLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        CGSize(width: proposal.width ?? subviews.reduce(36) { $0 + $1.sizeThatFits(.unspecified).width }, height: 26)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 4 else { return }
        let menu = subviews[3].sizeThatFits(.unspecified).width
        let available = max(0, bounds.width - menu - 12)
        let center = min(subviews[1].sizeThatFits(.unspecified).width, available / 3)
        let rightLimit = center > 0 ? max(0, available - (bounds.width + center) / 2 - 12) : available / 3
        let right = min(subviews[2].sizeThatFits(.unspecified).width, rightLimit)
        let leftLimit = center > 0 ? max(0, (bounds.width - center) / 2 - 12) : max(0, available - right - 12)
        let left = min(subviews[0].sizeThatFits(.unspecified).width, leftLimit)
        let widths = [left, center, right, menu]
        let positions = [bounds.minX, bounds.midX - center / 2, bounds.minX + available - right, bounds.maxX - menu]
        for index in subviews.indices {
            subviews[index].place(at: CGPoint(x: positions[index], y: bounds.midY), anchor: .leading,
                                 proposal: ProposedViewSize(width: widths[index], height: bounds.height))
        }
    }
}
