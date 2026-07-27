import AppKit
import FinderSync
import Foundation
import UniformTypeIdentifiers

private let finderServiceName = "__FINDER_SERVICE_NAME__"
private let finderMenuSuffix = "__FINDER_MENU_SUFFIX__"
private let finderActionPasteboardType = NSPasteboard.PasteboardType(
  "com.wishly.finder-action"
)
private let maximumSelectionCount = 100

private enum TargetFormat: String, CaseIterable {
  case png
  case jpeg
  case webp

  var title: String {
    switch self {
    case .png: "PNG"
    case .jpeg: "JPEG"
    case .webp: "WebP"
    }
  }

  func matchesSource(_ url: URL) -> Bool {
    switch self {
    case .png:
      url.pathExtension.lowercased() == "png"
    case .jpeg:
      ["jpg", "jpeg"].contains(url.pathExtension.lowercased())
    case .webp:
      url.pathExtension.lowercased() == "webp"
    }
  }
}

private struct FinderActionPayload: Codable {
  let kind: String
  let format: String
  let paths: [String]
}

@objc(WishlyFinderSync)
final class WishlyFinderSync: FIFinderSync {
  override init() {
    super.init()
    FIFinderSyncController.default().directoryURLs = [
      URL(fileURLWithPath: "/", isDirectory: true)
    ]
  }

  override func menu(for menuKind: FIMenuKind) -> NSMenu? {
    guard
      menuKind == .contextualMenuForItems,
      let selected = selectedImageURLs(),
      !selected.isEmpty
    else { return nil }

    let menuTitle = localized("convert_to") + finderMenuSuffix
    let targetMenu = NSMenu(title: menuTitle)
    targetMenu.autoenablesItems = false
    for format in TargetFormat.allCases {
      let item = NSMenuItem(
        title: format.title,
        action: #selector(convertSelectedImages(_:)),
        keyEquivalent: ""
      )
      item.target = self
      item.representedObject = format.rawValue
      item.isEnabled = selected.contains { !format.matchesSource($0) }
      targetMenu.addItem(item)
    }

    let rootItem = NSMenuItem(title: menuTitle, action: nil, keyEquivalent: "")
    rootItem.submenu = targetMenu
    let menu = NSMenu()
    menu.addItem(rootItem)
    return menu
  }

  @objc private func convertSelectedImages(_ sender: NSMenuItem) {
    guard
      let rawFormat = sender.representedObject as? String,
      let format = TargetFormat(rawValue: rawFormat),
      let selected = selectedImageURLs()
    else {
      NSSound.beep()
      return
    }

    let paths = selected.filter { !format.matchesSource($0) }.map(\.path)
    guard
      !paths.isEmpty,
      let data = try? JSONEncoder().encode(
        FinderActionPayload(kind: "image-conversion", format: format.rawValue, paths: paths)
      ),
      let payload = String(data: data, encoding: .utf8)
    else {
      NSSound.beep()
      return
    }

    let pasteboard = NSPasteboard.withUniqueName()
    pasteboard.declareTypes([finderActionPasteboardType], owner: nil)
    guard
      pasteboard.setString(payload, forType: finderActionPasteboardType),
      NSPerformService(finderServiceName, pasteboard)
    else {
      NSSound.beep()
      return
    }
  }

  private func selectedImageURLs() -> [URL]? {
    guard
      let urls = FIFinderSyncController.default().selectedItemURLs(),
      !urls.isEmpty,
      urls.count <= maximumSelectionCount
    else { return nil }
    let selected = urls.map { $0.standardizedFileURL }
    return selected.allSatisfy(isConvertibleStaticImage) ? selected : nil
  }
}

private func isConvertibleStaticImage(_ url: URL) -> Bool {
  guard url.isFileURL else { return false }
  guard
    let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .contentTypeKey]),
    values.isRegularFile == true,
    let contentType = values.contentType,
    contentType.conforms(to: .image),
    !contentType.conforms(to: .gif)
  else { return false }
  return true
}

private func localized(_ key: String) -> String {
  NSLocalizedString(key, bundle: .main, comment: "")
}
