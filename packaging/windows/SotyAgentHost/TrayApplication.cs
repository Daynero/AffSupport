using System.Diagnostics;

namespace Soty.AgentHost;

/// <summary>
/// Windows port of packaging/Launcher.swift: tray icon, single-instance lock, agent
/// lifecycle (spawn / readiness / crash restart), update handoff, and installed-build
/// monitoring. Finder-integration features have no Windows counterpart here and live
/// in a future Explorer shell extension.
/// </summary>
internal sealed class TrayApplication : ApplicationContext
{
  // Retry budgets copied from Launcher.swift (attempts x 250 ms unless noted).
  private const int MaxExistingInstanceAttempts = 20;
  private const int MaxHandoffAttempts = 48;
  private const int MaxPortWaitAttempts = 24;
  private const int MaxReadinessAttempts = 60;
  private const int MaxRuntimeRestarts = 2;
  // The agent exits with 75 (EX_TEMPFAIL) when a transient runtime fault warrants a restart.
  private const int RestartableExitCode = 75;

  private readonly NotifyIcon notifyIcon;
  private readonly AgentHealthClient healthClient = new();
  private readonly string nativeToken = NativeToken.Generate();
  private readonly string resourceRoot = AppContext.BaseDirectory;

  private readonly System.Windows.Forms.Timer startupTimer;
  private readonly System.Windows.Forms.Timer handoffTimer;
  private readonly System.Windows.Forms.Timer readinessTimer;
  private readonly System.Windows.Forms.Timer updateMonitorTimer;

  private SynchronizationContext? uiContext;
  private Mutex? instanceLock;
  private bool ownsInstanceLock;
  private AgentProcess? agent;
  private bool agentReady;
  private bool isTerminating;
  private bool restartingIntoInstalledBuild;
  private string? warnedInstalledBuildId;
  private int handoffAttempts;
  private int portWaitAttempts;
  private int readinessAttempts;
  private int runtimeRestartAttempts;

  public TrayApplication()
  {
    notifyIcon = BuildTrayIcon();

    handoffTimer = new System.Windows.Forms.Timer { Interval = 250 };
    handoffTimer.Tick += (_, _) => ContinueHandoff();
    readinessTimer = new System.Windows.Forms.Timer { Interval = 250 };
    readinessTimer.Tick += async (_, _) => await CheckReadinessAsync();
    updateMonitorTimer = new System.Windows.Forms.Timer { Interval = 3_000 };
    updateMonitorTimer.Tick += async (_, _) => await CheckInstalledBuildAsync();

    // Defer startup into the message loop so async continuations land on the
    // WinForms synchronization context (the applicationDidFinishLaunching analogue).
    startupTimer = new System.Windows.Forms.Timer { Interval = 1 };
    startupTimer.Tick += async (_, _) =>
    {
      startupTimer.Stop();
      await StartupAsync();
    };
    startupTimer.Start();
  }

  private NotifyIcon BuildTrayIcon()
  {
    var menu = new ContextMenuStrip();
    menu.Items.Add("Open Soty", null, (_, _) => OpenInterface());
    var versionItem = new ToolStripMenuItem(
      $"Version {HostConfig.ExpectedVersion} · build {HostConfig.ExpectedBuildNumber}"
    )
    {
      Enabled = false
    };
    menu.Items.Add(versionItem);
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add($"Quit {HostConfig.ApplicationName}", null, async (_, _) => await QuitRequestedAsync());

    return new NotifyIcon
    {
      Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application,
      Text = HostConfig.ApplicationName,
      ContextMenuStrip = menu,
      Visible = true
    };
  }

  private async Task StartupAsync()
  {
    uiContext = SynchronizationContext.Current;
    updateMonitorTimer.Start();
    if (AcquireInstanceLock())
    {
      portWaitAttempts = 0;
      await StartAgentWhenPortIsFreeAsync();
    }
    else if (Environment.GetEnvironmentVariable("AGENT_UPDATE_HANDOFF") == "1")
    {
      BeginHandoff();
    }
    else
    {
      await HandleExistingInstanceAsync(attempt: 0);
    }
  }

  // MARK: Single-instance lock (flock on macOS, named mutex on Windows)

  private bool AcquireInstanceLock()
  {
    if (ownsInstanceLock) return true;
    instanceLock ??= new Mutex(initiallyOwned: false, @"Local\" + HostConfig.InstanceLockName);
    try
    {
      ownsInstanceLock = instanceLock.WaitOne(TimeSpan.Zero);
    }
    catch (AbandonedMutexException)
    {
      // The previous owner died without releasing; ownership transferred to us.
      ownsInstanceLock = true;
    }
    return ownsInstanceLock;
  }

  private void ReleaseInstanceLock()
  {
    if (!ownsInstanceLock) return;
    ownsInstanceLock = false;
    try
    {
      instanceLock?.ReleaseMutex();
    }
    catch
    {
      // Wrong thread or already released; process exit frees the mutex regardless.
    }
  }

  // MARK: Existing-instance negotiation

  private async Task HandleExistingInstanceAsync(int attempt)
  {
    var health = await healthClient.ProbeAsync(TimeSpan.FromMilliseconds(500));
    if (isTerminating) return;
    if (health is null)
    {
      if (attempt < MaxExistingInstanceAttempts)
      {
        await Task.Delay(250);
        if (!isTerminating) await HandleExistingInstanceAsync(attempt + 1);
        return;
      }
      ShowFailure(
        "Another copy owns the Agent lock but is not responding.",
        $"Quit the existing tray Agent and open version {HostConfig.ExpectedVersion} again."
      );
      return;
    }
    if (AgentHealthClient.MatchesExpectedBuild(health))
    {
      if (health.Ready)
      {
        ExitHost();
      }
      else if (attempt < MaxExistingInstanceAttempts)
      {
        await Task.Delay(250);
        if (!isTerminating) await HandleExistingInstanceAsync(attempt + 1);
      }
      else
      {
        ShowFailure(
          "The existing Agent did not become ready.",
          $"Running: {AgentHealthClient.Describe(health)}."
        );
      }
      return;
    }
    OfferRunningVersionRestart(health);
  }

  private void OfferRunningVersionRestart(AgentHealth health)
  {
    var choice = MessageBox.Show(
      $"""
      A different Agent build is still running ({AgentHealthClient.Describe(health)}).
      Installed: {HostConfig.ExpectedVersion}, build {HostConfig.ExpectedBuildNumber}, API {HostConfig.ExpectedApiVersion}.

      Restarting activates the installed update. An active compression would be marked interrupted and can be retried safely.
      """,
      "Restart the updated Agent?",
      MessageBoxButtons.YesNo,
      MessageBoxIcon.Warning
    );
    if (choice != DialogResult.Yes)
    {
      ExitHost();
      return;
    }
    TerminateOtherHostInstances();
    BeginHandoff();
  }

  /// <summary>
  /// macOS asks other bundle instances to terminate gracefully; Windows has no such
  /// channel for a windowless tray process, so this kills sibling hosts started from
  /// the same executable path. Their agent children exit via the ppid watchdog.
  /// </summary>
  private static void TerminateOtherHostInstances()
  {
    var executablePath = Environment.ProcessPath;
    if (executablePath is null) return;
    var processName = Path.GetFileNameWithoutExtension(executablePath);
    foreach (var candidate in Process.GetProcessesByName(processName))
    {
      using (candidate)
      {
        if (candidate.Id == Environment.ProcessId) continue;
        try
        {
          if (string.Equals(
                candidate.MainModule?.FileName,
                executablePath,
                StringComparison.OrdinalIgnoreCase
              ))
          {
            candidate.Kill();
          }
        }
        catch
        {
          // Access denied or the process already exited; the handoff loop below
          // still waits for the lock with the same overall timeout budget.
        }
      }
    }
  }

  // MARK: Update handoff (new instance waits for the old one to release the lock)

  private void BeginHandoff()
  {
    handoffAttempts = 0;
    handoffTimer.Stop();
    handoffTimer.Start();
    ContinueHandoff();
  }

  private async void ContinueHandoff()
  {
    if (isTerminating) return;
    handoffAttempts += 1;
    if (AcquireInstanceLock())
    {
      handoffTimer.Stop();
      portWaitAttempts = 0;
      await StartAgentWhenPortIsFreeAsync();
    }
    else if (handoffAttempts >= MaxHandoffAttempts)
    {
      handoffTimer.Stop();
      ShowFailure(
        "The previous Agent did not stop.",
        $"Quit it from the tray (or end it in Task Manager), then open version {HostConfig.ExpectedVersion} again."
      );
    }
  }

  // MARK: Agent lifecycle

  private async Task StartAgentWhenPortIsFreeAsync()
  {
    var health = await healthClient.ProbeAsync(TimeSpan.FromMilliseconds(350));
    if (isTerminating) return;
    if (health is not null)
    {
      portWaitAttempts += 1;
      if (portWaitAttempts < MaxPortWaitAttempts)
      {
        await Task.Delay(250);
        if (!isTerminating) await StartAgentWhenPortIsFreeAsync();
      }
      else
      {
        ShowFailure(
          $"An old Agent process is still using port {HostConfig.AgentPort}.",
          $"Running: {AgentHealthClient.Describe(health)}. Quit the old Agent and try again."
        );
      }
      return;
    }
    SpawnAgent();
  }

  private void SpawnAgent()
  {
    agentReady = false;
    var missing = AgentProcess.MissingRuntimeFiles(resourceRoot);
    if (missing.Count > 0)
    {
      ShowFailure(
        "The bundled media runtime is unavailable.",
        "Reinstall Soty. Your local queue and original files are safe.\n\n"
          + $"Missing: {string.Join(", ", missing)}"
      );
      return;
    }
    var child = new AgentProcess(resourceRoot, nativeToken);
    child.Exited += exitCode => uiContext?.Post(_ => OnAgentExited(exitCode), null);
    try
    {
      child.Start();
    }
    catch (Exception error)
    {
      ShowFailure("The bundled agent runtime could not be started.", error.Message);
      return;
    }
    agent = child;
    BeginReadinessChecks();
  }

  private async void OnAgentExited(int exitCode)
  {
    if (isTerminating) return;
    agentReady = false;
    readinessTimer.Stop();
    if (exitCode == RestartableExitCode && runtimeRestartAttempts < MaxRuntimeRestarts)
    {
      runtimeRestartAttempts += 1;
      agent = null;
      portWaitAttempts = 0;
      await Task.Delay(750);
      if (!isTerminating) await StartAgentWhenPortIsFreeAsync();
      return;
    }
    ShowFailure(
      $"The local agent exited with status {exitCode}.",
      agent?.OutputTail ?? string.Empty
    );
  }

  private void BeginReadinessChecks()
  {
    readinessAttempts = 0;
    readinessTimer.Stop();
    readinessTimer.Start();
  }

  private async Task CheckReadinessAsync()
  {
    readinessAttempts += 1;
    var health = await healthClient.ProbeAsync(TimeSpan.FromSeconds(1));
    if (isTerminating || !readinessTimer.Enabled) return;
    if (health is not null && AgentHealthClient.MatchesExpectedBuild(health) && health.Ready)
    {
      readinessTimer.Stop();
      agentReady = true;
      notifyIcon.Text = $"{HostConfig.ApplicationName} — ready";
    }
    else if (health is not null && !AgentHealthClient.MatchesExpectedBuild(health))
    {
      readinessTimer.Stop();
      ShowFailure(
        "A different Agent answered the readiness check.",
        $"Running: {AgentHealthClient.Describe(health)}; expected build {HostConfig.ExpectedBuildId}."
      );
    }
    else if (readinessAttempts >= MaxReadinessAttempts)
    {
      readinessTimer.Stop();
      ShowFailure("The local agent did not become ready.", agent?.OutputTail ?? string.Empty);
    }
  }

  // MARK: Installed-build monitoring
  //
  // On macOS the Sparkle-less updater swaps Resources under the running bundle, so the
  // launcher polls release.json and relaunches itself into the new build. On Windows the
  // installer owns file replacement (a running .exe is locked), so the primary flow is
  // "installer stops the host, replaces files, starts the host". This monitor remains as
  // a safety net for payload-only updates (agent/, web/, release.json) staged next to a
  // still-running host.

  private async Task CheckInstalledBuildAsync()
  {
    if (isTerminating || restartingIntoInstalledBuild) return;
    InstalledRelease? installed;
    try
    {
      var payload = await File.ReadAllTextAsync(Path.Combine(resourceRoot, "release.json"));
      installed = System.Text.Json.JsonSerializer.Deserialize<InstalledRelease>(payload);
    }
    catch
    {
      return;
    }
    if (installed?.BuildId is null || installed.SourceRevision is null) return;
    if (
      installed.BuildId == HostConfig.ExpectedBuildId
      && installed.SourceRevision == HostConfig.SourceRevision
    )
    {
      return;
    }

    var health = await healthClient.ProbeAsync(TimeSpan.FromSeconds(1));
    if (isTerminating || restartingIntoInstalledBuild) return;
    if (health?.Busy == false)
    {
      RestartIntoInstalledBuild();
    }
    else
    {
      var sourcePrefix = installed.SourceRevision[..Math.Min(12, installed.SourceRevision.Length)];
      var installedIdentity = $"{installed.BuildId} · {sourcePrefix}";
      if (warnedInstalledBuildId != installedIdentity)
      {
        warnedInstalledBuildId = installedIdentity;
        OfferInstalledBuildRestart(installedIdentity);
      }
    }
  }

  private void OfferInstalledBuildRestart(string installedBuildId)
  {
    var choice = MessageBox.Show(
      $"Restart now to activate build {installedBuildId}? If compression is active, choose No to finish it first; the Agent will restart automatically afterward.",
      "An Agent update was installed",
      MessageBoxButtons.YesNo,
      MessageBoxIcon.Information
    );
    if (choice == DialogResult.Yes) RestartIntoInstalledBuild();
  }

  private void RestartIntoInstalledBuild()
  {
    if (restartingIntoInstalledBuild) return;
    restartingIntoInstalledBuild = true;
    try
    {
      var executablePath =
        Environment.ProcessPath
        ?? throw new InvalidOperationException("The host executable path is unknown.");
      var startInfo = new ProcessStartInfo(executablePath)
      {
        WorkingDirectory = resourceRoot,
        UseShellExecute = false
      };
      startInfo.Environment["AGENT_UPDATE_HANDOFF"] = "1";
      Process.Start(startInfo);
      ExitHost();
    }
    catch (Exception error)
    {
      restartingIntoInstalledBuild = false;
      ShowFailure("The installed update could not be restarted.", error.Message);
    }
  }

  // MARK: Tray actions

  // The packaged web interface and Agent are built from the same contract. Opening the
  // loopback copy makes UI/Agent updates atomic and also avoids browser private-network
  // rules (same rationale as Launcher.swift).
  private void OpenInterface()
  {
    try
    {
      Process.Start(new ProcessStartInfo
      {
        FileName = new Uri(HostConfig.AgentBaseUrl, "local").ToString(),
        UseShellExecute = true
      });
    }
    catch
    {
      // No registered browser; nothing sensible the tray can do.
    }
  }

  private async Task QuitRequestedAsync()
  {
    if (isTerminating) return;
    // Do not silently kill an active compression: check /health busy first and let the
    // user decide (macOS relies on the same busy flag before update restarts). Skip the
    // probe while the agent has not become ready — there is nothing to interrupt yet.
    var health = agentReady ? await healthClient.ProbeAsync(TimeSpan.FromSeconds(1)) : null;
    if (isTerminating) return;
    if (health?.Busy == true)
    {
      var choice = MessageBox.Show(
        "Soty is still processing media. Quitting now marks the active job as interrupted; it can be retried safely later.\n\nQuit anyway?",
        $"Quit {HostConfig.ApplicationName}?",
        MessageBoxButtons.YesNo,
        MessageBoxIcon.Warning
      );
      if (choice != DialogResult.Yes) return;
    }
    ExitHost();
  }

  private void ShowFailure(string message, string details)
  {
    if (isTerminating) return;
    MessageBox.Show(
      string.IsNullOrEmpty(details) ? message : $"{message}\n\n{details}",
      $"{HostConfig.ApplicationName} could not start",
      MessageBoxButtons.OK,
      MessageBoxIcon.Error
    );
    ExitHost();
  }

  private void ExitHost()
  {
    if (isTerminating) return;
    isTerminating = true;
    startupTimer.Stop();
    handoffTimer.Stop();
    readinessTimer.Stop();
    updateMonitorTimer.Stop();
    agent?.Stop();
    agent = null;
    ReleaseInstanceLock();
    notifyIcon.Visible = false;
    notifyIcon.Dispose();
    ExitThread();
  }

  protected override void Dispose(bool disposing)
  {
    if (disposing)
    {
      startupTimer.Dispose();
      handoffTimer.Dispose();
      readinessTimer.Dispose();
      updateMonitorTimer.Dispose();
      instanceLock?.Dispose();
    }
    base.Dispose(disposing);
  }
}
