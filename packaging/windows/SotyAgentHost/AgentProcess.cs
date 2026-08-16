using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace Soty.AgentHost;

/// <summary>
/// Owns the bundled Node agent child process: spawn with the packaged environment,
/// capture the output tail for crash reports, and surface the exit code.
/// The host must stay the agent's direct parent — the agent watches its ppid and
/// exits when the host disappears, which is the crash-safety net on Windows where
/// children are not killed with their parent automatically.
/// </summary>
internal sealed class AgentProcess
{
  // Same tail budget as Launcher.swift's stderrText buffer.
  private const int OutputTailLimit = 12_000;

  private static readonly string[] RequiredRuntimeFiles =
  {
    Path.Combine("runtime", "node.exe"),
    Path.Combine("runtime", "bin", "ffmpeg.exe"),
    Path.Combine("runtime", "bin", "ffprobe.exe")
  };

  private readonly object gate = new();
  private readonly StringBuilder tail = new();
  private readonly string resourceRoot;
  private readonly string nativeToken;
  private Process? process;

  /// <summary>Raised on a thread-pool thread; the tray marshals to the UI thread.</summary>
  public event Action<int>? Exited;

  public AgentProcess(string resourceRoot, string nativeToken)
  {
    this.resourceRoot = resourceRoot;
    this.nativeToken = nativeToken;
  }

  public string OutputTail
  {
    get { lock (gate) return tail.ToString(); }
  }

  /// <summary>
  /// Returns the runtime binaries that are missing from the install, relative to the
  /// install root. Mirrors the isExecutableFile guard in Launcher.swift (Windows has no
  /// executable bit, so existence is the meaningful check).
  /// </summary>
  public static IReadOnlyList<string> MissingRuntimeFiles(string resourceRoot) =>
    RequiredRuntimeFiles
      .Where(relative => !File.Exists(Path.Combine(resourceRoot, relative)))
      .ToArray();

  public void Start()
  {
    var agentDirectory = Path.Combine(resourceRoot, "agent");
    var startInfo = new ProcessStartInfo(Path.Combine(resourceRoot, "runtime", "node.exe"))
    {
      WorkingDirectory = agentDirectory,
      UseShellExecute = false,
      CreateNoWindow = true,
      RedirectStandardOutput = true,
      RedirectStandardError = true
    };
    startInfo.ArgumentList.Add(Path.Combine(agentDirectory, "dist", "index.js"));

    // Same packaged environment Launcher.swift merges over the inherited one.
    startInfo.Environment["PACKAGED_APP"] = "1";
    startInfo.Environment["NO_OPEN"] = "1";
    startInfo.Environment["AGENT_PORT"] = HostConfig.AgentPort.ToString(CultureInfo.InvariantCulture);
    startInfo.Environment["AGENT_SUPPORT_DIRECTORY_NAME"] = HostConfig.SupportDirectoryName;
    startInfo.Environment["PUBLIC_SITE_ORIGIN"] = HostConfig.PublicSiteOrigin;
    startInfo.Environment["AGENT_VERSION"] = HostConfig.ExpectedVersion;
    startInfo.Environment["AGENT_BUILD_NUMBER"] = HostConfig.ExpectedBuildNumber;
    startInfo.Environment["AGENT_BUILD_ID"] = HostConfig.ExpectedBuildId;
    startInfo.Environment["AGENT_RELEASE_CHANNEL"] = HostConfig.ReleaseChannel;
    startInfo.Environment["AGENT_SOURCE_REVISION"] = HostConfig.SourceRevision;
    startInfo.Environment["AGENT_INSTALLED_RELEASE_PATH"] = Path.Combine(resourceRoot, "release.json");
    startInfo.Environment["AGENT_NATIVE_TOKEN"] = nativeToken;
    startInfo.Environment["AGENT_ENTITLEMENT_PUBLIC_KEY"] = HostConfig.EntitlementPublicKey;

    var child = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
    child.OutputDataReceived += (_, arguments) => AppendOutput(arguments.Data);
    child.ErrorDataReceived += (_, arguments) => AppendOutput(arguments.Data);
    child.Exited += (_, _) =>
    {
      int exitCode;
      try
      {
        exitCode = child.ExitCode;
      }
      catch
      {
        exitCode = -1;
      }
      Exited?.Invoke(exitCode);
    };
    child.Start();
    child.BeginOutputReadLine();
    child.BeginErrorReadLine();
    process = child;
  }

  /// <summary>
  /// Stops the agent tree. Windows has no SIGTERM for windowless processes, so this is
  /// a hard kill (macOS sends SIGTERM); an interrupted compression is marked interrupted
  /// by the agent on the next start and can be retried safely.
  /// </summary>
  public void Stop()
  {
    var child = process;
    process = null;
    if (child is null) return;
    try
    {
      if (!child.HasExited)
      {
        child.Kill(entireProcessTree: true);
        child.WaitForExit(5_000);
      }
    }
    catch
    {
      // Already exited or access lost; nothing more the host can do while quitting.
    }
    finally
    {
      child.Dispose();
    }
  }

  private void AppendOutput(string? line)
  {
    if (string.IsNullOrEmpty(line)) return;
    lock (gate)
    {
      tail.AppendLine(line);
      if (tail.Length > OutputTailLimit) tail.Remove(0, tail.Length - OutputTailLimit);
    }
  }
}
