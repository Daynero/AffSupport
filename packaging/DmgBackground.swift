import AppKit

// Renders the Wishly Agent DMG background at 2x for Retina Finder windows.
// The Wishly W mark geometry mirrors apps/web/public/favicon.svg.
let output = CommandLine.arguments[1]
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

// Wishly mark, centered above the title.
func markPath(originX: CGFloat, originY: CGFloat, unit: CGFloat) -> NSBezierPath {
  // favicon.svg W path in a 64-unit box; SVG y-axis points down, AppKit up.
  func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
    NSPoint(x: originX + x * unit, y: originY + (64 - y) * unit)
  }
  let w = NSBezierPath()
  w.move(to: p(13, 22))
  w.curve(to: p(21, 43), controlPoint1: p(14, 31), controlPoint2: p(16.5, 43))
  w.curve(to: p(29.2, 30.8), controlPoint1: p(24.4, 43), controlPoint2: p(26.8, 36.8))
  w.curve(to: p(32, 25.2), controlPoint1: p(30.6, 27.3), controlPoint2: p(31.2, 25.2))
  w.curve(to: p(34.8, 30.8), controlPoint1: p(32.8, 25.2), controlPoint2: p(33.4, 27.3))
  w.curve(to: p(43, 43), controlPoint1: p(37.2, 36.8), controlPoint2: p(39.6, 43))
  w.curve(to: p(51, 22), controlPoint1: p(47.5, 43), controlPoint2: p(50, 31))
  w.lineWidth = 6 * unit
  w.lineCapStyle = .round
  w.lineJoinStyle = .round
  return w
}

func sparkPath(originX: CGFloat, originY: CGFloat, unit: CGFloat) -> NSBezierPath {
  func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
    NSPoint(x: originX + x * unit, y: originY + (64 - y) * unit)
  }
  let s = NSBezierPath()
  s.move(to: p(49.5, 10))
  s.curve(to: p(53.8, 14.3), controlPoint1: p(50.1, 12.6), controlPoint2: p(51.2, 13.7))
  s.curve(to: p(49.5, 18.6), controlPoint1: p(51.2, 14.9), controlPoint2: p(50.1, 16))
  s.curve(to: p(45.2, 14.3), controlPoint1: p(48.9, 16), controlPoint2: p(47.8, 14.9))
  s.curve(to: p(49.5, 10), controlPoint1: p(47.8, 13.7), controlPoint2: p(48.9, 12.6))
  s.close()
  return s
}

let unit: CGFloat = 0.9
let markX = points.width / 2 - 32 * unit
let markY: CGFloat = 322
primary.setStroke()
markPath(originX: markX, originY: markY, unit: unit).stroke()
NSColor(calibratedRed: 0.545, green: 0.427, blue: 0.965, alpha: 1).setFill() // #8B6DF6
sparkPath(originX: markX, originY: markY, unit: unit).fill()

func drawCentered(_ text: NSString, y: CGFloat, attributes: [NSAttributedString.Key: Any]) {
  let size = text.size(withAttributes: attributes)
  text.draw(at: NSPoint(x: (points.width - size.width) / 2, y: y), withAttributes: attributes)
}

drawCentered(
  "Install Wishly Agent", y: 300,
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
