import Darwin
import Foundation

// Built once by the runner installer, never by a release. The probe reports raw
// readings only: cumulative CPU ticks, a sleep-excluding uptime clock and the
// native memory/swap/thermal counters. Every rate — CPU percent, swap growth —
// is a difference between two readings and belongs to the JS scheduler, which
// owns policy. A signal that cannot be read is omitted, never defaulted, so a
// machine that will not answer is treated as unknown and waited on rather than
// as a healthy one.

func sysctlUInt64(_ name: String) -> UInt64? {
  var value: UInt64 = 0
  var size = MemoryLayout<UInt64>.size
  return name.withCString { sysctlbyname($0, &value, &size, nil, 0) == 0 ? value : nil }
}

/// Cumulative host ticks since boot: user, system, idle, nice.
func cpuTicks() -> [String: UInt64]? {
  var info = host_cpu_load_info_data_t()
  var count = mach_msg_type_number_t(
    MemoryLayout<host_cpu_load_info_data_t>.size / MemoryLayout<integer_t>.size)
  let status = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count)
    }
  }
  guard status == KERN_SUCCESS else { return nil }
  return [
    "user": UInt64(info.cpu_ticks.0),
    "system": UInt64(info.cpu_ticks.1),
    "idle": UInt64(info.cpu_ticks.2),
    "nice": UInt64(info.cpu_ticks.3)
  ]
}

/// Memory a new process can actually get.
///
/// The first version of this read `free - speculative + purgeable + external`
/// and was wrong twice over. `external_page_count` counts file-backed pages
/// wherever they are, including the *active* ones a running program is using,
/// so adding it to free counted memory that was not going spare. And it left
/// out `inactive` — the largest reclaimable pool there is, and the reason macOS
/// itself was reporting half the machine free while this said a tenth of it.
/// The two mistakes partly cancelled, which is exactly why the number looked
/// reasonable and the release runner still waited for memory it already had.
///
/// What is counted now is what the kernel will hand over without swapping
/// anything out: genuinely free pages (`free_count` includes the speculative
/// read-ahead it drops on demand, so that is removed and added back as part of
/// nothing), plus inactive and purgeable. Compressed and wired are not
/// available by definition and are reported separately for diagnosis.
func memoryStatistics() -> vm_statistics64_data_t? {
  var info = vm_statistics64_data_t()
  var count = mach_msg_type_number_t(
    MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
  let status = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
    }
  }
  return status == KERN_SUCCESS ? info : nil
}

func availableBytes(_ info: vm_statistics64_data_t, pageSize: UInt64) -> UInt64 {
  let free = UInt64(info.free_count) >= UInt64(info.speculative_count)
    ? UInt64(info.free_count) - UInt64(info.speculative_count)
    : 0
  return (free + UInt64(info.inactive_count) + UInt64(info.purgeable_count)) * pageSize
}

/// The kernel's own pressure level, not a threshold this probe invents.
func memoryPressure() -> String {
  var value: Int32 = 0
  var size = MemoryLayout<Int32>.size
  guard sysctlbyname("kern.memorystatus_vm_pressure_level", &value, &size, nil, 0) == 0 else {
    return "unknown"
  }
  switch value {
  case 1: return "normal"
  case 2: return "warn"
  case 4: return "critical"
  default: return "unknown"
  }
}

func swapUsed() -> UInt64? {
  var usage = xsw_usage()
  var size = MemoryLayout<xsw_usage>.size
  guard sysctlbyname("vm.swapusage", &usage, &size, nil, 0) == 0 else { return nil }
  return usage.xsu_used
}

/// Space a build may actually consume on the destination volume.
func diskFreeBytes(_ path: String) -> UInt64? {
  let url = URL(fileURLWithPath: path)
  if let capacity = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    .volumeAvailableCapacityForImportantUsage
  {
    return UInt64(max(0, capacity))
  }
  let attributes = try? FileManager.default.attributesOfFileSystem(forPath: path)
  return (attributes?[.systemFreeSize] as? NSNumber)?.uint64Value
}

/// Seconds of boot time, stable for the life of a boot: a changed value
/// invalidates every sampled window that preceded it.
func bootIdentity() -> String? {
  var value = timeval()
  var size = MemoryLayout<timeval>.size
  guard sysctlbyname("kern.boottime", &value, &size, nil, 0) == 0 else { return nil }
  return "\(value.tv_sec).\(value.tv_usec)"
}

let info = ProcessInfo.processInfo
let thermal: String
switch info.thermalState {
case .nominal: thermal = "nominal"
case .fair: thermal = "fair"
case .serious: thermal = "serious"
case .critical: thermal = "critical"
@unknown default: thermal = "unknown"
}

let volumePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/"
let pageSize = sysctlUInt64("hw.pagesize") ?? UInt64(vm_page_size)
let memory = memoryStatistics()

// Whole seconds would make two samples inside one second indistinguishable and
// silently shorten the stability window the scheduler thinks it measured.
let timestamps = ISO8601DateFormatter()
timestamps.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

let payload: [String: Any?] = [
  "version": 1,
  "observedAt": timestamps.string(from: Date()),
  // CLOCK_UPTIME_RAW stops during sleep; comparing its delta with the wall
  // clock is how the reader notices the machine was suspended mid-window.
  "uptimeNs": clock_gettime_nsec_np(CLOCK_UPTIME_RAW),
  "bootId": bootIdentity(),
  "physicalBytes": info.physicalMemory,
  "cpuCount": info.activeProcessorCount,
  "cpuTicks": cpuTicks(),
  "availableBytes": memory.map { availableBytes($0, pageSize: pageSize) },
  // Reported so a wait can be explained rather than guessed at.
  "inactiveBytes": memory.map { UInt64($0.inactive_count) * pageSize },
  "wiredBytes": memory.map { UInt64($0.wire_count) * pageSize },
  "compressedBytes": memory.map { UInt64($0.compressor_page_count) * pageSize },
  "pressure": memoryPressure(),
  "swapUsedBytes": swapUsed(),
  "diskFreeBytes": diskFreeBytes(volumePath),
  "volumePath": volumePath,
  "thermal": thermal,
  "kernelPageSize": pageSize
]

let data = try JSONSerialization.data(
  withJSONObject: payload.compactMapValues { $0 }, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
