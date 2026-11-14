import Foundation
import Darwin

/// Qualification profiles are bundle-sealed, so Sparkle's new process opens the
/// same receipts and Node data without inheriting a temporary shell environment.
enum NativeUpdateFixtureProfile {
  static func prepareDirectory(root: URL, name: String) throws {
    let directory = root.appendingPathComponent(name, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    var info = stat()
    guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
      info.st_uid == getuid(), info.st_mode & 0o077 == 0
    else { throw NSError(domain: "SotyUpdateFixtureProfile", code: 2) }
  }
  static func supportDirectoryName(base: String, channel: String, info: [String: Any]) throws -> String {
    let raw = info["SotyUpdateFixtureProfile"]
    let fixture = info["SotyUpdateFixtureOrigin"]
    if raw == nil && fixture == nil { return base }
    guard channel == "beta", let bundleId = NativeUpdateBuildPolicy.fixtureBundleId,
      let support = NativeUpdateBuildPolicy.fixtureSupportDirectory, base == support,
      info["CFBundleIdentifier"] as? String == bundleId,
      info["SotyNativeUpdatesEnabled"] as? Bool == true,
      let profile = raw as? String,
      profile.range(of: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$", options: .regularExpression) != nil,
      let origin = fixture as? String, let url = URLComponents(string: origin),
      url.scheme == "http", url.host == "127.0.0.1", let port = url.port,
      port >= 1024, port <= 65535, url.user == nil, url.password == nil,
      url.path.isEmpty, url.query == nil, url.fragment == nil,
      origin == "http://127.0.0.1:\(port)"
    else { throw NSError(domain: "SotyUpdateFixtureProfile", code: 1) }
    return "\(support) Updates \(profile)"
  }
}
