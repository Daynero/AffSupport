import AppKit

let output = CommandLine.arguments[1]
let size = NSSize(width: 660, height: 400)
let image = NSImage(size: size)
image.lockFocus()
NSColor(calibratedRed: 0.95, green: 0.97, blue: 0.95, alpha: 1).setFill()
NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()
let title = "Install Local Video Compressor Agent" as NSString
title.draw(at: NSPoint(x: 135, y: 338), withAttributes: [.font: NSFont.systemFont(ofSize: 22, weight: .semibold), .foregroundColor: NSColor(calibratedRed: 0.10, green: 0.18, blue: 0.14, alpha: 1)])
let note = "Drag the app to Applications" as NSString
note.draw(at: NSPoint(x: 220, y: 307), withAttributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.secondaryLabelColor])
let arrow = NSBezierPath()
arrow.lineWidth = 8; arrow.lineCapStyle = .round; arrow.lineJoinStyle = .round
arrow.move(to: NSPoint(x: 275, y: 182)); arrow.line(to: NSPoint(x: 385, y: 182)); arrow.move(to: NSPoint(x: 360, y: 207)); arrow.line(to: NSPoint(x: 385, y: 182)); arrow.line(to: NSPoint(x: 360, y: 157))
NSColor(calibratedRed: 0.16, green: 0.42, blue: 0.30, alpha: 1).setStroke(); arrow.stroke()
image.unlockFocus()
guard let tiff=image.tiffRepresentation, let bitmap=NSBitmapImageRep(data:tiff), let png=bitmap.representation(using:.png,properties:[:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: output))
