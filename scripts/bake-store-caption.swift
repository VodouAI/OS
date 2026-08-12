#!/usr/bin/env swift
//
// Bake a Chrome Web Store screenshot: crop → fit above a caption band → exactly 1280x800.
//
// Usage:
//   swift scripts/bake-store-caption.swift <src.png> <out-name> "<caption>" [--crop x,y,w,h]
//
// Why this exists: the captions on the shipped 0.5.97.52 assets were added by hand in an
// image editor, so re-shooting meant re-doing them by eye and hoping the band matched. There
// is no ImageMagick or PIL on this machine; AppKit is always here. Same band, same type, same
// 1280x800, every time.
//
// The geometry: CWS accepts ONLY 1280x800 (or 640x400). The band takes the bottom 100px, so
// the screenshot has to fill 1280x700 — an aspect of 1.829, which is WIDER than the 16:10 a
// raw window capture gives you. Fitting a 1.6 source into that letterboxes ~13% of the width
// as dead bars. So pass --crop to choose what to trim (usually dead space below the
// conversation) rather than letting it center-crop and eat the panel's header or footer.

import AppKit
import Foundation

let W = 1280, H = 800, BAND = 100
let BAND_COLOR = NSColor(srgbRed: 0.145, green: 0.388, blue: 0.921, alpha: 1)   // #2563EB
let PAD_COLOR  = NSColor(srgbRed: 0.078, green: 0.078, blue: 0.078, alpha: 1)   // #141414

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: bake-store-caption.swift <src.png> <out-name> \"<caption>\" [--crop x,y,w,h]\n".data(using: .utf8)!)
    exit(2)
}
let srcPath = args[0], outName = args[1], caption = args[2]

var crop: NSRect? = nil
if let i = args.firstIndex(of: "--crop"), i + 1 < args.count {
    let p = args[i + 1].split(separator: ",").compactMap { Double($0) }
    guard p.count == 4 else { FileHandle.standardError.write("--crop needs x,y,w,h\n".data(using: .utf8)!); exit(2) }
    crop = NSRect(x: p[0], y: p[1], width: p[2], height: p[3])
}

guard let src = NSImage(contentsOfFile: srcPath),
      let srcRef = src.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot read \(srcPath)\n".data(using: .utf8)!); exit(1)
}

// Crop in SOURCE pixels with y measured from the TOP. No flip: `CGImage.cropping(to:)` already
// works in the image's own top-left space, unlike almost everything else in AppKit. Flipping
// "to be safe" silently trimmed the wrong end — the first bake lost the panel header and the
// user's message, and looked plausible enough to nearly ship.
var work = srcRef
if let c = crop {
    guard let cut = srcRef.cropping(to: c) else {
        FileHandle.standardError.write("crop rect is outside the image (\(srcRef.width)x\(srcRef.height))\n".data(using: .utf8)!); exit(1)
    }
    work = cut
}

// Draw into an explicit 1280x800 PIXEL buffer. `NSImage.lockFocus()` honours the display's
// backing scale, so on a Retina Mac it silently hands you a 2560x1600 bitmap that reports a
// 1280x800 size — and CWS rejects the upload on pixel dimensions, not on what the file claims.
guard let bmp = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H,
                                 bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                 isPlanar: false, colorSpaceName: .deviceRGB,
                                 bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
bmp.size = NSSize(width: W, height: H)
guard let gctx = NSGraphicsContext(bitmapImageRep: bmp) else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = gctx
let ctx = gctx.cgContext
ctx.interpolationQuality = .high

PAD_COLOR.setFill()
ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

// Aspect-FIT the screenshot into the 1280x700 area above the band. Fit, never fill: a fill
// would silently crop the panel, and the panel is the product.
let area = CGSize(width: CGFloat(W), height: CGFloat(H - BAND))
let scale = min(area.width / CGFloat(work.width), area.height / CGFloat(work.height))
let dw = CGFloat(work.width) * scale, dh = CGFloat(work.height) * scale
ctx.draw(work, in: CGRect(x: (area.width - dw) / 2, y: CGFloat(BAND) + (area.height - dh) / 2, width: dw, height: dh))

BAND_COLOR.setFill()
ctx.fill(CGRect(x: 0, y: 0, width: W, height: BAND))

let para = NSMutableParagraphStyle()
para.alignment = .center
// 30pt fits the longest caption in one line at 1280 wide; step down rather than wrap, because
// a two-line caption in a 100px band reads as a paragraph and stops being a caption.
var size: CGFloat = 30
var attrs: [NSAttributedString.Key: Any] = [:]
var text = NSAttributedString()
while size >= 22 {
    attrs = [
        .font: NSFont.systemFont(ofSize: size, weight: .semibold),
        .foregroundColor: NSColor.white,
        .paragraphStyle: para,
    ]
    text = NSAttributedString(string: caption, attributes: attrs)
    if text.size().width <= CGFloat(W) - 80 { break }
    size -= 1
}
let th = text.size().height
text.draw(in: CGRect(x: 40, y: (CGFloat(BAND) - th) / 2, width: CGFloat(W) - 80, height: th))

NSGraphicsContext.restoreGraphicsState()

guard let png = bmp.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("encode failed\n".data(using: .utf8)!); exit(1)
}

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let dest = root.appendingPathComponent("extension/Store-vodou-bridge/store-assets/\(outName).png")
try png.write(to: dest)

let check = NSImage(contentsOf: dest)!.cgImage(forProposedRect: nil, context: nil, hints: nil)!
guard check.width == W && check.height == H else {
    FileHandle.standardError.write("ERROR: wrote \(check.width)x\(check.height), not \(W)x\(H)\n".data(using: .utf8)!); exit(1)
}
print("wrote \(dest.path) — \(check.width)x\(check.height), caption at \(Int(size))pt")
