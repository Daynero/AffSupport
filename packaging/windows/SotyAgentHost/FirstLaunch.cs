namespace Soty.AgentHost;

/// <summary>
/// The one start on which Soty opens its website by itself (070, owner 2026-11-24) — the
/// port of the "First launch" block in packaging/Launcher.swift, decision for decision.
/// A newcomer's first start goes straight to the notification area, while everything Soty
/// does is controlled on the site; every later start stays quiet.
/// </summary>
internal static class FirstLaunch
{
  public const string MarkerName = "first-launch-site-opened";

  /// <summary>
  /// Files the agent writes on its first start. Any of them means Soty has already run for
  /// this user here — an install from before the marker existed, or an update of one.
  /// </summary>
  private static readonly string[] ExistingAgentStateNames = { "state.json", "session-token.json" };

  /// <summary>
  /// The agent's own per-user directory: Roaming AppData, the folder the agent resolves
  /// from <c>APPDATA</c> and <c>AGENT_SUPPORT_DIRECTORY_NAME</c>.
  /// </summary>
  public static string SupportDirectory(string supportDirectoryName) =>
    Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
      supportDirectoryName
    );

  /// <summary>
  /// Whether this start is the first for this user on this computer, decided once and
  /// recorded. The marker is created exclusively, so two hosts racing each other cannot both
  /// open the site, and it is written even when the answer is no. A directory that cannot be
  /// written answers no: a site opened on every start would be worse than one never opened.
  /// </summary>
  public static bool Claim(string directory, bool suppressed)
  {
    if (suppressed) return false;
    var marker = Path.Combine(directory, MarkerName);
    if (File.Exists(marker)) return false;
    var ranBefore = ExistingAgentStateNames.Any(name => File.Exists(Path.Combine(directory, name)));
    try
    {
      Directory.CreateDirectory(directory);
      using var created = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None);
    }
    catch (IOException)
    {
      return false;
    }
    catch (UnauthorizedAccessException)
    {
      return false;
    }
    return !ranBefore;
  }

  /// <summary>
  /// Where the first start lands: the spaces route, which opens the space this browser last
  /// used, the list of spaces, or sign-in first.
  /// </summary>
  public static Uri? SiteUrl(string origin)
  {
    if (
      !Uri.TryCreate(origin, UriKind.Absolute, out var site)
      || (site.Scheme != Uri.UriSchemeHttps && site.Scheme != Uri.UriSchemeHttp)
      || string.IsNullOrEmpty(site.Host)
    )
      return null;
    return new Uri(site, "/team");
  }
}
