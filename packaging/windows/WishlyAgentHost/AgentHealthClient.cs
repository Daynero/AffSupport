using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Wishly.AgentHost;

// Mirrors the AgentHealth / InstalledRelease structs in packaging/Launcher.swift.
internal sealed record AgentHealth
{
  [JsonPropertyName("product")] public string? Product { get; init; }
  [JsonPropertyName("ready")] public bool Ready { get; init; }
  [JsonPropertyName("version")] public string? Version { get; init; }
  [JsonPropertyName("buildNumber")] public string? BuildNumber { get; init; }
  [JsonPropertyName("buildId")] public string? BuildId { get; init; }
  [JsonPropertyName("apiVersion")] public int? ApiVersion { get; init; }
  [JsonPropertyName("sourceRevision")] public string? SourceRevision { get; init; }
  [JsonPropertyName("busy")] public bool? Busy { get; init; }
}

internal sealed record InstalledRelease
{
  [JsonPropertyName("buildId")] public string? BuildId { get; init; }
  [JsonPropertyName("sourceRevision")] public string? SourceRevision { get; init; }
}

internal sealed class AgentHealthClient
{
  private const string ExpectedProduct = "local-video-compressor-agent";

  private static readonly HttpClient Http = new()
  {
    // Per-probe timeouts are enforced with a CancellationTokenSource; keep the
    // client-wide timeout out of the way.
    Timeout = Timeout.InfiniteTimeSpan
  };

  private static readonly JsonSerializerOptions JsonOptions = new()
  {
    AllowTrailingCommas = true
  };

  /// <summary>
  /// GET /health with a short timeout. Returns the parsed payload only when a Wishly
  /// agent answered with HTTP 200; any error, timeout, or foreign responder yields null
  /// (same contract as probeHealth in Launcher.swift). /health is unauthenticated;
  /// X-Wishly-Native-Token is only required by the /native/* routes.
  /// </summary>
  public async Task<AgentHealth?> ProbeAsync(TimeSpan timeout)
  {
    try
    {
      using var cancellation = new CancellationTokenSource(timeout);
      using var request = new HttpRequestMessage(
        HttpMethod.Get,
        new Uri(HostConfig.AgentBaseUrl, "health")
      );
      request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true };
      using var response = await Http.SendAsync(request, cancellation.Token);
      if (response.StatusCode != System.Net.HttpStatusCode.OK) return null;
      var payload = await response.Content.ReadAsStringAsync(cancellation.Token);
      var health = JsonSerializer.Deserialize<AgentHealth>(payload, JsonOptions);
      return health?.Product == ExpectedProduct ? health : null;
    }
    catch
    {
      return null;
    }
  }

  public static bool MatchesExpectedBuild(AgentHealth health) =>
    health.BuildId == HostConfig.ExpectedBuildId
    && health.ApiVersion == HostConfig.ExpectedApiVersion
    && health.SourceRevision == HostConfig.SourceRevision;

  public static string Describe(AgentHealth health)
  {
    var version = health.Version ?? "legacy version";
    var build = health.BuildNumber is { } number ? $"build {number}" : "unknown build";
    var api = health.ApiVersion?.ToString() ?? "unknown";
    var revision = health.SourceRevision is { Length: > 0 } source
      ? source[..Math.Min(12, source.Length)]
      : "unknown source";
    return $"{version}, {build}, API {api}, source {revision}";
  }
}
