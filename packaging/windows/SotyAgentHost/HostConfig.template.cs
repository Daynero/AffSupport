// Template rendered by scripts/render-launcher.mjs (plain string replacement of
// double-underscore placeholders), mirroring how packaging/Launcher.swift is rendered
// by scripts/package-mac.sh. Note: the renderer rejects any leftover placeholder-shaped
// text, so this file must not mention the placeholder pattern outside real placeholders.
// The renderer escapes backslashes and double quotes for string literals, so every
// placeholder that receives text must sit inside a regular "..." literal (never @"...").
// AGENT_PORT and API_VERSION are rendered as bare integers, exactly like the Swift template.
namespace Soty.AgentHost;

internal static class HostConfig
{
  public const int AgentPort = __AGENT_PORT__;
  public const string ApplicationName = "__APP_NAME__";
  public const string InstanceLockName = "__INSTANCE_LOCK_NAME__";
  public const string SupportDirectoryName = "__SUPPORT_DIRECTORY_NAME__";
  public const string PublicSiteOrigin = "__PUBLIC_SITE_ORIGIN__";
  public const string ExpectedVersion = "__APP_VERSION__";
  public const string ExpectedBuildNumber = "__BUILD_NUMBER__";
  public const string ExpectedBuildId = "__BUILD_ID__";
  public const int ExpectedApiVersion = __API_VERSION__;
  public const string ReleaseChannel = "__RELEASE_CHANNEL__";
  public const string SourceRevision = "__SOURCE_REVISION__";
  public const string EntitlementPublicKey = "__AGENT_ENTITLEMENT_PUBLIC_KEY__";

  public static readonly Uri AgentBaseUrl = new($"http://127.0.0.1:{AgentPort}/");
}
