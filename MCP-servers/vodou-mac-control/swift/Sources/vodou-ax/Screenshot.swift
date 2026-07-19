import Foundation
import CoreGraphics
import AppKit
import ScreenCaptureKit

class Screenshot {

    func captureWindow(pid: pid_t, appName: String, annotateClick: (Double, Double)? = nil) -> ScreenshotResponse {
        // Primary: use screencapture CLI — reliable on Sequoia, inherits terminal's Screen Recording permission.
        // SCK window-specific capture can hard-crash (CGS_REQUIRE_INIT assertion) when invoked as a subprocess,
        // so we use the CLI approach first and only try SCK as a fallback.
        if let cliImage = captureWithScreencaptureCLI(pid: pid, appName: appName) {
            return finalize(image: cliImage, appName: appName, pid: pid, method: "screencapture-cli", annotateClick: annotateClick)
        }

        // Fallback: try ScreenCaptureKit (may work in some configurations)
        if let sckImage = captureWithScreenCaptureKit(pid: pid, appName: appName) {
            return finalize(image: sckImage, appName: appName, pid: pid, method: "screencapturekit", annotateClick: annotateClick)
        }

        outputError("screenshot_failed",
                   message: "Could not capture window for '\(appName)'. Vodou needs Screen Recording permission. Add vodou-ax in System Settings > Privacy & Security > Screen Recording.",
                   app: appName)
        exit(1)
    }

    func captureScreen(annotateClick: (Double, Double)? = nil) -> ScreenshotResponse {
        // Full screen via ScreenCaptureKit
        let image = captureFullScreenSCK()

        guard let image = image else {
            // Fallback to legacy
            guard let legacy = CGWindowListCreateImage(.infinite, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]) else {
                outputError("screenshot_failed", message: "Could not capture screen. Grant Screen Recording permission.")
                exit(1)
            }
            return finalize(image: legacy, appName: "screen", pid: nil, method: "legacy", annotateClick: annotateClick)
        }

        return finalize(image: image, appName: "screen", pid: nil, method: "screencapturekit", annotateClick: annotateClick)
    }

    // MARK: - ScreenCaptureKit (macOS 13+, works on Sequoia)

    private func captureWithScreenCaptureKit(pid: pid_t, appName: String) -> CGImage? {
        let semaphore = DispatchSemaphore(value: 0)
        var result: CGImage?

        // Get shareable content (triggers permission prompt if needed)
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            guard let content = content else {
                fputs("[vodou-ax] ScreenCaptureKit: \(error?.localizedDescription ?? "unknown error")\n", stderr)
                semaphore.signal()
                return
            }

            // Find the window belonging to our target PID
            let targetWindow = content.windows.first { window in
                window.owningApplication?.processID == pid
            }

            guard let window = targetWindow else {
                fputs("[vodou-ax] ScreenCaptureKit: no window found for pid \(pid)\n", stderr)
                semaphore.signal()
                return
            }

            // Create a filter for just this window
            let filter = SCContentFilter(desktopIndependentWindow: window)

            let config = SCStreamConfiguration()
            config.width = Int(window.frame.width) * 2  // Retina
            config.height = Int(window.frame.height) * 2
            config.showsCursor = false
            if #available(macOS 14.0, *) { config.captureResolution = .best }

            // Capture the screenshot
            if #available(macOS 14.0, *) {
                SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
                    if let error = error {
                        fputs("[vodou-ax] SCScreenshotManager: \(error.localizedDescription)\n", stderr)
                    }
                    result = image
                    semaphore.signal()
                }
            } else {
                // macOS 13: use SCStream to capture a single frame
                fputs("[vodou-ax] SCScreenshotManager requires macOS 14+, falling back\n", stderr)
                semaphore.signal()
            }
        }

        let timeout = DispatchTime.now() + .seconds(5)
        _ = semaphore.wait(timeout: timeout)
        return result
    }

    private func captureFullScreenSCK() -> CGImage? {
        let semaphore = DispatchSemaphore(value: 0)
        var result: CGImage?

        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
            guard let content = content, let display = content.displays.first else {
                semaphore.signal()
                return
            }

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.width = Int(display.width) * 2
            config.height = Int(display.height) * 2
            config.showsCursor = false
            if #available(macOS 14.0, *) { config.captureResolution = .best }

            if #available(macOS 14.0, *) {
                SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
                    result = image
                    semaphore.signal()
                }
            } else {
                semaphore.signal()
            }
        }

        _ = semaphore.wait(timeout: .now() + .seconds(5))
        return result
    }

    // MARK: - Fallback: screencapture CLI (inherits terminal's Screen Recording permission)

    private func captureWithScreencaptureCLI(pid: pid_t, appName: String) -> CGImage? {
        // Get the window ID from CGWindowListCopyWindowInfo (metadata-only, no CGS init needed)
        guard let windowList = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
            fputs("[vodou-ax] screencapture fallback: could not list windows\n", stderr)
            return nil
        }

        // Filter for normal windows (layer 0) matching this PID — skip desktop, menubar, etc.
        guard let windowInfo = windowList.first(where: {
            ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) &&
            ($0[kCGWindowLayer as String] as? Int) == 0
        }), let windowId = windowInfo[kCGWindowNumber as String] as? CGWindowID else {
            fputs("[vodou-ax] screencapture fallback: no window found for pid \(pid)\n", stderr)
            return nil
        }

        // Use screencapture -l <windowID> — Apple's CLI that inherits terminal permissions
        let dir = "/tmp/vodou-ax/screenshots"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let timestamp = Int(Date().timeIntervalSince1970)
        let tmpPath = "\(dir)/\(appName)-\(timestamp)-cli.png"

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-l", String(windowId), "-o", "-x", tmpPath]  // -o no shadow, -x no sound

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            fputs("[vodou-ax] screencapture failed to launch: \(error)\n", stderr)
            return nil
        }

        guard process.terminationStatus == 0 else {
            fputs("[vodou-ax] screencapture exited with status \(process.terminationStatus)\n", stderr)
            return nil
        }

        // Load the PNG back as CGImage
        guard let dataProvider = CGDataProvider(filename: tmpPath),
              let image = CGImage(pngDataProviderSource: dataProvider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else {
            fputs("[vodou-ax] screencapture: could not load captured image from \(tmpPath)\n", stderr)
            return nil
        }

        // Remove the temp CLI file — finalize() will save with the canonical name
        try? FileManager.default.removeItem(atPath: tmpPath)

        return image
    }

    // MARK: - Finalize (annotate + save)

    private func finalize(image: CGImage, appName: String, pid: pid_t?, method: String, annotateClick: (Double, Double)?) -> ScreenshotResponse {
        let finalImage: CGImage
        if let (cx, cy) = annotateClick {
            finalImage = drawCrosshair(on: image, x: cx, y: cy) ?? image
        } else {
            finalImage = image
        }

        let path = saveImage(finalImage, appName: appName)
        let fileSize = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0

        var resp = ScreenshotResponse(ok: true, app: appName, pid: pid.map(Int.init), screenshot_path: path, size_bytes: fileSize)
        resp.capture_method = method
        return resp
    }

    // MARK: - Annotation

    private func drawCrosshair(on image: CGImage, x: Double, y: Double) -> CGImage? {
        let width = image.width
        let height = image.height
        let colorSpace = CGColorSpaceCreateDeviceRGB()

        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: 4 * width, space: colorSpace,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }

        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        let flippedY = Double(height) - y
        context.setStrokeColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.setLineWidth(3.0)

        let radius = 15.0
        context.strokeEllipse(in: CGRect(x: x - radius, y: flippedY - radius, width: radius * 2, height: radius * 2))

        let lineLen = 25.0
        context.move(to: CGPoint(x: x - lineLen, y: flippedY))
        context.addLine(to: CGPoint(x: x + lineLen, y: flippedY))
        context.move(to: CGPoint(x: x, y: flippedY - lineLen))
        context.addLine(to: CGPoint(x: x, y: flippedY + lineLen))
        context.strokePath()

        return context.makeImage()
    }

    // MARK: - Save

    private func saveImage(_ image: CGImage, appName: String) -> String {
        let dir = "/tmp/vodou-ax/screenshots"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let timestamp = Int(Date().timeIntervalSince1970)
        let path = "\(dir)/\(appName)-\(timestamp).png"

        let url = URL(fileURLWithPath: path)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
            return path
        }
        CGImageDestinationAddImage(dest, image, nil)
        CGImageDestinationFinalize(dest)

        return path
    }
}
