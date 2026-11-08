// Renders an SVG into a macOS .iconset (with the standard icon margin).
// usage: swift make-icon.swift <input.svg> <output.iconset>
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let img = NSImage(contentsOf: URL(fileURLWithPath: args[1])) else {
    FileHandle.standardError.write("usage: make-icon <svg> <iconset>\n".data(using: .utf8)!); exit(1)
}
let out = URL(fileURLWithPath: args[2])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

for base in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let px = base * scale
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSGraphicsContext.current?.imageInterpolation = .high
        let inset = CGFloat(px) * 0.1  // Apple's icon grid: ~824/1024 content
        img.draw(in: NSRect(x: inset, y: inset, width: CGFloat(px) - 2 * inset, height: CGFloat(px) - 2 * inset))
        NSGraphicsContext.restoreGraphicsState()
        let name = scale == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
        try! rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent(name))
    }
}
