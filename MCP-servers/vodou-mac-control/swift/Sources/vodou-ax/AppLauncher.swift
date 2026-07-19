import Foundation
import AppKit

class AppLauncher {

    func openApp(_ name: String, waitSeconds: Int = 3, url: String? = nil) -> TraversalResponse {
        // If URL provided, open it (which launches the default app for that URL type)
        if let urlString = url, let nsUrl = URL(string: urlString) {
            NSWorkspace.shared.open(nsUrl)
            sleep(UInt32(waitSeconds))
            // Try to resolve whatever app opened
            if let (pid, resolvedName) = resolveApp(name) {
                let traverser = AXTraverser(pid: pid, appName: resolvedName)
                return traverser.traverse()
            }
        }

        // Check if already running
        if let (pid, resolvedName) = resolveApp(name) {
            // Activate it
            let apps = NSWorkspace.shared.runningApplications.filter { $0.processIdentifier == pid }
            apps.first?.activate(options: .activateIgnoringOtherApps)
            usleep(200_000) // 200ms for activation
            let traverser = AXTraverser(pid: pid, appName: resolvedName)
            return traverser.traverse()
        }

        // Try to launch it
        let appPath = findAppPath(name)
        guard let path = appPath else {
            outputError("app_not_found", message: "Could not find app '\(name)' in /Applications or ~/Applications", app: name)
            exit(1)
        }

        let config = NSWorkspace.OpenConfiguration()
        config.activates = true

        let semaphore = DispatchSemaphore(value: 0)
        var launchedApp: NSRunningApplication?
        var launchError: Error?

        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: config) { app, error in
            launchedApp = app
            launchError = error
            semaphore.signal()
        }

        let timeout = DispatchTime.now() + .seconds(waitSeconds)
        if semaphore.wait(timeout: timeout) == .timedOut {
            outputError("timeout", message: "App '\(name)' did not launch within \(waitSeconds) seconds", app: name)
            exit(1)
        }

        if let error = launchError {
            outputError("launch_failed", message: "Failed to launch '\(name)': \(error.localizedDescription)", app: name)
            exit(1)
        }

        // Wait for AX tree to be ready
        guard let app = launchedApp else {
            outputError("launch_failed", message: "App launched but no reference returned", app: name)
            exit(1)
        }

        // Poll for accessibility readiness
        let pid = app.processIdentifier
        let resolvedName = app.localizedName ?? name
        let startTime = Date()

        while Date().timeIntervalSince(startTime) < Double(waitSeconds) {
            let appElement = AXUIElementCreateApplication(pid)
            var value: AnyObject?
            let result = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &value)
            if result == .success, let windows = value as? [AXUIElement], !windows.isEmpty {
                break
            }
            usleep(200_000) // 200ms between polls
        }

        let traverser = AXTraverser(pid: pid, appName: resolvedName)
        return traverser.traverse()
    }

    // MARK: - App Path Discovery

    private func findAppPath(_ name: String) -> String? {
        let searchPaths = [
            "/Applications",
            "\(NSHomeDirectory())/Applications",
            "/System/Applications",
            "/System/Applications/Utilities",
        ]

        let variations = [
            "\(name).app",
            name,
        ]

        for dir in searchPaths {
            for variant in variations {
                let path = "\(dir)/\(variant)"
                if FileManager.default.fileExists(atPath: path) {
                    return path
                }
            }
        }

        // Try Spotlight search as last resort
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
        task.arguments = ["kMDItemKind == 'Application' && kMDItemDisplayName == '\(name)'"]
        let pipe = Pipe()
        task.standardOutput = pipe
        try? task.run()
        task.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if let firstResult = output.split(separator: "\n").first {
            return String(firstResult)
        }

        return nil
    }
}
