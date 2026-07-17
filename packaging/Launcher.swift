import AppKit
import Foundation

let pairURL = URL(string: "http://127.0.0.1:43120/pair")!
if let response = try? Data(contentsOf: pairURL), !response.isEmpty {
  NSWorkspace.shared.open(pairURL)
  exit(0)
}
let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/runtime/node")
let entry = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/agent/dist/index.js")
let process = Process()
process.executableURL = executable
process.arguments = [entry.path]
process.environment = ProcessInfo.processInfo.environment.merging(["PACKAGED_APP":"1", "PUBLIC_SITE_ORIGIN":"__PUBLIC_SITE_ORIGIN__"]) { _, new in new }
do { try process.run(); process.waitUntilExit() }
catch { let alert=NSAlert(); alert.messageText="Local Video Compressor could not start"; alert.informativeText=error.localizedDescription; alert.runModal() }
