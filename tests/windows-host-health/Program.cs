// Executable regression against the production C# client, without WinForms.
// Run: dotnet run --project tests/windows-host-health/WindowsHostHealth.csproj
using System.Net;
using System.Net.Sockets;
using System.Text;
using Soty.AgentHost;

using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(10));
using var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
HostConfig.AgentBaseUrl = new Uri($"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/");
var server = Task.Run(async () => {
  while (!budget.IsCancellationRequested) {
    using var client = await listener.AcceptTcpClientAsync(budget.Token);
    var stream = client.GetStream();
    await stream.ReadAsync(new byte[8192], budget.Token);
    const string payload = """{"product":"local-video-compressor-agent","ready":true,"version":"1.2.8","buildNumber":"73","buildId":"1.2.8+73","apiVersion":5,"sourceRevision":"fixture","tools":{"ffmpeg":true,"ffprobe":true}}""";
    var bytes = Encoding.UTF8.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {Encoding.UTF8.GetByteCount(payload)}\r\nConnection: close\r\n\r\n{payload}");
    await stream.WriteAsync(bytes, budget.Token);
  }
});
// Reserve an unused endpoint: a configured proxy is unavailable while the agent is healthy.
using var unavailableProxy = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
unavailableProxy.Bind(new IPEndPoint(IPAddress.Loopback, 0));
HttpClient.DefaultProxy = new WebProxy($"http://127.0.0.1:{((IPEndPoint)unavailableProxy.LocalEndPoint!).Port}");
try {
  using var direct = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(2) };
  var response = await direct.GetStringAsync(new Uri(HostConfig.AgentBaseUrl, "health"), budget.Token);
  if (!response.Contains("\"ready\":true")) throw new Exception("Fixture agent is not ready");
  var health = await new AgentHealthClient().ProbeAsync(TimeSpan.FromSeconds(1));
  if (health is null || !health.Ready || !AgentHealthClient.MatchesExpectedBuild(health))
    throw new Exception("Launcher rejected a healthy loopback agent because the configured proxy is unavailable");
  Console.WriteLine("PASS: production launcher reaches healthy loopback agent despite unavailable system proxy.");
} finally {
  budget.Cancel();
  listener.Stop();
  try { await server; } catch (OperationCanceledException) { } catch (SocketException) { }
}

namespace Soty.AgentHost {
  static class HostConfig {
    public static Uri AgentBaseUrl = new("http://127.0.0.1:1/");
    public const string ExpectedBuildId = "1.2.8+73";
    public const int ExpectedApiVersion = 5;
    public const string SourceRevision = "fixture";
  }
}
