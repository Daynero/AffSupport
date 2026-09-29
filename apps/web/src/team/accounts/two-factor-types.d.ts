import '@video-compressor/shared';

declare module '@video-compressor/shared' {
  interface TeamAccountSummary {
    /** Decrypted social-account credential, loaded through the private 2FA RPC only. */
    twoFactorSeed?: string | null;
  }
}
