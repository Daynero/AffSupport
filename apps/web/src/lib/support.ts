// Support / donation destinations for the "Support the project" dialog.
//
// Everything here is intentionally empty for now — fill in the values when
// they are ready. Empty values gracefully hide the matching option in the
// dialog, so the UI never shows a broken link or an empty wallet.

export type CryptoWallet = {
  /** Human-readable network label, e.g. "USDT (TRC-20)" or "BTC". */
  network: string;
  /** Wallet address on that network. */
  address: string;
};

export const supportConfig = {
  // Email that receives feedback messages. Used to build a mailto: link.
  // Leave empty to hide the message form until it is ready.
  email: 'wishly.app.support@gmail.com',

  // Monobank jar link, e.g. https://send.monobank.ua/jar/XXXXXXXX
  monobankUrl: '',

  // Crypto wallets on different networks. Each configured wallet shows a
  // copy button and a QR code generated from its address.
  cryptoWallets: [
    { network: 'USDT · TRC-20 (TRX)', address: 'TC5LQ4uo7FQQoMUheXrXt7TZ3xT67bvAcn' },
    { network: '', address: '' }
  ] as CryptoWallet[]
};

/** Crypto wallets that are actually configured (both network and address). */
export const activeCryptoWallets = supportConfig.cryptoWallets.filter(
  wallet => wallet.network.trim() !== '' && wallet.address.trim() !== ''
);

/** Trimmed Monobank link, or an empty string when not configured. */
export const monobankUrl = supportConfig.monobankUrl.trim();

/** Trimmed support email, or an empty string when not configured. */
export const supportEmail = supportConfig.email.trim();

/** Whether at least one donation destination is ready to show. */
export const hasDonationOptions = monobankUrl !== '' || activeCryptoWallets.length > 0;
