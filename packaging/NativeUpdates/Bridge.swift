import Foundation
import Darwin

final class NativeUpdateSocket {
  private let path: String
  private var fd: Int32 = -1
  private let token: [UInt8]
  private let handler: ([String: Any]) throws -> [String: Any]
  init(path: String, token: String, handler: @escaping ([String: Any]) throws -> [String: Any]) throws {
    self.path = path; self.token = Array(token.utf8); self.handler = handler
    guard path.utf8.count < 104 else { throw NativeUpdateFailure.unsafe }
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw NativeUpdateFailure.unsafe }
    var address = sockaddr_un(); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size); address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in
      let bytes = Array(path.utf8) + [0]; buffer.copyBytes(from: bytes)
    }
    var info = stat()
    if lstat(path, &info) == 0 {
      guard info.st_mode & S_IFMT == S_IFSOCK, info.st_uid == getuid() else { throw NativeUpdateFailure.unsafe }
      guard unlink(path) == 0 else { throw NativeUpdateFailure.unsafe }
    }
    let bound = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard bound == 0, chmod(path, 0o600) == 0, listen(fd, 8) == 0 else { throw NativeUpdateFailure.unsafe }
    DispatchQueue.global(qos: .utility).async { [weak self] in self?.serve() }
  }
  deinit { if fd >= 0 { Darwin.shutdown(fd, SHUT_RDWR); Darwin.close(fd); unlink(path) } }
  private func serve() {
    while fd >= 0 {
      let client = accept(fd, nil, nil)
      if client < 0 { return }
      handle(client)
      Darwin.close(client)
    }
  }
  private func handle(_ client: Int32) {
    var uid: uid_t = 0; var gid: gid_t = 0
    guard getpeereid(client, &uid, &gid) == 0, uid == getuid() else { return }
    var timeout = timeval(tv_sec: 3, tv_usec: 0)
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var noSigPipe: Int32 = 1
    setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
    while data.count <= NativeUpdateBuildPolicy.frameBytes {
      let count = recv(client, &buffer, buffer.count, 0)
      if count <= 0 { return }
      data.append(contentsOf: buffer.prefix(count))
      if data.contains(10) { break }
    }
    guard data.count <= NativeUpdateBuildPolicy.frameBytes, let end = data.firstIndex(of: 10),
      let request = try? JSONSerialization.jsonObject(with: data.prefix(upTo: end)) as? [String: Any],
      request["schemaVersion"] as? Int == 1, let nonce = request["nonce"] as? String, UUID(uuidString: nonce) != nil,
      let supplied = request["token"] as? String else { return }
    let bytes = Array(supplied.utf8)
    guard bytes.count == token.count, zip(bytes, token).reduce(UInt8(0), { $0 | ($1.0 ^ $1.1) }) == 0 else { return }
    var response: [String: Any] = ["schemaVersion": 1, "nonce": nonce]
    DispatchQueue.main.sync {
      do { response["value"] = try handler(request) }
      catch { response["error"] = (error as? NativeUpdateFailure)?.rawValue ?? NativeUpdateFailure.invalid.rawValue }
    }
    guard var output = try? JSONSerialization.data(withJSONObject: response), output.count < NativeUpdateBuildPolicy.frameBytes else { return }
    output.append(10)
    output.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        let sent = send(client, raw.baseAddress!.advanced(by: offset), raw.count - offset, 0)
        if sent <= 0 { return }; offset += sent
      }
    }
  }
}
