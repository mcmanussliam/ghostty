//
//  CommandPaletteTests.swift
//  GhosttyTests
//
//  Tests for command palette query filtering and match ranking.
//

import Testing
import SwiftUI
@testable import Ghostty

struct CommandPaletteFilterTests {
    private func option(
        title: String,
        subtitle: String? = nil,
        description: String? = nil,
        leadingColor: Color? = nil,
        sortKey: ObjectIdentifier? = nil,
        category: CommandOptionCategory = .command
    ) -> CommandOption {
        CommandOption(
            title: title,
            subtitle: subtitle,
            description: description,
            leadingColor: leadingColor,
            sortKey: sortKey,
            category: category
        ) {}
    }

    /// Title matches outrank subtitle matches, which outrank description
    /// matches. Options that don't match at all are dropped.
    @Test func textMatchTiers() {
        let byDescription = option(title: "Alpha", description: "make it fast")
        let bySubtitle = option(title: "Beta", subtitle: "fast scrolling")
        let byTitle = option(title: "Fast Redraw")
        let noMatch = option(title: "Quit")

        let results = [noMatch, byDescription, bySubtitle, byTitle]
            .filteredAndSorted(query: "fast")

        #expect(results == [byTitle, bySubtitle, byDescription])
    }

    /// Options with equal scores keep their original relative order.
    @Test func tiesPreserveOriginalOrder() {
        let first = option(title: "New Window")
        let second = option(title: "New Tab")

        #expect([first, second].filteredAndSorted(query: "new") == [first, second])
        #expect([second, first].filteredAndSorted(query: "new") == [second, first])
    }

    @Test func scopedQueries() {
        let action = option(title: "New Window")
        let terminal = option(title: "Focus: New Project", category: .terminal)
        let options = [action, terminal]

        #expect(options.filteredAndSorted(query: "new") == options)
        #expect(options.filteredAndSorted(query: "@new") == [terminal])
        #expect(options.filteredAndSorted(query: "> new") == [action])
        #expect(options.filteredAndSorted(query: " @ ") == [terminal])
        #expect(options.filteredAndSorted(query: ">") == [action])
        #expect(options.filteredAndSorted(query: " \n ") == options)
    }

    @Test func scopeOnlyUsesLeadingPrefix() {
        let action = option(title: "Send > to Shell")
        let terminal = option(title: "Focus: user@host", category: .terminal)

        #expect([action, terminal].filteredAndSorted(query: "user@host") == [terminal])
        #expect([action, terminal].filteredAndSorted(query: "send >") == [action])
    }

    @Test func queryCanSpanTitleAndDirectory() {
        let terminal = option(
            title: "Focus: Dev Server",
            subtitle: "~/projects/ghostty",
            category: .terminal
        )
        let otherProject = option(
            title: "Focus: Dev Server",
            subtitle: "~/projects/website",
            category: .terminal
        )

        #expect([otherProject, terminal].filteredAndSorted(query: "@server ghostty") == [terminal])
        #expect([terminal].filteredAndSorted(query: "@ GHOSTTY\tSERVER ") == [terminal])
        #expect([terminal].filteredAndSorted(query: "@server missing") == [])
    }

    @Test func queryCanSpanTitleAndDescription() {
        let action = option(title: "Split Right", description: "Create a terminal pane")

        #expect([action].filteredAndSorted(query: ">right pane") == [action])
        #expect([action].filteredAndSorted(query: ">right missing") == [])
    }

    @Test func multiWordMatchesKeepFieldRanking() {
        let title = option(title: "Ghostty Server")
        let subtitle = option(title: "Server", subtitle: "~/ghostty")
        let description = option(title: "Server", description: "Ghostty project")

        #expect([description, subtitle, title].filteredAndSorted(query: "ghostty server") == [
            title, subtitle, description,
        ])
    }

    @Test func colorMatchRequiresRemainingWords() {
        let terminal = option(title: "Focus: Server", leadingColor: .red, category: .terminal)

        #expect([terminal].filteredAndSorted(query: "@red server") == [terminal])
        #expect([terminal].filteredAndSorted(query: "@red missing") == [])
    }

    @Test func initialsMatchingIsPreserved() {
        let action = option(title: "New Window")

        #expect([action].filteredAndSorted(query: ">nw") == [action])
    }

    @Test func highlightWordsInEachField() {
        let title = "Focus: Server"
        let subtitle = "~/projects/ghostty"
        let query = "server ghostty"

        #expect(title.matchedTokenIndices(for: query)?.map { title[$0] } == Array("Server"))
        #expect(subtitle.matchedTokenIndices(for: query)?.map { subtitle[$0] } == Array("ghostty"))
        #expect(title.matchedTokenIndices(for: "missing") == nil)
    }

    @Test func highlightingDeduplicatesOverlappingWords() {
        let title = "Server"

        #expect(title.matchedTokenIndices(for: "server serve")?.map { title[$0] } == Array(title))
    }

    /// Equal titles use their sort keys independent of input order.
    @Test func equalTitlesUseSortKey() {
        let firstKey = NSObject()
        let secondKey = NSObject()
        let first = option(
            title: "Focus: Shell",
            subtitle: "/tmp",
            sortKey: ObjectIdentifier(firstKey)
        )
        let second = option(
            title: "Focus: Shell",
            subtitle: "/tmp",
            sortKey: ObjectIdentifier(secondKey)
        )

        let forward = sortedTerminalPaletteOptions([first, second])
        let reverse = sortedTerminalPaletteOptions([second, first])
        #expect(forward == reverse)
    }
}
