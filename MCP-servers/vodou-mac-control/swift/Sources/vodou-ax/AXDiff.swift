import Foundation

struct AXDiff {
    /// Compute diff between before and after traversals.
    /// Match elements by role + coordinate proximity (±5 points).
    static func computeDiff(before: [AXElementData], after: [AXElementData]) -> DiffResult {
        let tolerance = 5.0

        // Filter noise elements
        let beforeFiltered = before.filter { !isNoise($0) }
        let afterFiltered = after.filter { !isNoise($0) }

        // Build matches: for each before element, find best match in after
        var matchedAfterIds: Set<Int> = []
        var modified: [DiffResult.ModifiedElement] = []

        for bEl in beforeFiltered {
            guard let bPos = bEl.position else { continue }

            // Find matching element in after: same role + close position
            let match = afterFiltered.first { aEl in
                guard !matchedAfterIds.contains(aEl.id) else { return false }
                guard aEl.role == bEl.role else { return false }
                guard let aPos = aEl.position else { return false }
                return abs(aPos.x - bPos.x) <= tolerance && abs(aPos.y - bPos.y) <= tolerance
            }

            if let match = match {
                matchedAfterIds.insert(match.id)

                // Check for modifications
                if bEl.title != match.title {
                    modified.append(DiffResult.ModifiedElement(
                        id: match.id, role: match.role, field: "title",
                        old: bEl.title, new: match.title
                    ))
                }
                if bEl.value != match.value {
                    modified.append(DiffResult.ModifiedElement(
                        id: match.id, role: match.role, field: "value",
                        old: bEl.value, new: match.value
                    ))
                }
                if bEl.enabled != match.enabled {
                    modified.append(DiffResult.ModifiedElement(
                        id: match.id, role: match.role, field: "enabled",
                        old: String(bEl.enabled), new: String(match.enabled)
                    ))
                }
                if bEl.focused != match.focused {
                    modified.append(DiffResult.ModifiedElement(
                        id: match.id, role: match.role, field: "focused",
                        old: String(bEl.focused), new: String(match.focused)
                    ))
                }
            }
        }

        // Added: elements in after that weren't matched
        let added = afterFiltered
            .filter { !matchedAfterIds.contains($0.id) && !isNoise($0) }
            .prefix(50) // Cap to avoid huge diffs
            .map { DiffResult.DiffElement(id: $0.id, role: $0.role, title: $0.title) }

        // Removed: elements in before that had no match in after
        let removed = beforeFiltered
            .filter { bEl in
                guard let bPos = bEl.position else { return false }
                return !afterFiltered.contains { aEl in
                    aEl.role == bEl.role &&
                    (aEl.position.map { abs($0.x - bPos.x) <= tolerance && abs($0.y - bPos.y) <= tolerance } ?? false)
                }
            }
            .filter { !isNoise($0) }
            .prefix(50)
            .map { DiffResult.DiffElement(id: $0.id, role: $0.role, title: $0.title) }

        return DiffResult(added: Array(added), removed: Array(removed), modified: modified)
    }

    /// Filter out noisy elements that create false diffs
    private static func isNoise(_ el: AXElementData) -> Bool {
        let role = el.role.lowercased()
        if role.contains("scrollbar") || role.contains("valueindicator") { return true }
        // Empty structural containers
        if ["AXRow", "AXCell", "AXColumn", "AXGroup", "AXLayoutArea"].contains(el.role) &&
           el.title == nil && el.value == nil { return true }
        return false
    }
}
