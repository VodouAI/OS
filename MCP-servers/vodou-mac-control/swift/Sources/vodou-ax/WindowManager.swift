import Foundation
import CoreGraphics
import AppKit
import ApplicationServices

class WindowManager {

    func listWindows() -> WindowsResponse {
        guard let windowList = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
            return WindowsResponse(ok: true, windows: [], focused: nil, action_result: nil)
        }

        let windows = windowList.compactMap { info -> WindowInfo? in
            guard let ownerName = info[kCGWindowOwnerName as String] as? String,
                  let pid = info[kCGWindowOwnerPID as String] as? Int,
                  let layer = info[kCGWindowLayer as String] as? Int,
                  layer == 0, // Only normal windows (not menubar, dock, etc.)
                  let bounds = info[kCGWindowBounds as String] as? [String: Double] else { return nil }

            let title = info[kCGWindowName as String] as? String ?? ""
            let onScreen = info[kCGWindowIsOnscreen as String] as? Bool ?? true

            return WindowInfo(
                app: ownerName,
                title: title,
                pid: pid,
                bounds: WindowInfo.Bounds(
                    x: bounds["X"] ?? 0,
                    y: bounds["Y"] ?? 0,
                    width: bounds["Width"] ?? 0,
                    height: bounds["Height"] ?? 0
                ),
                layer: layer,
                on_screen: onScreen
            )
        }

        return WindowsResponse(ok: true, windows: windows, focused: nil, action_result: nil)
    }

    func focusWindow(appName: String) -> WindowsResponse {
        guard let (pid, resolvedName) = resolveApp(appName) else {
            outputError("app_not_found", message: "App '\(appName)' is not running", app: appName)
            exit(1)
        }

        let apps = NSWorkspace.shared.runningApplications.filter { $0.processIdentifier == pid }
        if let app = apps.first {
            app.activate(options: .activateIgnoringOtherApps)
            return WindowsResponse(ok: true, windows: nil, focused: resolvedName, action_result: "focused")
        }

        outputError("focus_failed", message: "Could not focus '\(appName)'", app: appName)
        exit(1)
    }

    func resizeWindow(appName: String, width: Int, height: Int) -> WindowsResponse {
        guard let (pid, resolvedName) = resolveApp(appName) else {
            outputError("app_not_found", message: "App '\(appName)' is not running", app: appName)
            exit(1)
        }

        let appElement = AXUIElementCreateApplication(pid)
        guard let window = getFirstWindow(appElement) else {
            outputError("no_window", message: "No window found for '\(appName)'", app: appName)
            exit(1)
        }

        if width > 0 && height > 0 {
            var size = CGSize(width: CGFloat(width), height: CGFloat(height))
            if let sizeValue = AXValueCreate(.cgSize, &size) {
                AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue)
            }
        }

        return WindowsResponse(ok: true, windows: nil, focused: nil, action_result: "resized \(resolvedName) to \(width)x\(height)")
    }

    func moveWindow(appName: String, x: Int, y: Int) -> WindowsResponse {
        guard let (pid, resolvedName) = resolveApp(appName) else {
            outputError("app_not_found", message: "App '\(appName)' is not running", app: appName)
            exit(1)
        }

        let appElement = AXUIElementCreateApplication(pid)
        guard let window = getFirstWindow(appElement) else {
            outputError("no_window", message: "No window found for '\(appName)'", app: appName)
            exit(1)
        }

        var position = CGPoint(x: CGFloat(x), y: CGFloat(y))
        if let posValue = AXValueCreate(.cgPoint, &position) {
            AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, posValue)
        }

        return WindowsResponse(ok: true, windows: nil, focused: nil, action_result: "moved \(resolvedName) to (\(x), \(y))")
    }

    func minimizeWindow(appName: String) -> WindowsResponse {
        guard let (pid, resolvedName) = resolveApp(appName) else {
            outputError("app_not_found", message: "App '\(appName)' is not running", app: appName)
            exit(1)
        }

        let appElement = AXUIElementCreateApplication(pid)
        guard let window = getFirstWindow(appElement) else {
            outputError("no_window", message: "No window found for '\(appName)'", app: appName)
            exit(1)
        }

        AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, true as CFBoolean)

        return WindowsResponse(ok: true, windows: nil, focused: nil, action_result: "minimized \(resolvedName)")
    }

    // MARK: - Helpers

    private func getFirstWindow(_ appElement: AXUIElement) -> AXUIElement? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &value)
        guard result == .success, let windows = value as? [AXUIElement], let first = windows.first else { return nil }
        return first
    }
}
