// Executable regression against the production C# first-launch decision, without WinForms.
// Run: dotnet run --project tests/windows-first-launch/WindowsFirstLaunch.csproj
using Soty.AgentHost;

var root = Path.Combine(Path.GetTempPath(), $"soty-first-launch-{Guid.NewGuid():N}");
void Require(bool condition, string code)
{
  if (!condition) throw new Exception(code);
}
string Folder(string name) => Path.Combine(root, name);
void Write(string name, string folder)
{
  Directory.CreateDirectory(folder);
  File.WriteAllText(Path.Combine(folder, name), "{}");
}
try
{
  var fresh = Folder("fresh");
  Require(FirstLaunch.Claim(fresh, suppressed: false), "NEW_USER_NOT_OPENED");
  Require(!FirstLaunch.Claim(fresh, suppressed: false), "SECOND_START_OPENED");
  Require(File.Exists(Path.Combine(fresh, FirstLaunch.MarkerName)), "MARKER_MISSING");

  var updated = Folder("updated");
  Write("state.json", updated);
  Require(!FirstLaunch.Claim(updated, suppressed: false), "UPDATE_OPENED");
  File.Delete(Path.Combine(updated, "state.json"));
  Require(!FirstLaunch.Claim(updated, suppressed: false), "ANSWER_NOT_RECORDED");

  var paired = Folder("paired");
  Write("session-token.json", paired);
  Require(!FirstLaunch.Claim(paired, suppressed: false), "PAIRED_INSTALL_OPENED");

  var verification = Folder("verification");
  Require(!FirstLaunch.Claim(verification, suppressed: true), "SUPPRESSED_OPENED");
  Require(FirstLaunch.Claim(verification, suppressed: false), "SUPPRESSION_CONSUMED_FIRST_START");

  Require(FirstLaunch.SiteUrl("https://soty.pp.ua")?.ToString() == "https://soty.pp.ua/team", "PROD_URL");
  Require(FirstLaunch.SiteUrl("https://next.soty.pp.ua")?.ToString() == "https://next.soty.pp.ua/team", "NEXT_URL");
  Require(FirstLaunch.SiteUrl("http://127.0.0.1:43140")?.ToString() == "http://127.0.0.1:43140/team", "BETA_URL");
  Require(FirstLaunch.SiteUrl("") is null, "EMPTY_ORIGIN");
  Require(FirstLaunch.SiteUrl("file:///C:/Windows") is null, "FILE_ORIGIN");
  Console.WriteLine("PASS: the first start opens the site once; updates, repeats and verification runs do not.");
}
finally
{
  if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
}
