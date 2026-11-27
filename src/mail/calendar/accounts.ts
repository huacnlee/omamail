// `calendarProvider` of omarchy/ui/account/Accounts.js: which calendar API an
// account's sign-in reaches.

function trimmed(value: unknown): string {
  return String(value === undefined || value === null ? "" : value).trim();
}

/** The fields of an account the choice reads; anything else is ignored. */
export interface ProviderAccount {
  provider?: unknown;
  email?: unknown;
  imap?: { imapHost?: unknown } | null;
}

export function calendarProvider(raw: ProviderAccount | null | undefined): "google" | "microsoft" | "icloud" | "" {
  const account: ProviderAccount = raw || {};
  const provider = trimmed(account.provider).toLowerCase();
  if (provider === "gmail" || provider === "") return "google";
  if (provider === "outlook" || provider === "m365") return "microsoft";
  if (provider !== "imap") return "";
  const host = trimmed(account.imap && account.imap.imapHost).toLowerCase();
  const email = trimmed(account.email).toLowerCase();
  const domain = email.lastIndexOf("@") >= 0 ? email.substring(email.lastIndexOf("@") + 1) : "";
  return host === "imap.mail.me.com" || ["icloud.com", "me.com", "mac.com"].indexOf(domain) >= 0 ? "icloud" : "";
}
