namespace Soty.AgentHost;

internal static class Program
{
  [STAThread]
  private static void Main()
  {
    ApplicationConfiguration.Initialize();
    using var tray = new TrayApplication();
    Application.Run(tray);
  }
}
