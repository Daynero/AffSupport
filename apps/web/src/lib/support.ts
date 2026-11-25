// Support destinations: the technical-support inbox and the workspace-subscription contact.

export const supportConfig = {
  // Workspace subscription enquiries: opens a draft, never sends it.
  spaceAdminTelegram: 'Roma_mbuyer',

  // Email that receives support messages. Used to build a mailto: link.
  // Leave empty to hide the message form until it is ready.
  email: 'Soty.support@gmail.com'
};

/** Trimmed support email, or an empty string when not configured. */
export const supportEmail = supportConfig.email.trim();
