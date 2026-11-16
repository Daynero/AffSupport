import Foundation

/// Which signed release manifest a stable host reads its native update from.
///
/// The channel is never baked into the build: promote ships the very bytes tested
/// on next to production. Every installed Soty therefore reads production by
/// default, and a single Mac opts into next at runtime through its own user
/// defaults (`SotyUpdateChannel` = `next`). Only the two manifest URLs baked into
/// Info.plist from the shared release constants are reachable; any other value,
/// an absent or damaged next entry, or a beta host keeps the production default.
enum NativeUpdateManifestChannel {
  static let preferenceKey = "SotyUpdateChannel"
  static let manifestPath = "/.well-known/wishly/stable.json"

  static func manifestURL(channel: String, fixtureOrigin: String?, info: [String: Any], preference: Any?) -> String {
    if channel == "beta", let origin = fixtureOrigin { return origin + "/stable.json" }
    let production = info["SotyUpdateManifestURL"] as? String ?? ""
    guard channel == "stable", preference as? String == "next",
      let next = info["SotyUpdateNextManifestURL"] as? String,
      next != production, isSiteManifest(next), isSiteManifest(production)
    else { return production }
    return next
  }

  /// An exact `https://<host>/.well-known/wishly/stable.json`, nothing more.
  static func isSiteManifest(_ value: String) -> Bool {
    guard let url = URLComponents(string: value), url.scheme == "https", let host = url.host, !host.isEmpty,
      url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
      url.path == manifestPath
    else { return false }
    return value == "https://\(host)\(manifestPath)"
  }
}
