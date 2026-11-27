// Google sign-in for Gmail: the OAuth client a user brings (credentials.json),
// the scopes asked for and the sentences for what fails. Ports of
// providers/Credentials.js (the client file) and providers/OAuth.js (the
// parts the in-process flow still needs: the loopback listener, the token
// exchange and the profile check all run in Rust behind auth.begin / auth.poll).
//
// Security: the client file is the only Google secret the UI ever holds, and
// it is written owner-only by the native side. Refresh tokens are stored by
// the backend itself; every error passes `redact` before it is shown.

export const DEFAULT_PORT = 9481;

/** gmail.modify reads and labels but cannot delete; gmail.send replies; the calendar scopes read and create events. */
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

/** Asked for, not required: recipient suggestions from saved contacts. */
export const OPTIONAL_SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
];

export const CLOUD_CLIENT_URL = "https://console.cloud.google.com/auth/clients/create";
export const CONSENT_SCREEN_URL = "https://console.cloud.google.com/auth/overview";
export const GMAIL_API_URL = "https://console.cloud.google.com/apis/library/gmail.googleapis.com";

export function normalizedPort(value: unknown): number {
  const port = Math.floor(Number(value));
  return port >= 1024 && port <= 65535 ? port : DEFAULT_PORT;
}

export function redact(text: unknown): string {
  return String(text === undefined || text === null ? "" : text)
    .replace(/(refresh_token|access_token|code_verifier|client_secret|id_token)=[^&\s"']+/gi, "$1=[redacted]")
    .replace(/"(refresh_token|access_token|code_verifier|client_secret|id_token)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\b1\/\/[A-Za-z0-9._-]{20,}/g, "[redacted]")
    .replace(/\bGOCSPX-[A-Za-z0-9._-]+/g, "[redacted]");
}

const PROXY_NOTE =
  "Omamail's Google API calls do not use an HTTP proxy, so a proxy-only network needs a system-wide VPN";

/** What each backend sign-in code means to the person signing in. */
export const SIGN_IN_SENTENCES: Record<string, string> = {
  auth_cancelled: "Google sign-in was cancelled. Try again",
  auth_flow_missing: "The Google sign-in expired. Try again",
  auth_invalid_callback: "The browser sent a sign-in answer Omamail could not accept. Try again",
  auth_invalid_profile: "Google accepted the sign-in, but did not return the mailbox address. Try again",
  auth_invalid_response: "Google's answer could not be read. Try again",
  auth_keyring_failed: "Could not save the Google session to the keyring. Please try again",
  auth_listener_failed: "The local sign-in listener stopped. Try again",
  auth_missing_scope: "Google sign-in is missing permissions. Sign in again and leave every checkbox ticked",
  auth_offline_access_missing:
    "Google did not return a lasting session. Remove Omamail's access in your Google Account, then sign in again",
  auth_redirect_refused: "Google's sign-in service redirected the request unexpectedly. Try again",
  auth_response_too_large: "Google's answer was larger than Omamail accepts. Try again",
  auth_timeout: "Google sign-in did not finish in time. Check your internet connection and try again. " + PROXY_NOTE,
  auth_transport_failed: "Could not reach Google's sign-in service. Check your internet connection. " + PROXY_NOTE,
  gmail_forbidden:
    "Google refused this app's access to your mailbox. Allow the app in your account or Workspace admin settings, then sign in again",
  gmail_http_failed: "Google accepted the sign-in, but Gmail could not be reached. Check your internet connection. " + PROXY_NOTE,
  gmail_invalid_response: "Gmail's answer could not be read. Try again",
  gmail_length_required: "Gmail rejected the request format. Try again",
  gmail_rate_limited: "Google is limiting requests for this account. Wait a moment, then sign in again",
  gmail_response_too_large: "Gmail's answer was larger than Omamail accepts. Try again",
  gmail_timeout:
    "Google accepted the sign-in, but Gmail did not answer in time. Check your internet connection and try again. " +
    PROXY_NOTE,
  gmail_unauthorized: "Google accepted the sign-in, but refused the Gmail request. Sign in again",
};

export const SIGN_IN_GENERIC = "Google sign-in failed. Please try again";

export function signInErrorMessage(error: unknown): string {
  const code =
    error === undefined || error === null ? "" : String(typeof error === "object" ? (error as any).message : error);
  return Object.prototype.hasOwnProperty.call(SIGN_IN_SENTENCES, code) ? SIGN_IN_SENTENCES[code] : SIGN_IN_GENERIC;
}

export function missingScopes(granted: unknown, required: string[] = SCOPES): string[] {
  const have = String(granted || "").split(/\s+/);
  return required.filter((scope) => have.indexOf(scope) < 0);
}

export function missingScopeMessage(missing: string[]): string {
  if (!Array.isArray(missing) || missing.length === 0) return "";
  const names = missing.map((scope) => scope.substring(scope.lastIndexOf("/") + 1));
  return (
    "Google sign-in finished without the " +
    names.join(" and ") +
    " permission. Sign in again and leave every checkbox ticked"
  );
}

// ------------------------------------------------------------- the client

export interface Client {
  clientId: string;
  clientSecret: string;
  projectId: string;
}

const CLIENT_ID_PATTERN = /^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$/;

function trimmed(value: unknown): string {
  return String(value === undefined || value === null ? "" : value).trim();
}

export function emptyClient(): Client {
  return { clientId: "", clientSecret: "", projectId: "" };
}

export function isValidClientId(value: unknown): boolean {
  return CLIENT_ID_PATTERN.test(String(value || "").trim());
}

export function isConfigured(client: Client | null | undefined): boolean {
  return !!client && isValidClientId(client.clientId);
}

/** The client the backend ships (auth.builtinClient), checked like a typed one. */
export function builtin(shipped: unknown): Client {
  const value: any = shipped && typeof shipped === "object" ? shipped : {};
  const rawId = String(value.clientId ?? "");
  const rawSecret = String(value.clientSecret ?? "");
  if (/[\u0000-\u001f\u007f]/.test(rawId + rawSecret)) return emptyClient();
  const clientId = trimmed(rawId);
  if (!isValidClientId(clientId)) return emptyClient();
  return { clientId, clientSecret: trimmed(rawSecret), projectId: "" };
}

type Parsed = { ok: true; error: ""; client: Client } | { ok: false; error: string; client: Client };

function fromObject(raw: any): Parsed {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Not a credentials file", client: emptyClient() };
  let kind = "";
  let body = raw;
  if (raw.installed && typeof raw.installed === "object") {
    kind = "installed";
    body = raw.installed;
  } else if (raw.web && typeof raw.web === "object") {
    kind = "web";
    body = raw.web;
  }
  const clientId = trimmed(body.client_id || body.clientId);
  const clientSecret = trimmed(body.client_secret || body.clientSecret);
  const projectId = trimmed(body.project_id || body.projectId);
  if (!clientId) return { ok: false, error: "That file has no client ID in it", client: emptyClient() };
  if (!isValidClientId(clientId))
    return { ok: false, error: "That client ID is not a Google OAuth client ID", client: emptyClient() };
  if (kind === "web")
    return {
      ok: false,
      error: "That is a Web application client. Create a Desktop app client instead",
      client: emptyClient(),
    };
  return { ok: true, error: "", client: { clientId, clientSecret, projectId } };
}

function parseJson(text: unknown): any {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

/** What was pasted: the console's JSON, or a client id and an optional secret. */
export function parse(text: unknown): Parsed {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "Paste the client ID, or the JSON file from Google Cloud", client: emptyClient() };
  if (raw.charAt(0) === "{") {
    const json = parseJson(raw);
    if (!json) return { ok: false, error: "That is not valid JSON", client: emptyClient() };
    return fromObject(json);
  }
  let clientId = "";
  let clientSecret = "";
  for (const part of raw.split(/[\s,]+/)) {
    const value = trimmed(part);
    if (!value) continue;
    if (isValidClientId(value)) clientId = value;
    else if (value.indexOf("GOCSPX-") === 0 || (clientId && !clientSecret)) clientSecret = value;
  }
  if (!clientId)
    return { ok: false, error: "No client ID found. It ends in .apps.googleusercontent.com", client: emptyClient() };
  return { ok: true, error: "", client: { clientId, clientSecret, projectId: "" } };
}

interface StoreEntry extends Client {
  id: string;
}

function loadStore(text: unknown): StoreEntry[] {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const json = parseJson(raw);
  if (!json || typeof json !== "object") return [];
  const out: StoreEntry[] = [];
  if (Array.isArray(json.accounts)) {
    for (const entry of json.accounts) {
      if (!entry || typeof entry !== "object") continue;
      const result = fromObject(entry);
      if (!result.ok) continue;
      const id = trimmed(entry.id);
      if (out.some((known) => known.id.toLowerCase() === id.toLowerCase())) continue;
      out.push({ id, ...result.client });
    }
    return out;
  }
  const single = fromObject(json);
  if (single.ok) out.push({ id: "", ...single.client });
  return out;
}

/** The client a mailbox signs in with: its own, else any configured one, else the shipped one. */
export function effective(fileText: unknown, accountId: string, shipped: unknown): Client {
  const store = loadStore(fileText);
  const key = trimmed(accountId).toLowerCase();
  const own =
    store.find((entry) => entry.id.toLowerCase() === key) ?? (store.length === 1 && !store[0].id ? store[0] : null);
  if (own && isConfigured(own)) return { clientId: own.clientId, clientSecret: own.clientSecret, projectId: own.projectId };
  const shared = store.find((entry) => isConfigured(entry));
  if (shared) return { clientId: shared.clientId, clientSecret: shared.clientSecret, projectId: shared.projectId };
  return builtin(shipped);
}

/** Whether no client is configured and the shipped one answers. */
export function usingBuiltin(fileText: unknown, accountId: string, shipped: unknown): boolean {
  const store = loadStore(fileText);
  if (store.some((entry) => isConfigured(entry))) return false;
  void accountId;
  return isConfigured(builtin(shipped));
}

/** The file the console downloads, which the backend reads too: one Desktop app client. */
export function serialize(client: Client): string {
  return JSON.stringify({
    installed: {
      client_id: trimmed(client.clientId),
      project_id: trimmed(client.projectId),
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_secret: trimmed(client.clientSecret),
      redirect_uris: ["http://localhost"],
    },
  });
}

/** "project · 000000" for the done step; "" when there is no client. */
export function describe(client: Client): string {
  if (!isConfigured(client)) return "";
  const id = trimmed(client.clientId);
  const dash = id.indexOf("-");
  const head = id.substring(0, dash < 0 ? 8 : dash);
  const project = trimmed(client.projectId);
  return project ? project + " · " + head : head;
}

/** auth.poll's token answer: whether it carries every required scope. */
export function grantProblem(body: unknown): string {
  const payload = parseJson(body);
  if (!payload || !payload.access_token) return "Could not complete Google sign-in. Please try again";
  const missing = missingScopes(String(payload.scope || ""));
  return missing.length > 0 ? missingScopeMessage(missing) : "";
}
