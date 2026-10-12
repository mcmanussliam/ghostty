//
//  GhosttyCommandPaletteTests.swift
//  Ghostty
//
//  Created by Lukas on 19.03.2026.
//

import XCTest

final class GhosttyCommandPaletteTests: GhosttyCustomConfigCase {
    @MainActor func testScopedSearch() throws {
        try updateConfig("title = Palette Navigation")
        let app = try ghosttyApplication()
        app.launch()
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 5))

        app.typeKey("p", modifierFlags: [.command, .shift])
        let query = app.textFields["commandPaletteQuery"]
        XCTAssertTrue(query.waitForExistence(timeout: 5))

        query.typeText("@Palette Navigation")
        let terminal = app.buttons.containing(NSPredicate(format: "label CONTAINS 'Focus: Palette Navigation'"))
            .firstMatch
        XCTAssertTrue(terminal.waitForExistence(timeout: 5))

        query.typeKey("a", modifierFlags: .command)
        query.typeText(">Palette Navigation")
        XCTAssertTrue(app.staticTexts["No matches"].waitForExistence(timeout: 5))
        XCTAssertFalse(terminal.exists)

        query.typeKey("a", modifierFlags: .command)
        query.typeText(">Clear Screen")
        let command = app.buttons.containing(NSPredicate(format: "label CONTAINS 'Clear Screen'"))
            .firstMatch
        XCTAssertTrue(command.waitForExistence(timeout: 5))
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(query.waitForNonExistence(timeout: 5))
    }

    @MainActor func testQueryChangeSelectsFirstResult() throws {
        try updateConfig("""
        command-palette-entry = clear
        command-palette-entry = title:Palette Alpha New Window,action:new_window
        command-palette-entry = title:Palette Beta New Tab,action:new_tab
        command-palette-entry = title:Palette Gamma New Tab,action:new_tab
        """)
        let app = try ghosttyApplication()
        app.launch()
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 5))

        app.typeKey("p", modifierFlags: [.command, .shift])
        let query = app.textFields["commandPaletteQuery"]
        XCTAssertTrue(query.waitForExistence(timeout: 5))
        query.typeText(">Palette")
        app.typeKey(.downArrow, modifierFlags: [])

        // Refining the search should select Alpha again, which opens a window.
        // Retaining the old index would select Beta and open a tab instead.
        query.typeText(" New")
        app.typeKey(.enter, modifierFlags: [])
        XCTAssertTrue(app.windows.element(boundBy: 1).waitForExistence(timeout: 5))
    }

    @MainActor func testDismissingCommandPalette() async throws {
        let app = try ghosttyApplication()
        app.activate()

        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 5), "New window should appear")

        app.menuItems["Command Palette"].firstMatch.click()

        let clearScreenButton = app.buttons
            .containing(NSPredicate(format: "label CONTAINS[c] 'Clear Screen'"))
            .firstMatch

        XCTAssertTrue(clearScreenButton.waitForExistence(timeout: 5), "Command Palette should appear")

        clearScreenButton.coordinate(withNormalizedOffset: .zero)
            .withOffset(.init(dx: -30, dy: 0))
            .click()

        XCTAssertTrue(clearScreenButton.waitForNonExistence(timeout: 5), "Command Palette should disappear after clicking outside")

        app.typeKey("p", modifierFlags: [.command, .shift])

        XCTAssertTrue(clearScreenButton.waitForExistence(timeout: 5), "Command Palette should appear")

        app.typeKey(.escape, modifierFlags: [])

        XCTAssertTrue(clearScreenButton.waitForNonExistence(timeout: 5), "Command Palette should disappear after typing escape")

        app.typeKey("p", modifierFlags: [.command, .shift])

        XCTAssertTrue(clearScreenButton.waitForExistence(timeout: 5), "Command Palette should appear")

        app.typeKey(.enter, modifierFlags: [])

        XCTAssertTrue(clearScreenButton.waitForNonExistence(timeout: 5), "Command Palette should disappear after submitting query")

        app.typeKey("p", modifierFlags: [.command, .shift])

        XCTAssertTrue(clearScreenButton.waitForExistence(timeout: 5), "Command Palette should appear")

        app.typeText("Clear Screen")
        app.typeKey(.enter, modifierFlags: [])

        XCTAssertTrue(clearScreenButton.waitForNonExistence(timeout: 5), "Command Palette should disappear after selecting a command by keyboard")

        app.typeKey("p", modifierFlags: [.command, .shift])
        app.typeKey(.delete, modifierFlags: [])

        XCTAssertTrue(clearScreenButton.waitForExistence(timeout: 5), "Command Palette should appear")
        clearScreenButton.click()

        XCTAssertTrue(clearScreenButton.waitForNonExistence(timeout: 5), "Command Palette should disappear after selecting a command by mouse")
    }

    @MainActor func testSelectCommandWithMouse() async throws {
        let app = try ghosttyApplication()
        app.activate()

        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 5), "New window should appear")

        app.menuItems["Command Palette"].firstMatch.click()

        app.buttons
            .containing(NSPredicate(format: "label CONTAINS[c] 'Close All Windows'"))
            .firstMatch.click()

        XCTAssertTrue(app.windows.firstMatch.waitForNonExistence(timeout: 2), "All windows should be closed")
    }
}

