import Foundation
import Darwin

final class NativeUpdateReceiptStore {
  let directory: URL
  private var lock: Int32 = -1
  private(set) var installationId = ""
  init(directory: URL) throws {
    self.directory = directory
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var info = stat()
    guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
      info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw NativeUpdateFailure.unsafe }
    lock = Darwin.open(directory.appendingPathComponent("native.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw NativeUpdateFailure.busy }
    let identity = directory.appendingPathComponent("installation-id")
    if FileManager.default.fileExists(atPath: identity.path) {
      let data = try readOwned(identity, maximum: 64)
      guard let value = String(data: data, encoding: .utf8), UUID(uuidString: value) != nil else { throw NativeUpdateFailure.unknown }
      installationId = value
    } else {
      installationId = UUID().uuidString.lowercased()
      try atomicWrite(Data(installationId.utf8), to: identity)
    }
  }
  deinit { if lock >= 0 { flock(lock, LOCK_UN); Darwin.close(lock) } }
  func load() throws -> NativeUpdateState {
    let url = directory.appendingPathComponent("native.json")
    if !FileManager.default.fileExists(atPath: url.path) { var fresh = NativeUpdateState(); fresh.installationId = installationId; return fresh }
    let data = try readOwned(url, maximum: NativeUpdateBuildPolicy.frameBytes)
    let value = try JSONDecoder().decode(NativeUpdateState.self, from: data)
    guard value.schemaVersion == 1, value.revision >= 0, value.installationId == installationId,
      value.acceptedKeys.count <= NativeUpdateBuildPolicy.historyEntries, value.candidateId == value.candidate?.id else { throw NativeUpdateFailure.unknown }
    return value
  }
  func preserveDamagedReceipt() throws {
    let source = directory.appendingPathComponent("native.json")
    let destination = directory.appendingPathComponent("native-corrupt-\(UUID().uuidString).json")
    guard rename(source.path, destination.path) == 0 else { throw NativeUpdateFailure.flush }
    let parent = Darwin.open(directory.path, O_RDONLY)
    guard parent >= 0 else { throw NativeUpdateFailure.flush }
    defer { Darwin.close(parent) }
    guard fsync(parent) == 0 else { throw NativeUpdateFailure.flush }
  }
  func save(_ state: NativeUpdateState) throws {
    let data = try JSONEncoder().encode(state)
    guard data.count <= NativeUpdateBuildPolicy.frameBytes else { throw NativeUpdateFailure.invalid }
    try atomicWrite(data, to: directory.appendingPathComponent("native.json"))
    // A bounded, separately durable trail survives the host/agent boundary.
    let history = directory.appendingPathComponent("history", isDirectory: true)
    try FileManager.default.createDirectory(at: history, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try atomicWrite(JSONEncoder().encode(state), to: history.appendingPathComponent(String(format: "%020d.json", state.receiptSequence)))
    let entries = try FileManager.default.contentsOfDirectory(at: history, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    for old in entries.dropLast(NativeUpdateBuildPolicy.historyEntries) { try FileManager.default.removeItem(at: old) }
  }
  func history() throws -> [[String: Any]] {
    let history = directory.appendingPathComponent("history", isDirectory: true)
    guard FileManager.default.fileExists(atPath: history.path) else { return [] }
    let entries = try FileManager.default.contentsOfDirectory(at: history, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }.suffix(NativeUpdateBuildPolicy.historyEntries)
    return try entries.map { url in
      let value = try JSONDecoder().decode(NativeUpdateState.self, from: readOwned(url, maximum: NativeUpdateBuildPolicy.frameBytes))
      guard value.installationId == installationId else { throw NativeUpdateFailure.identity }
      return ["state": try value.projection(), "sequence": value.receiptSequence, "recordedAtMs": value.recordedAtMs]
    }
  }
  func workload() throws -> [String: Any] {
    let data = try readOwned(directory.appendingPathComponent("workload.json"), maximum: 16384)
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeUpdateFailure.flush }
    return value
  }
  private func readOwned(_ url: URL, maximum: Int) throws -> Data {
    let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw NativeUpdateFailure.unknown }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_size <= maximum else { throw NativeUpdateFailure.unsafe }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    guard let data = try handle.readToEnd(), data.count <= maximum else { throw NativeUpdateFailure.invalid }
    return data
  }
  private func atomicWrite(_ data: Data, to url: URL) throws {
    let temporary = url.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).tmp")
    let fd = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw NativeUpdateFailure.flush }
    defer { Darwin.close(fd); unlink(temporary.path) }
    try data.withUnsafeBytes { bytes in
      var offset = 0
      while offset < bytes.count {
        let n = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
        guard n > 0 else { throw NativeUpdateFailure.flush }; offset += n
      }
    }
    guard fsync(fd) == 0, fcntl(fd, F_FULLFSYNC) == 0, rename(temporary.path, url.path) == 0 else { throw NativeUpdateFailure.flush }
    let parent = Darwin.open(url.deletingLastPathComponent().path, O_RDONLY)
    guard parent >= 0 else { throw NativeUpdateFailure.flush }
    defer { Darwin.close(parent) }
    guard fsync(parent) == 0 else { throw NativeUpdateFailure.flush }
  }
}
