import Foundation
import AppKit

// MARK: - Argument Parsing

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : ""

func getArg(_ flag: String) -> String? {
    guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
    return args[idx + 1]
}

func hasFlag(_ flag: String) -> Bool {
    args.contains(flag)
}

func getIntArg(_ flag: String, default defaultVal: Int) -> Int {
    guard let val = getArg(flag) else { return defaultVal }
    return Int(val) ?? defaultVal
}

func getDoubleArg(_ flag: String, default defaultVal: Double) -> Double {
    guard let val = getArg(flag) else { return defaultVal }
    return Double(val) ?? defaultVal
}

// MARK: - App Resolution

func resolveApp(_ name: String) -> (pid: pid_t, appName: String)? {
    let workspace = NSWorkspace.shared
    let running = workspace.runningApplications

    // Try exact name match first
    if let app = running.first(where: { $0.localizedName?.lowercased() == name.lowercased() }) {
        return (app.processIdentifier, app.localizedName ?? name)
    }

    // Try prefix match
    if let app = running.first(where: { $0.localizedName?.lowercased().hasPrefix(name.lowercased()) == true }) {
        return (app.processIdentifier, app.localizedName ?? name)
    }

    // Try bundle ID match
    if let app = running.first(where: { $0.bundleIdentifier?.lowercased() == name.lowercased() }) {
        return (app.processIdentifier, app.localizedName ?? name)
    }

    // Try contains match
    if let app = running.first(where: { $0.localizedName?.lowercased().contains(name.lowercased()) == true }) {
        return (app.processIdentifier, app.localizedName ?? name)
    }

    return nil
}

// MARK: - Command Dispatch

switch command {
case "traverse":
    guard let appName = getArg("--app") else {
        outputError("missing_arg", message: "--app is required")
        exit(1)
    }
    guard let (pid, resolvedName) = resolveApp(appName) else {
        outputError("app_not_found", message: "App '\(appName)' is not running", app: appName)
        exit(1)
    }
    // Ensure AX is trusted. Pass --prompt flag to trigger TCC dialog on first run.
    let traversePromptOpts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): hasFlag("--prompt") as AnyObject] as CFDictionary
    if !AXIsProcessTrustedWithOptions(traversePromptOpts) && !hasFlag("--no-trust-check") {
        outputError("accessibility_denied", message: "Accessibility permission not granted. Run with --prompt flag from an interactive context to trigger the TCC dialog, or add this binary in System Settings > Privacy > Accessibility.")
        exit(1)
    }
    let maxDepth = getIntArg("--max-depth", default: 100)
    let maxElements = getIntArg("--max-elements", default: 2000)
    let timeout = getDoubleArg("--timeout", default: 5.0)

    let traverser = AXTraverser(pid: pid, appName: resolvedName, maxDepth: maxDepth, maxElements: maxElements, timeout: timeout)
    let result = traverser.traverse()
    outputJSON(result)

case "click":
    guard let appName = getArg("--app") else {
        outputError("missing_arg", message: "--app is required")
        exit(1)
    }
    guard let (pid, resolvedName) = resolveApp(appName) else {
        outputError("app_not_found", message: "App '\(appName)' is not running", app: appName)
        exit(1)
    }

    let useGuard = hasFlag("--guard")
    let button = getArg("--button") ?? "left"

    // Check if clicking by element text or by coordinates
    if let elementText = getArg("--element") {
        let role = getArg("--role")
        let actions = AXActions(pid: pid, appName: resolvedName)
        let result = actions.clickElement(text: elementText, role: role, button: button, useGuard: useGuard)
        outputJSON(result)
    } else if let xStr = getArg("--x"), let yStr = getArg("--y"),
              let x = Double(xStr), let y = Double(yStr) {
        let actions = AXActions(pid: pid, appName: resolvedName)
        let result = actions.click(x: x, y: y, button: button, useGuard: useGuard)
        outputJSON(result)
    } else {
        outputError("missing_arg", message: "--x and --y (or --element) are required")
        exit(1)
    }

case "type":
    guard let appName = getArg("--app") else {
        outputError("missing_arg", message: "--app is required")
        exit(1)
    }
    guard let text = getArg("--text") else {
        outputError("missing_arg", message: "--text is required")
        exit(1)
    }
    guard let (pid, resolvedName) = resolveApp(appName) else {
        outputError("app_not_found", message: "App '\(appName)' is not running", app: appName)
        exit(1)
    }
    let useGuard = hasFlag("--guard")
    let actions = AXActions(pid: pid, appName: resolvedName)
    let result = actions.typeText(text, useGuard: useGuard)
    outputJSON(result)

case "press-key":
    guard let appName = getArg("--app") else {
        outputError("missing_arg", message: "--app is required")
        exit(1)
    }
    guard let key = getArg("--key") else {
        outputError("missing_arg", message: "--key is required")
        exit(1)
    }
    guard let (pid, resolvedName) = resolveApp(appName) else {
        outputError("app_not_found", message: "App '\(appName)' is not running", app: appName)
        exit(1)
    }
    let modifiers = getArg("--modifiers")?.split(separator: ",").map(String.init) ?? []
    let useGuard = hasFlag("--guard")
    let actions = AXActions(pid: pid, appName: resolvedName)
    let result = actions.pressKey(key, modifiers: modifiers, useGuard: useGuard)
    outputJSON(result)

case "scroll":
    guard let appName = getArg("--app") else {
        outputError("missing_arg", message: "--app is required")
        exit(1)
    }
    guard let xStr = getArg("--x"), let yStr = getArg("--y"),
          let x = Double(xStr), let y = Double(yStr) else {
        outputError("missing_arg", message: "--x and --y are required")
        exit(1)
    }
    guard let (pid, resolvedName) = resolveApp(appName) else {
        outputError("app_not_found", message: "App '\(appName)' is not running", app: appName)
        exit(1)
    }
    let direction = getArg("--direction") ?? "down"
    let amount = getIntArg("--amount", default: 5)
    let useGuard = hasFlag("--guard")
    let actions = AXActions(pid: pid, appName: resolvedName)
    let result = actions.scroll(x: x, y: y, direction: direction, amount: amount, useGuard: useGuard)
    outputJSON(result)

case "open":
    guard let appName = getArg("--app") else {
        outputError("missing_arg", message: "--app is required")
        exit(1)
    }
    let waitSeconds = getIntArg("--wait-seconds", default: 3)
    let url = getArg("--url")
    let launcher = AppLauncher()
    let result = launcher.openApp(appName, waitSeconds: waitSeconds, url: url)
    outputJSON(result)

case "screenshot":
    let appName = getArg("--app")
    // For annotation, parse the two args after --annotate-click
    var clickAnnotation: (Double, Double)? = nil
    if let idx = args.firstIndex(of: "--annotate-click"), idx + 2 < args.count,
       let ax = Double(args[idx + 1]), let ay = Double(args[idx + 2]) {
        clickAnnotation = (ax, ay)
    }

    let screenshotter = Screenshot()
    if let appName = appName, let (pid, resolvedName) = resolveApp(appName) {
        let result = screenshotter.captureWindow(pid: pid, appName: resolvedName, annotateClick: clickAnnotation)
        outputJSON(result)
    } else {
        let result = screenshotter.captureScreen(annotateClick: clickAnnotation)
        outputJSON(result)
    }

case "clipboard":
    if hasFlag("--read") {
        let content = NSPasteboard.general.string(forType: .string)
        outputJSON(ClipboardResponse(ok: true, content: content, written: nil))
    } else if let text = getArg("--write") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        outputJSON(ClipboardResponse(ok: true, content: nil, written: true))
    } else {
        outputError("missing_arg", message: "--read or --write is required")
        exit(1)
    }

case "windows":
    if hasFlag("--list") {
        let wm = WindowManager()
        let result = wm.listWindows()
        outputJSON(result)
    } else if let appName = getArg("--focus") {
        let wm = WindowManager()
        let result = wm.focusWindow(appName: appName)
        outputJSON(result)
    } else if let appName = getArg("--resize") {
        let width = getIntArg("--width", default: 0)
        let height = getIntArg("--height", default: 0)
        let wm = WindowManager()
        let result = wm.resizeWindow(appName: appName, width: width, height: height)
        outputJSON(result)
    } else if let appName = getArg("--move") {
        let x = getIntArg("--x", default: 0)
        let y = getIntArg("--y", default: 0)
        let wm = WindowManager()
        let result = wm.moveWindow(appName: appName, x: x, y: y)
        outputJSON(result)
    } else if let appName = getArg("--minimize") {
        let wm = WindowManager()
        let result = wm.minimizeWindow(appName: appName)
        outputJSON(result)
    } else {
        outputError("missing_arg", message: "--list, --focus, --resize, --move, or --minimize is required")
        exit(1)
    }

case "check-permission":
    // Use prompt:true so the first call from any context registers the real CDHash in TCC
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): hasFlag("--prompt") as AnyObject] as CFDictionary
    let trusted = AXIsProcessTrustedWithOptions(options)
    outputJSON(PermissionResponse(ok: true, accessibility_granted: trusted))

default:
    fputs("""
    vodou-ax — macOS accessibility automation for Vodou

    Usage:
      vodou-ax traverse --app <name> [--max-depth N] [--max-elements N] [--timeout S]
      vodou-ax click --app <name> --x N --y N [--button left|right] [--guard]
      vodou-ax click --app <name> --element <text> [--role AXButton] [--guard]
      vodou-ax type --app <name> --text <text> [--guard]
      vodou-ax press-key --app <name> --key <name> [--modifiers cmd,shift] [--guard]
      vodou-ax scroll --app <name> --x N --y N [--direction up|down] [--amount N] [--guard]
      vodou-ax open --app <name> [--wait-seconds N] [--url <url>]
      vodou-ax screenshot [--app <name>] [--annotate-click X Y]
      vodou-ax clipboard --read | --write <text>
      vodou-ax windows --list | --focus <name> | --resize <name> --width W --height H
      vodou-ax check-permission
    """, stderr)
    exit(2)
}
