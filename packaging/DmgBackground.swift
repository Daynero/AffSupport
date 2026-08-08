import AppKit

// Renders the Soty DMG background at 2x for Retina Finder windows.
// The brand mark is supplied from the same Soty logo used by the web app.
guard CommandLine.arguments.count >= 3 else { exit(1) }
let output = CommandLine.arguments[1]
let logoPath = CommandLine.arguments[2]
let points = NSSize(width: 660, height: 400)
let scale: CGFloat = 2
let pixels = NSSize(width: points.width * scale, height: points.height * scale)

guard
  let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(pixels.width), pixelsHigh: Int(pixels.height),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0)
else { exit(1) }
bitmap.size = points

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

let lavender = NSColor(calibratedRed: 0.969, green: 0.961, blue: 1.0, alpha: 1) // #F7F5FF
let surface = NSColor.white
let ink = NSColor(calibratedRed: 0.141, green: 0.106, blue: 0.227, alpha: 1) // #241B3A
let inkMuted = NSColor(calibratedRed: 0.435, green: 0.408, blue: 0.490, alpha: 1) // #6F687D
let primary = NSColor(calibratedRed: 0.459, green: 0.341, blue: 0.910, alpha: 1) // #7557E8
let primarySoft = NSColor(calibratedRed: 0.867, green: 0.835, blue: 0.988, alpha: 1) // #DDD5FC

// Soft vertical wash from lavender to white keeps the window calm.
NSGradient(starting: lavender, ending: surface)?
  .draw(in: NSRect(origin: .zero, size: points), angle: -90)

// Soty logo, centered above the title.
if let logo = NSImage(contentsOfFile: logoPath) {
  let logoSize = NSSize(width: 178, height: 52)
  logo.draw(
    in: NSRect(
      x: (points.width - logoSize.width) / 2,
      y: 318,
      width: logoSize.width,
      height: logoSize.height
    ),
    from: .zero,
    operation: .sourceOver,
    fraction: 1
  )
}

func drawCentered(_ text: NSString, y: CGFloat, attributes: [NSAttributedString.Key: Any]) {
  let size = text.size(withAttributes: attributes)
  text.draw(at: NSPoint(x: (points.width - size.width) / 2, y: y), withAttributes: attributes)
}

drawCentered(
  "Install Soty", y: 300,
  attributes: [.font: NSFont.systemFont(ofSize: 22, weight: .semibold), .foregroundColor: ink])
drawCentered(
  "Drag the app to Applications", y: 274,
  attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: inkMuted])

// Arrow between the app icon (175, 205) and Applications (485, 205) slots.
let arrow = NSBezierPath()
arrow.lineWidth = 7
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
arrow.move(to: NSPoint(x: 278, y: 195))
arrow.line(to: NSPoint(x: 382, y: 195))
arrow.move(to: NSPoint(x: 358, y: 219))
arrow.line(to: NSPoint(x: 382, y: 195))
arrow.line(to: NSPoint(x: 358, y: 171))
primarySoft.blended(withFraction: 0.35, of: primary)?.setStroke()
arrow.stroke()

NSGraphicsContext.current?.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: output))
