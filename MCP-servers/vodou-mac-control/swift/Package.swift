// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "vodou-ax",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "vodou-ax",
            path: "Sources/vodou-ax",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ScreenCaptureKit"),
            ]
        )
    ]
)
