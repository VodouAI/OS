import Foundation

// MARK: - Accessibility Element

struct AXElementData: Codable {
    let id: Int
    let role: String
    let title: String?
    let value: String?
    let position: Point?
    let size: Size?
    let enabled: Bool
    let focused: Bool
    let children: [Int]
    let actions: [String]

    struct Point: Codable {
        let x: Double
        let y: Double
    }

    struct Size: Codable {
        let width: Double
        let height: Double
    }
}

// MARK: - Diff

struct DiffResult: Codable {
    let added: [DiffElement]
    let removed: [DiffElement]
    let modified: [ModifiedElement]

    struct DiffElement: Codable {
        let id: Int
        let role: String
        let title: String?
    }

    struct ModifiedElement: Codable {
        let id: Int
        let role: String
        let field: String
        let old: String?
        let new: String?
    }
}

// MARK: - Responses

struct TraversalResponse: Codable {
    let ok: Bool
    let app: String?
    let pid: Int?
    let timestamp: String
    let element_count: Int
    let truncated: Bool
    let tree: [AXElementData]
    let tmp_file: String?

    init(app: String, pid: Int, tree: [AXElementData], truncated: Bool, tmpFile: String?) {
        self.ok = true
        self.app = app
        self.pid = pid
        self.timestamp = ISO8601DateFormatter().string(from: Date())
        self.element_count = tree.count
        self.truncated = truncated
        self.tree = tree
        self.tmp_file = tmpFile
    }
}

struct ActionResponse: Codable {
    let ok: Bool
    let action: String
    let app: String?
    let pid: Int?
    let timestamp: String
    let element_count: Int
    let truncated: Bool
    let tree: [AXElementData]
    let diff: DiffResult?
    let tmp_file: String?

    init(action: String, app: String, pid: Int, tree: [AXElementData], truncated: Bool, diff: DiffResult?, tmpFile: String?) {
        self.ok = true
        self.action = action
        self.app = app
        self.pid = pid
        self.timestamp = ISO8601DateFormatter().string(from: Date())
        self.element_count = tree.count
        self.truncated = truncated
        self.tree = tree
        self.diff = diff
        self.tmp_file = tmpFile
    }
}

struct ScreenshotResponse: Codable {
    let ok: Bool
    let app: String?
    let pid: Int?
    let screenshot_path: String
    let size_bytes: Int
    var capture_method: String?  // "window" or "fullscreen"
}

struct ClipboardResponse: Codable {
    let ok: Bool
    let content: String?
    let written: Bool?
}

struct WindowInfo: Codable {
    let app: String
    let title: String
    let pid: Int
    let bounds: Bounds
    let layer: Int
    let on_screen: Bool

    struct Bounds: Codable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }
}

struct WindowsResponse: Codable {
    let ok: Bool
    let windows: [WindowInfo]?
    let focused: String?
    let action_result: String?
}

struct PermissionResponse: Codable {
    let ok: Bool
    let accessibility_granted: Bool
}

struct ErrorResponse: Codable {
    let ok: Bool
    let error: String
    let message: String
    let app: String?

    init(error: String, message: String, app: String? = nil) {
        self.ok = false
        self.error = error
        self.message = message
        self.app = app
    }
}

// MARK: - JSON Output

let jsonEncoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return encoder
}()

func outputJSON<T: Encodable>(_ value: T) {
    if let data = try? jsonEncoder.encode(value),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

func outputError(_ error: String, message: String, app: String? = nil) {
    outputJSON(ErrorResponse(error: error, message: message, app: app))
}
