import Foundation
import AppKit
import CoreGraphics

/// Blocks user input during automation actions.
/// Press Escape to cancel. 30-second watchdog prevents permanent lockout.
class InputGuard {
    static let shared = InputGuard()

    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var watchdogTimer: DispatchSourceTimer?
    private let lock = NSLock()
    private var _engaged = false
    private var _cancelled = false
    private var savedMousePos: CGPoint?
    private var savedFrontApp: NSRunningApplication?

    var isEngaged: Bool { lock.lock(); defer { lock.unlock() }; return _engaged }
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return _cancelled }

    func engage(message: String) {
        lock.lock()
        guard !_engaged else { lock.unlock(); return }
        _engaged = true
        _cancelled = false
        lock.unlock()

        // Save state for restoration
        savedMousePos = CGEvent(source: nil)?.location
        savedFrontApp = NSWorkspace.shared.frontmostApplication

        // Install event tap to block input
        let mask: CGEventMask = (1 << CGEventType.keyDown.rawValue) |
                                (1 << CGEventType.keyUp.rawValue) |
                                (1 << CGEventType.leftMouseDown.rawValue) |
                                (1 << CGEventType.leftMouseUp.rawValue) |
                                (1 << CGEventType.rightMouseDown.rawValue) |
                                (1 << CGEventType.rightMouseUp.rawValue) |
                                (1 << CGEventType.mouseMoved.rawValue) |
                                (1 << CGEventType.scrollWheel.rawValue)

        let callback: CGEventTapCallBack = { proxy, type, event, refcon in
            let guard_ = Unmanaged<InputGuard>.fromOpaque(refcon!).takeUnretainedValue()

            // Allow Escape through as cancellation
            if type == .keyDown {
                let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
                if keyCode == 53 { // Escape
                    guard_.lock.lock()
                    guard_._cancelled = true
                    guard_.lock.unlock()
                    return nil // Suppress the Escape key too
                }
            }

            // Block everything else
            return nil
        }

        let refcon = Unmanaged.passUnretained(self).toOpaque()
        eventTap = CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: refcon
        )

        if let tap = eventTap {
            runLoopSource = CFMachPortCreateRunLoopSource(nil, tap, 0)
            CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
        }

        // 30-second watchdog — auto-disengage if we crash or hang
        watchdogTimer = DispatchSource.makeTimerSource(queue: .main)
        watchdogTimer?.schedule(deadline: .now() + 30)
        watchdogTimer?.setEventHandler { [weak self] in
            fputs("[vodou-ax] Watchdog: auto-disengaging input guard after 30s\n", stderr)
            self?.disengage()
        }
        watchdogTimer?.resume()

        fputs("[vodou-ax] Input guard engaged: \(message)\n", stderr)
    }

    func disengage() {
        lock.lock()
        guard _engaged else { lock.unlock(); return }
        _engaged = false
        lock.unlock()

        // Remove event tap
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
            if let source = runLoopSource {
                CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
            }
        }
        eventTap = nil
        runLoopSource = nil

        // Cancel watchdog
        watchdogTimer?.cancel()
        watchdogTimer = nil

        // Restore cursor position
        if let pos = savedMousePos {
            CGWarpMouseCursorPosition(pos)
        }

        fputs("[vodou-ax] Input guard disengaged\n", stderr)
    }
}
