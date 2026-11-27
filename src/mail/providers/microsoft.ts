// Microsoft sign-in for Outlook.com (IMAP and SMTP over XOAUTH2): tenants,
// client ids and the device-code flow's answers. Port of the parts of
// providers/MicrosoftOAuth.js the Outlook setup uses; the HTTP requests go
// through the backend's auth.form, which only ever posts to Microsoft's own
// device and token endpoints.
//
// Security: what Microsoft answers is untrusted. The verification page must
// be one of Microsoft's own hosts, and every error passes `redact` so no
// token, code or secret reaches a label.
import { Buffer } from "buffer";
import * as Google from "./google";
import * as Imap from "./imap";

/** IMAP, SMTP and a refresh token: all Outlook's mail needs. */
export const SCOPES = [
  "openid",
  "offline_access",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
];

export const ENTRA_APPS_URL = "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";
export const OUTLOOK_IMAP_HELP_URL =
  "https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com";

/** A maintainer-owned registration could fill this; until then every user brings their own. */
const BUILTIN_CLIENT_ID = "";

function trimmed(value: unknown): string {
  return String(value === undefined || value === null ? "" : value).trim();
}

export function normalizeTenant(value: unknown): string {
  const text = trimmed(value).toLowerCase();
  if (text === "" || text === "consumers") return "consumers";
  if (text === "organizations" || text === "common") return text;
  if (/^[a-z0-9][a-z0-9.-]{0,254}$/.test(text) && text.indexOf("..") < 0) return text;
  return "consumers";
}

export function isWorkTenant(tenant: unknown): boolean {
  return normalizeTenant(tenant) !== "consumers";
}

export function isDirectoryId(value: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed(value));
}

export function isTenantDomain(value: unknown): boolean {
  const text = trimmed(value).toLowerCase();
  if (text.length > 253 || text.indexOf(".") < 1) return false;
  return text.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/** A work authority from the typed tenant: empty is multitenant; "" for input that is no tenant. */
export function workTenant(value: unknown): string {
  const text = trimmed(value).toLowerCase();
  if (text === "") return "organizations";
  if (text === "organizations") return text;
  if (isDirectoryId(text) || isTenantDomain(text)) return text;
  return "";
}

export function isValidClientId(value: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed(value));
}

export function effectiveClientId(value: unknown): string {
  const configured = trimmed(value);
  return isValidClientId(configured) ? configured : trimmed(BUILTIN_CLIENT_ID);
}

export function hasBuiltinClient(): boolean {
  return isValidClientId(BUILTIN_CLIENT_ID);
}

/** The page Microsoft sends people to, only when it is one of Microsoft's own hosts. */
export function verificationUri(value: unknown): string {
  const text = trimmed(value);
  const match = text.match(/^https:\/\/([^\/:?#]+)(?::443)?(?:[\/?#]|$)/i);
  if (!match) return "";
  const host = match[1].toLowerCase();
  if (
    host !== "microsoft.com" &&
    host !== "www.microsoft.com" &&
    host !== "login.microsoft.com" &&
    host !== "login.microsoftonline.com"
  )
    return "";
  return text;
}

export function formBody(values: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value === undefined || value === null || value === "") continue;
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
  }
  return parts.join("&");
}

export function deviceAuthorizationBody(clientId: string, scopes: string[] = SCOPES): string {
  return formBody({ client_id: trimmed(clientId), scope: scopes.join(" ") });
}

export function deviceTokenBody(clientId: string, deviceCode: string): string {
  return formBody({
    client_id: trimmed(clientId),
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: String(deviceCode || ""),
  });
}

function parseJson(text: unknown): any {
  try {
    const parsed = JSON.parse(String(text || ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function redact(text: unknown): string {
  return Google.redact(text)
    .replace(/(device_code|user_code)=[^&\s"']+/gi, "$1=[redacted]")
    .replace(/"(device_code|user_code)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, "[redacted]");
}

export function errorMessage(payload: any, fallback: string): string {
  const value = payload || {};
  const code = String(value.error || "");
  const detail = String(value.error_description || "");
  if (code === "authorization_declined" || code === "access_denied") return "Microsoft sign-in was cancelled";
  if (code === "expired_token" || code === "bad_verification_code")
    return "The Microsoft sign-in code expired. Please try again";
  if (code === "invalid_client" || code === "unauthorized_client")
    return "Microsoft rejected this OAuth client. Check the client ID and public-client setting";
  if (code === "invalid_grant") return "Microsoft rejected the saved session. Sign in again";
  if (detail) return redact(detail);
  if (code) return redact(code);
  return fallback;
}

export interface DeviceStart {
  ok: true;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export function parseDeviceResponse(status: number, text: unknown): DeviceStart | { ok: false; error: string } {
  const payload = parseJson(text);
  if (
    status < 200 ||
    status >= 300 ||
    !payload ||
    !payload.device_code ||
    !payload.user_code ||
    !verificationUri(payload.verification_uri)
  ) {
    return { ok: false, error: errorMessage(payload, "Could not start Microsoft sign-in. Please try again") };
  }
  return {
    ok: true,
    deviceCode: String(payload.device_code),
    userCode: String(payload.user_code),
    verificationUri: verificationUri(payload.verification_uri),
    expiresIn: Math.max(60, Number(payload.expires_in) || 900),
    interval: Math.max(5, Number(payload.interval) || 5),
  };
}

export function consentRequired(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  const code = String(payload.error || "");
  if (code !== "invalid_grant" && code !== "interaction_required") return false;
  if (String(payload.suberror || "") === "consent_required") return true;
  const codes = Array.isArray(payload.error_codes) ? payload.error_codes : [];
  if (codes.some((value: unknown) => Number(value) === 65001)) return true;
  return /AADSTS65001/.test(String(payload.error_description || ""));
}

export type TokenResult =
  | { ok: true; pending: false; accessToken: string; refreshToken: string; expiresIn: number; scope: string; idToken: string }
  | { ok: false; pending: true; slowDown: boolean; error: "" }
  | { ok: false; pending: false; invalidGrant: boolean; consentRequired: boolean; error: string };

export function parseTokenResponse(status: number, text: unknown, previousRefreshToken = ""): TokenResult {
  const payload = parseJson(text);
  const code = payload ? String(payload.error || "") : "";
  if (code === "authorization_pending" || code === "slow_down") {
    return { ok: false, pending: true, slowDown: code === "slow_down", error: "" };
  }
  if (status < 200 || status >= 300 || !payload || !payload.access_token) {
    return {
      ok: false,
      pending: false,
      invalidGrant: code === "invalid_grant",
      consentRequired: consentRequired(payload),
      error: errorMessage(payload, "Could not complete Microsoft sign-in. Please try again"),
    };
  }
  return {
    ok: true,
    pending: false,
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token || previousRefreshToken || ""),
    expiresIn: Math.max(60, Number(payload.expires_in) || 3600),
    scope: String(payload.scope || ""),
    idToken: String(payload.id_token || ""),
  };
}

function scopeListed(granted: unknown, scope: string): boolean {
  const text = String(granted || "").trim().toLowerCase();
  if (text === "") return true;
  const have = text.split(/\s+/);
  const full = scope.toLowerCase();
  const short = full.substring(full.lastIndexOf("/") + 1);
  return have.indexOf(full) >= 0 || have.indexOf(short) >= 0;
}

export function missingMailScopes(granted: unknown): string[] {
  return SCOPES.filter((scope) => scope !== "offline_access" && scope !== "openid" && !scopeListed(granted, scope));
}

export function missingScopeMessage(missing: string[]): string {
  if (!Array.isArray(missing) || missing.length === 0) return "";
  const names = missing.map((value) => value.substring(value.lastIndexOf("/") + 1));
  return (
    "Microsoft sign-in finished without the " +
    names.join(" and ") +
    " permission. Check the app registration and sign in again"
  );
}

/** Outlook's servers for an address: smtp.office365.com for a work tenant, smtp-mail.outlook.com otherwise. */
export function outlookSettings(address: unknown, tenant: unknown, send: unknown): Imap.Settings {
  const work = isWorkTenant(tenant);
  return Imap.normalizeSettings({
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: work ? "smtp.office365.com" : "smtp-mail.outlook.com",
    smtpPort: 587,
    username: trimmed(address),
    insecure: false,
    send,
  });
}

/** The connection check's report, one line per capability. */
export function connectionStatus(report: any, graphSend: boolean, workAccount: boolean): string {
  const value = report || {};
  return [
    "Account type: " + (workAccount ? "Work or school" : "Personal Microsoft account"),
    "Mail access: " + (value.mail === true ? "Connected" : "Check the sign-in and IMAP access"),
    "Microsoft Graph: " +
      (value.graph === true ? "Mail.Send and Calendars.ReadWrite granted" : "Check the app permissions and sign in again"),
    "Calendar: " + (value.calendar === true ? "Reachable" : "Check Calendars.ReadWrite and sign in again"),
    "Sending: " + (graphSend ? "Microsoft Graph selected" : "SMTP selected"),
  ].join("\n");
}

// ---------------------------------------------------------------- Microsoft Graph
//
// A work tenant that sends through Graph needs Graph's own consent: after the
// mail sign-in, a Graph token is asked for (auth.token, resource "graph");
// refused for want of consent, or issued without Mail.Send, a second device
// code collects it. Port of MicrosoftOAuth.js's Graph part.

export const GRAPH_SCOPES = ["https://graph.microsoft.com/Mail.Send", "https://graph.microsoft.com/Calendars.ReadWrite"];
export const GRAPH_SIGN_IN_SCOPES = ["openid", "profile", "email", "offline_access"].concat(GRAPH_SCOPES);

export function missingGraphScope(granted: unknown): boolean {
  return !scopeListed(granted, GRAPH_SCOPES[0]);
}

export function graphScopeMessage(): string {
  return (
    "This sign-in has not granted the Mail.Send permission for Microsoft Graph. " +
    "Sign in again to grant it; if that does not help, add it to the app registration"
  );
}

export function graphConsentMessage(): string {
  return "Microsoft Graph needs its own consent for this mailbox. Open the mailbox's settings and press Allow Microsoft Graph";
}

function graphScopeNames(): string {
  return GRAPH_SCOPES.map((scope) => scope.substring(scope.lastIndexOf("/") + 1)).join(" and ");
}

export function graphRefusedMessage(reason: unknown): string {
  return (
    "Microsoft Graph was not allowed: " +
    String(reason || "") +
    ". The mailbox is signed in; Allow Microsoft Graph... in its settings asks again. If Microsoft asked for admin approval, " +
    "an administrator must grant the app registration " +
    graphScopeNames() +
    " first"
  );
}

function base64UrlDecode(value: string): string {
  const text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = text + "===".slice(0, (4 - (text.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*=*$/.test(padded)) return "";
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** The id token's claims, unverified: only used to tell which account a code was entered as. */
export function idTokenClaims(idToken: unknown): Record<string, unknown> | null {
  const parts = String(idToken || "").split(".");
  if (parts.length < 2) return null;
  const payload = parseJson(base64UrlDecode(parts[1]));
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
}

export function signedInAs(idToken: unknown): string {
  const claims = idTokenClaims(idToken);
  if (!claims) return "";
  for (const name of ["preferred_username", "email", "upn"]) {
    const value = trimmed(claims[name]).toLowerCase();
    if (value !== "") return value;
  }
  return "";
}

export function accountKey(idToken: unknown): string {
  const claims = idTokenClaims(idToken);
  if (!claims) return "";
  const tenant = trimmed(claims.tid);
  const object = trimmed(claims.oid);
  return tenant !== "" && object !== "" ? tenant + "/" + object : "";
}

/** The id token names the mailbox's own account: by id where known, else by name; none named is let through. */
export function sameAccount(idToken: unknown, email: unknown, mailKey: unknown): boolean {
  const key = trimmed(mailKey);
  if (key !== "") return accountKey(idToken) === key;
  const who = signedInAs(idToken);
  return who === "" || who === trimmed(email).toLowerCase();
}

export function otherAccountMessage(who: unknown, email: unknown): string {
  const name = String(who || "");
  return (
    "the second code was entered as " +
    (name !== "" ? name : "another Microsoft account") +
    ", not " +
    trimmed(email) +
    ". Sign in to Microsoft as the mailbox's own account"
  );
}
