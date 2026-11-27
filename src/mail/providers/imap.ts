// IMAP setup rules: known servers by address, host and port validation, and
// the sentences for what the backend reports. Port of the setup half of
// providers/ImapProtocol.js; the wire protocol itself is in Rust.
//
// Security: only a loopback server may skip certificate checks (`insecure`),
// which is what Proton Mail Bridge needs; anything else must be TLS on connect
// or a required STARTTLS upgrade (the backend refuses plain text off loopback).
import * as Aliases from "../aliases";

export const DEFAULT_IMAP_PORT = 993;
export const DEFAULT_SMTP_PORT = 465;

interface Preset {
  id: string;
  name: string;
  domains: string[];
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  insecure?: boolean;
  note?: string;
  guide?: { url: string; label: string };
}

// Known services, so the common case is an address and a password rather
// than four hostnames. Every one is TLS on connect except Proton's Bridge,
// which listens on loopback with STARTTLS and a self-signed certificate.
export const PRESETS: Preset[] = [
  {
    id: "gmail",
    name: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    note:
      "Google no longer accepts your account password here. Create an app password " +
      "(Google offers one only with 2-Step Verification on) and paste it below — " +
      "or go back and pick Gmail to sign in with Google and skip all of this.",
    guide: { url: "https://support.google.com/accounts/answer/185833", label: "How to create a Google app password" },
  },
  {
    id: "icloud",
    name: "iCloud",
    domains: ["icloud.com", "me.com", "mac.com"],
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    note: "Needs an app-specific password from appleid.apple.com.",
    guide: { url: "https://support.apple.com/102654", label: "How to create an Apple app-specific password" },
  },
  {
    id: "fastmail",
    name: "Fastmail",
    domains: ["fastmail.com", "fastmail.fm", "messagingengine.com"],
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    note: "Needs an app password from Settings → Privacy & Security.",
  },
  {
    id: "outlook",
    name: "Outlook",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp-mail.outlook.com",
    smtpPort: 587,
    note:
      "Microsoft has withdrawn password sign-in for personal accounts; " +
      "go back and pick Outlook to sign in with Microsoft instead.",
  },
  {
    id: "yahoo",
    name: "Yahoo",
    domains: ["yahoo.com", "yahoo.de", "ymail.com", "rocketmail.com"],
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    note: "Needs an app password from Account Security.",
  },
  {
    id: "zoho",
    name: "Zoho",
    domains: ["zoho.com", "zohomail.com"],
    imapHost: "imap.zoho.com",
    imapPort: 993,
    smtpHost: "smtp.zoho.com",
    smtpPort: 465,
  },
  // GMX is two services under one name: gmx.com is the international one,
  // gmx.de and gmx.net are GMX Germany.
  { id: "gmx", name: "GMX", domains: ["gmx.com"], imapHost: "imap.gmx.com", imapPort: 993, smtpHost: "mail.gmx.com", smtpPort: 465 },
  {
    id: "gmx-de",
    name: "GMX",
    domains: ["gmx.de", "gmx.net"],
    imapHost: "imap.gmx.net",
    imapPort: 993,
    smtpHost: "mail.gmx.net",
    smtpPort: 465,
  },
  // Here for the note: 163 refuses the account password over IMAP.
  {
    id: "netease-163",
    name: "163 Mail",
    domains: ["163.com"],
    imapHost: "imap.163.com",
    imapPort: 993,
    smtpHost: "smtp.163.com",
    smtpPort: 465,
    note:
      "163 does not accept your account password here. Switch IMAP on in the " +
      "mailbox's own settings, then paste the authorisation code it hands you — it " +
      "is a separate string from the password you sign in to the website with.",
    guide: {
      url:
        "https://help.mail.163.com/faqDetail.do?code=" +
        "d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b",
      label: "How to get a 163 authorisation code",
    },
  },
  {
    id: "proton",
    name: "Proton Mail",
    domains: ["proton.me", "protonmail.com", "pm.me"],
    imapHost: "127.0.0.1",
    imapPort: 1143,
    smtpHost: "127.0.0.1",
    smtpPort: 1025,
    insecure: true,
    note: "Only reachable through Proton Mail Bridge, which must be running.",
  },
];

export interface Settings {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
  aliases: Aliases.Alias[];
  insecure: boolean;
  send: "" | "graph";
}

export interface Suggestion {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
  insecure: boolean;
  preset: string;
  note: string;
  guideUrl: string;
  guideLabel: string;
}

function trimmed(value: unknown): string {
  return String(value === undefined || value === null ? "" : value).trim();
}

export function domainOf(address: unknown): string {
  const text = trimmed(address);
  const at = text.lastIndexOf("@");
  return at < 0 ? "" : text.substring(at + 1).toLowerCase();
}

export function presetFor(address: unknown): Preset | null {
  const domain = domainOf(address);
  if (!domain) return null;
  return PRESETS.find((preset) => preset.domains.indexOf(domain) >= 0) ?? null;
}

/** What to put in the form for an address: a preset's servers, else `imap.<domain>` and `smtp.<domain>`. */
export function suggestedSettings(address: unknown): Suggestion {
  const preset = presetFor(address);
  const domain = domainOf(address);
  if (preset) {
    return {
      imapHost: preset.imapHost,
      imapPort: preset.imapPort,
      smtpHost: preset.smtpHost,
      smtpPort: preset.smtpPort,
      username: trimmed(address),
      insecure: preset.insecure === true,
      preset: preset.id,
      note: String(preset.note || ""),
      guideUrl: preset.guide ? preset.guide.url : "",
      guideLabel: preset.guide ? preset.guide.label : "",
    };
  }
  return {
    imapHost: domain ? "imap." + domain : "",
    imapPort: DEFAULT_IMAP_PORT,
    smtpHost: domain ? "smtp." + domain : "",
    smtpPort: DEFAULT_SMTP_PORT,
    username: trimmed(address),
    insecure: false,
    preset: "",
    note: "",
    guideUrl: "",
    guideLabel: "",
  };
}

/** A hostname, not a URL or host:port: everything here ends up where a password is sent. */
export function isValidHost(value: unknown): boolean {
  const host = trimmed(value);
  if (host === "" || host.length > 253) return false;
  if (/[\s/\\@:?#"'<>]/.test(host)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(host);
}

export function normalizedPort(value: unknown, fallback: unknown): number {
  const port = Math.floor(Number(value));
  const backup = Math.floor(Number(fallback)) || DEFAULT_IMAP_PORT;
  if (!isFinite(port) || port < 1 || port > 65535) return backup;
  return port;
}

export function isLoopback(host: unknown): boolean {
  const name = trimmed(host).toLowerCase();
  return name === "127.0.0.1" || name === "::1" || name === "localhost";
}

export function normalizeSend(value: unknown): "" | "graph" {
  return trimmed(value).toLowerCase() === "graph" ? "graph" : "";
}

/** Host names lower-cased; `insecure` only ever on loopback. */
export function normalizeSettings(raw: any): Settings {
  const values = raw || {};
  return {
    imapHost: trimmed(values.imapHost).toLowerCase(),
    imapPort: normalizedPort(values.imapPort, DEFAULT_IMAP_PORT),
    smtpHost: trimmed(values.smtpHost).toLowerCase(),
    smtpPort: normalizedPort(values.smtpPort, DEFAULT_SMTP_PORT),
    username: trimmed(values.username),
    aliases: Aliases.parse(values.aliases),
    insecure: values.insecure === true && isLoopback(values.imapHost),
    send: normalizeSend(values.send),
  };
}

/** The setup form's fields to settings: the login defaults to the address, and the server (not the domain) decides loopback. */
export function setupSettings(raw: any): Settings {
  const values = raw || {};
  return normalizeSettings({
    imapHost: values.imapHost,
    imapPort: values.imapPort,
    smtpHost: values.smtpHost,
    smtpPort: values.smtpPort,
    username: trimmed(values.username) || trimmed(values.address),
    aliases: values.aliases,
    insecure: isLoopback(values.imapHost),
    send: values.send,
  });
}

/** One problem at a time, in the order the form reads. */
export function validateSettings(raw: any): { ok: true; error: ""; settings: Settings } | { ok: false; error: string } {
  const settings = normalizeSettings(raw);
  if (settings.username === "") return { ok: false, error: "Add the username for this mailbox" };
  if (settings.imapHost === "") return { ok: false, error: "Add the IMAP server address" };
  if (!isValidHost(settings.imapHost)) return { ok: false, error: "That is not a valid IMAP server address" };
  if (settings.smtpHost !== "" && !isValidHost(settings.smtpHost))
    return { ok: false, error: "That is not a valid SMTP server address" };
  return { ok: true, error: "", settings };
}

/** A password can end up in an error line, a server's echo of LOGIN or a URL: nothing reaches a label without this. */
export function redact(text: unknown): string {
  return String(text === undefined || text === null ? "" : text)
    .replace(/\b(LOGIN)\s+\S+\s+\S+/gi, "$1 [redacted]")
    .replace(/\b(AUTHENTICATE)\s+\w+\s+\S+/gi, "$1 [redacted]")
    .replace(/(imaps?|smtps?):\/\/[^\s/@]*:[^\s/@]*@/gi, "$1://[redacted]@")
    .replace(/(password|pass|pwd)\s*[=:]\s*\S+/gi, "$1=[redacted]");
}

/** The sentence for a backend error code (ImapClient.backendError). */
export function backendError(code: unknown): string {
  switch (String(code || "")) {
    case "smtp_delivery_unknown":
      return "The server did not confirm delivery. Check Sent before sending again.";
    case "mail_auth_failed":
    case "auth_signed_out":
      return "The server rejected the sign-in. Sign in again.";
    case "mail_auth_unavailable":
      return "The server could not check the sign-in right now. Wait a few minutes, then sign in again.";
    case "mail_auth_expired":
      return "The server says this password has expired. Create a new password or app password, then sign in again.";
    case "mail_auth_contact_admin":
      return "The server refused the sign-in and asks you to contact your mail administrator.";
    case "mail_auth_unauthorized":
      return "The server accepted the password but does not let this account use the mailbox.";
    case "mail_auth_privacy_required":
      return "The server requires an encrypted connection before it accepts a sign-in.";
    case "mail_dns_failed":
      return "Could not find the mail server. Check the server address and your internet connection.";
    case "mail_tls_failed":
      return "The mail server's secure connection could not be verified";
    case "request_timed_out":
      return "The mail server did not answer in time";
    case "imap_search_expired":
      return "This search has expired. Refresh to search again.";
    case "imap_folder_unavailable":
      return "This server did not report the requested folder";
    default:
      return "Mail request failed";
  }
}

/** A typed password, ready to verify, or the sentence that says why not. */
export function checkedPassword(secret: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const value = String(secret || "").replace(/[\r\n]+$/, "");
  if (/[\x00-\x1f\x7f]/.test(value)) return { ok: false, error: "The password contains a control character. Enter it again" };
  if (value === "") return { ok: false, error: "Enter the password for this mailbox" };
  return { ok: true, value };
}
