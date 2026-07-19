import Foundation
import ApplicationServices
import AppKit
import CoreGraphics

class AXActions {
    let pid: pid_t
    let appName: String

    init(pid: pid_t, appName: String) {
        self.pid = pid
        self.appName = appName
    }

    // MARK: - Click by Coordinates

    func click(x: Double, y: Double, button: String = "left", useGuard: Bool = false) -> ActionResponse {
        let traverser = AXTraverser(pid: pid, appName: appName)
        let preTrav = traverser.traverse()

        // Activate the app first
        activateApp()

        let guard_ = useGuard ? InputGuard.shared : nil
        guard_?.engage(message: "Vodou is clicking in \(appName)... Press Esc to cancel")
        defer { guard_?.disengage() }

        performClick(x: x, y: y, button: button)
        usleep(100_000) // 100ms delay

        if guard_?.isCancelled == true {
            guard_?.disengage()
            outputError("cancelled", message: "Action cancelled by user")
            exit(1)
        }

        let postTrav = traverser.traverse()
        let diff = AXDiff.computeDiff(before: preTrav.tree, after: postTrav.tree)

        return ActionResponse(
            action: "click", app: appName, pid: Int(pid),
            tree: postTrav.tree, truncated: postTrav.truncated,
            diff: diff, tmpFile: postTrav.tmp_file
        )
    }

    // MARK: - Click by Element Text

    func clickElement(text: String, role: String? = nil, button: String = "left", useGuard: Bool = false) -> ActionResponse {
        let traverser = AXTraverser(pid: pid, appName: appName)
        let preTrav = traverser.traverse()

        // Find the element in the traversed model (for bounds fallback)
        let matches = preTrav.tree.filter { el in
            let textMatch = (el.title?.lowercased().contains(text.lowercased()) == true) ||
                           (el.value?.lowercased().contains(text.lowercased()) == true)
            if let role = role {
                return textMatch && el.role == role
            }
            return textMatch
        }

        guard let target = matches.first else {
            outputError("element_not_found",
                       message: "No element found matching '\(text)'" + (role.map { " with role \($0)" } ?? ""),
                       app: appName)
            exit(1)
        }

        let guard_ = useGuard ? InputGuard.shared : nil
        guard_?.engage(message: "Vodou is clicking '\(text)' in \(appName)... Press Esc to cancel")
        defer { guard_?.disengage() }

        // Primary path: AX action (works across Spaces, no screen-coordinate fragility).
        // Only for left-click — right/double need real mouse events.
        var usedAXAction = false
        if button == "left" {
            if let axElement = findAXElement(text: text, role: role) {
                let axResult = AXUIElementPerformAction(axElement, kAXPressAction as CFString)
                if axResult == .success {
                    usedAXAction = true
                }
            }
        }

        // Fallback: coordinate-based mouse click (right-click, double-click, or AX action miss)
        if !usedAXAction {
            guard let pos = target.position, let size = target.size else {
                outputError("element_no_bounds",
                           message: "Element '\(text)' has no bounds for coordinate click",
                           app: appName)
                exit(1)
            }
            let centerX = pos.x + size.width / 2.0
            let centerY = pos.y + size.height / 2.0
            activateApp()
            performClick(x: centerX, y: centerY, button: button)
        }

        usleep(100_000)

        if guard_?.isCancelled == true {
            guard_?.disengage()
            outputError("cancelled", message: "Action cancelled by user")
            exit(1)
        }

        let postTrav = traverser.traverse()
        let diff = AXDiff.computeDiff(before: preTrav.tree, after: postTrav.tree)

        return ActionResponse(
            action: "click_element", app: appName, pid: Int(pid),
            tree: postTrav.tree, truncated: postTrav.truncated,
            diff: diff, tmpFile: postTrav.tmp_file
        )
    }

    // MARK: - Type Text

    func typeText(_ text: String, useGuard: Bool = false) -> ActionResponse {
        let traverser = AXTraverser(pid: pid, appName: appName)
        let preTrav = traverser.traverse()

        activateApp()

        let guard_ = useGuard ? InputGuard.shared : nil
        guard_?.engage(message: "Vodou is typing in \(appName)... Press Esc to cancel")
        defer { guard_?.disengage() }

        // Use AppleScript for reliable text input (handles non-ASCII, special chars)
        let escaped = text.replacingOccurrences(of: "\\", with: "\\\\")
                         .replacingOccurrences(of: "\"", with: "\\\"")
        let script = "tell application \"System Events\" to keystroke \"\(escaped)\""
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        try? process.run()
        process.waitUntilExit()

        usleep(100_000)

        if guard_?.isCancelled == true {
            guard_?.disengage()
            outputError("cancelled", message: "Action cancelled by user")
            exit(1)
        }

        let postTrav = traverser.traverse()
        let diff = AXDiff.computeDiff(before: preTrav.tree, after: postTrav.tree)

        return ActionResponse(
            action: "type", app: appName, pid: Int(pid),
            tree: postTrav.tree, truncated: postTrav.truncated,
            diff: diff, tmpFile: postTrav.tmp_file
        )
    }

    // MARK: - Press Key

    func pressKey(_ key: String, modifiers: [String] = [], useGuard: Bool = false) -> ActionResponse {
        let traverser = AXTraverser(pid: pid, appName: appName)
        let preTrav = traverser.traverse()

        activateApp()

        let guard_ = useGuard ? InputGuard.shared : nil
        let modStr = modifiers.isEmpty ? "" : " (\(modifiers.joined(separator: "+")))"
        guard_?.engage(message: "Vodou is pressing \(key)\(modStr) in \(appName)... Press Esc to cancel")
        defer { guard_?.disengage() }

        guard let keyCode = keyCodeMap[key.lowercased()] else {
            outputError("invalid_key", message: "Unknown key: \(key). Valid keys: \(keyCodeMap.keys.sorted().joined(separator: ", "))")
            exit(1)
        }

        var flags: CGEventFlags = []
        for mod in modifiers {
            switch mod.lowercased() {
            case "command", "cmd": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "option", "alt": flags.insert(.maskAlternate)
            case "control", "ctrl": flags.insert(.maskControl)
            default: break
            }
        }

        if let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
           let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) {
            keyDown.flags = flags
            keyUp.flags = flags
            keyDown.post(tap: .cghidEventTap)
            usleep(15_000) // 15ms between events
            keyUp.post(tap: .cghidEventTap)
        }

        usleep(100_000)

        if guard_?.isCancelled == true {
            guard_?.disengage()
            outputError("cancelled", message: "Action cancelled by user")
            exit(1)
        }

        let postTrav = traverser.traverse()
        let diff = AXDiff.computeDiff(before: preTrav.tree, after: postTrav.tree)

        return ActionResponse(
            action: "press_key", app: appName, pid: Int(pid),
            tree: postTrav.tree, truncated: postTrav.truncated,
            diff: diff, tmpFile: postTrav.tmp_file
        )
    }

    // MARK: - Scroll

    func scroll(x: Double, y: Double, direction: String = "down", amount: Int = 5, useGuard: Bool = false) -> ActionResponse {
        let traverser = AXTraverser(pid: pid, appName: appName)
        let preTrav = traverser.traverse()

        activateApp()

        let guard_ = useGuard ? InputGuard.shared : nil
        guard_?.engage(message: "Vodou is scrolling in \(appName)... Press Esc to cancel")
        defer { guard_?.disengage() }

        // Move mouse to scroll position
        CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
        usleep(50_000) // 50ms settle

        let scrollDelta: Int32 = direction == "up" ? 5 : -5
        for _ in 0..<amount {
            if let scrollEvent = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: scrollDelta, wheel2: 0, wheel3: 0) {
                scrollEvent.post(tap: .cghidEventTap)
                usleep(10_000) // 10ms between scroll events
            }
        }

        usleep(100_000)

        if guard_?.isCancelled == true {
            guard_?.disengage()
            outputError("cancelled", message: "Action cancelled by user")
            exit(1)
        }

        let postTrav = traverser.traverse()
        let diff = AXDiff.computeDiff(before: preTrav.tree, after: postTrav.tree)

        return ActionResponse(
            action: "scroll", app: appName, pid: Int(pid),
            tree: postTrav.tree, truncated: postTrav.truncated,
            diff: diff, tmpFile: postTrav.tmp_file
        )
    }

    // MARK: - Private Helpers

    private func activateApp() {
        let apps = NSWorkspace.shared.runningApplications.filter { $0.processIdentifier == pid }
        apps.first?.activate(options: .activateIgnoringOtherApps)
        usleep(50_000) // 50ms for activation
    }

    private func performClick(x: Double, y: Double, button: String) {
        let point = CGPoint(x: x, y: y)
        CGWarpMouseCursorPosition(point)
        usleep(15_000)

        let mouseButton: CGMouseButton = button == "right" ? .right : .left
        let downType: CGEventType = button == "right" ? .rightMouseDown : .leftMouseDown
        let upType: CGEventType = button == "right" ? .rightMouseUp : .leftMouseUp

        if let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: mouseButton),
           let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: mouseButton) {

            if button == "double" {
                down.setIntegerValueField(.mouseEventClickState, value: 2)
                up.setIntegerValueField(.mouseEventClickState, value: 2)
            }

            down.post(tap: .cghidEventTap)
            usleep(15_000)
            up.post(tap: .cghidEventTap)

            if button == "double" {
                usleep(50_000)
                down.post(tap: .cghidEventTap)
                usleep(15_000)
                up.post(tap: .cghidEventTap)
            }
        }
    }

    // MARK: - AX Element Finder (live tree walk, no model layer)

    /// BFS the live AX tree and return the first AXUIElement whose title/value/description
    /// contains `text` (case-insensitive) and whose role matches (if provided).
    private func findAXElement(text: String, role: String? = nil) -> AXUIElement? {
        let appElement = AXUIElementCreateApplication(pid)
        return searchAXTree(appElement, text: text.lowercased(), role: role, depth: 0)
    }

    private func searchAXTree(_ element: AXUIElement, text: String, role: String?, depth: Int) -> AXUIElement? {
        guard depth < 50 else { return nil }

        let elRole   = axString(element, kAXRoleAttribute as CFString) ?? ""
        let elTitle  = axString(element, kAXTitleAttribute as CFString)
                    ?? axString(element, kAXDescriptionAttribute as CFString)
        let elValue  = axString(element, kAXValueAttribute as CFString)

        let textMatch = (elTitle?.lowercased().contains(text) == true) ||
                        (elValue?.lowercased().contains(text) == true)
        let roleMatch = role == nil || elRole == role

        if textMatch && roleMatch { return element }

        var childrenRef: AnyObject?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
              let children = childrenRef as? [AXUIElement] else { return nil }

        for child in children {
            if let found = searchAXTree(child, text: text, role: role, depth: depth + 1) {
                return found
            }
        }
        return nil
    }

    private func axString(_ element: AXUIElement, _ attr: CFString) -> String? {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(element, attr, &value) == .success,
              let str = value as? String, !str.isEmpty else { return nil }
        return str
    }

    // MARK: - Key Code Map

    private let keyCodeMap: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49,
        "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
        "up": 126, "down": 125, "left": 123, "right": 124,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118,
        "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3,
        "g": 5, "h": 4, "i": 34, "j": 38, "k": 40, "l": 37,
        "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15,
        "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
        "y": 16, "z": 6,
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21,
        "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
        "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42,
        ";": 41, "'": 39, ",": 43, ".": 47, "/": 44, "`": 50,
    ]
}
