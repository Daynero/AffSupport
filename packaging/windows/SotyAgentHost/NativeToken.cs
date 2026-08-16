using System.Security.Cryptography;

namespace Soty.AgentHost;

internal static class NativeToken
{
  /// <summary>
  /// Matches the Swift launcher's token shape: two uppercase RFC 4122 v4 UUID strings
  /// concatenated (72 characters, 2 x 122 bits of CSPRNG entropy). The agent compares
  /// the token verbatim, so only shape and entropy matter, not UUID semantics.
  /// </summary>
  public static string Generate() => RandomUuid() + RandomUuid();

  private static string RandomUuid()
  {
    Span<byte> bytes = stackalloc byte[16];
    RandomNumberGenerator.Fill(bytes);
    bytes[6] = (byte)((bytes[6] & 0x0F) | 0x40); // version 4
    bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80); // RFC 4122 variant
    var hex = Convert.ToHexString(bytes); // uppercase, matching Swift's UUID().uuidString
    return $"{hex[..8]}-{hex[8..12]}-{hex[12..16]}-{hex[16..20]}-{hex[20..]}";
  }
}
