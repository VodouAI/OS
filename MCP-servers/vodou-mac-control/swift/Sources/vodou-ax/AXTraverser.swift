import Foundation
import ApplicationServices
import AppKit

class AXTraverser {
    let pid: pid_t
    let appName: String
    let maxDepth: Int
    let maxElements: Int
    let timeout: TimeInterval

    private var elements: [AXElementData] = []
    private var nextId = 0
    private var startTime: Date = Date()
    private var truncated = false

    init(pid: pid_t, appName: String, maxDepth: Int = 100, maxElements: Int = 2000, timeout: TimeInterval = 5.0) {
        self.pid = pid
        self.appName = appName
        self.maxDepth = maxDepth
        self.maxElements = maxElements
        self.timeout = timeout
    }

    func traverse() -> TraversalResponse {
        elements = []
        nextId = 0
        startTime = Date()
        truncated = false

        let appElement = AXUIElementCreateApplication(pid)
        traverseElement(appElement, depth: 0)

        let tmpFile = writeTmpFile()
        return TraversalResponse(app: appName, pid: Int(pid), tree: elements, truncated: truncated, tmpFile: tmpFile)
    }

    // MARK: - BFS Traversal

    private func traverseElement(_ element: AXUIElement, depth: Int) {
        guard depth < maxDepth else { truncated = true; return }
        guard elements.count < maxElements else { truncated = true; return }
        guard Date().timeIntervalSince(startTime) < timeout else { truncated = true; return }

        let role = getStringAttr(element, kAXRoleAttribute as CFString) ?? "Unknown"
        let title = getStringAttr(element, kAXTitleAttribute as CFString)
            ?? getStringAttr(element, kAXDescriptionAttribute as CFString)
        let value = getValueString(element)

        // Skip non-interactable elements without useful text
        let hasText = title != nil || value != nil
        let isInteractable = ["AXButton", "AXTextField", "AXTextArea", "AXCheckBox",
                              "AXRadioButton", "AXComboBox", "AXLink", "AXMenuButton",
                              "AXMenuItem", "AXPopUpButton", "AXSlider", "AXTab",
                              "AXWindow", "AXSheet", "AXMenu", "AXMenuBar",
                              "AXMenuBarItem", "AXToolbar", "AXTabGroup"].contains(role)
        guard hasText || isInteractable || depth < 3 else { return }

        let position = getPointAttr(element, kAXPositionAttribute as CFString)
        let size = getSizeAttr(element, kAXSizeAttribute as CFString)
        let enabled = getBoolAttr(element, kAXEnabledAttribute as CFString) ?? true
        let focused = getBoolAttr(element, kAXFocusedAttribute as CFString) ?? false
        let actions = getActions(element)

        let currentId = nextId
        nextId += 1

        // Get children IDs (will be filled as we traverse)
        var childIds: [Int] = []
        let children = getChildren(element)

        let elementData = AXElementData(
            id: currentId,
            role: role,
            title: title,
            value: value,
            position: position.map { AXElementData.Point(x: $0.x, y: $0.y) },
            size: size.map { AXElementData.Size(width: $0.width, height: $0.height) },
            enabled: enabled,
            focused: focused,
            children: [], // Will be updated after children are traversed
            actions: actions
        )
        elements.append(elementData)

        // Traverse children
        for child in children {
            guard elements.count < maxElements else { truncated = true; break }
            guard Date().timeIntervalSince(startTime) < timeout else { truncated = true; break }
            let childId = nextId
            childIds.append(childId)
            traverseElement(child, depth: depth + 1)
        }

        // Update children IDs
        if !childIds.isEmpty {
            elements[currentId] = AXElementData(
                id: currentId,
                role: elementData.role,
                title: elementData.title,
                value: elementData.value,
                position: elementData.position,
                size: elementData.size,
                enabled: elementData.enabled,
                focused: elementData.focused,
                children: childIds,
                actions: elementData.actions
            )
        }
    }

    // MARK: - AX Attribute Helpers

    private func getStringAttr(_ element: AXUIElement, _ attr: CFString) -> String? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(element, attr, &value)
        guard result == .success, let str = value as? String, !str.isEmpty else { return nil }
        return str
    }

    private func getValueString(_ element: AXUIElement) -> String? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
        guard result == .success else { return nil }
        if let str = value as? String, !str.isEmpty { return str }
        if let num = value as? NSNumber { return num.stringValue }
        return nil
    }

    private func getBoolAttr(_ element: AXUIElement, _ attr: CFString) -> Bool? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(element, attr, &value)
        guard result == .success else { return nil }
        if let num = value as? NSNumber { return num.boolValue }
        return nil
    }

    func getPointAttr(_ element: AXUIElement, _ attr: CFString) -> CGPoint? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(element, attr, &value)
        guard result == .success, let axValue = value, CFGetTypeID(axValue) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        AXValueGetValue(axValue as! AXValue, .cgPoint, &point)
        return point
    }

    func getSizeAttr(_ element: AXUIElement, _ attr: CFString) -> CGSize? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(element, attr, &value)
        guard result == .success, let axValue = value, CFGetTypeID(axValue) == AXValueGetTypeID() else { return nil }
        var size = CGSize.zero
        AXValueGetValue(axValue as! AXValue, .cgSize, &size)
        return size
    }

    private func getChildren(_ element: AXUIElement) -> [AXUIElement] {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
        guard result == .success, let children = value as? [AXUIElement] else { return [] }
        return children
    }

    private func getActions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        let result = AXUIElementCopyActionNames(element, &names)
        guard result == .success, let actionNames = names as? [String] else { return [] }
        return actionNames
    }

    // MARK: - Tmp File

    private func writeTmpFile() -> String? {
        let dir = "/tmp/vodou-ax"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let timestamp = Int(Date().timeIntervalSince1970)
        let path = "\(dir)/\(appName)-\(timestamp).json"
        if let data = try? jsonEncoder.encode(elements) {
            try? data.write(to: URL(fileURLWithPath: path))
            return path
        }
        return nil
    }
}
