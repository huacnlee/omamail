// The sign-in flows of each provider, as the Qt client ran them
// (providers/AuthManager.qml, ImapAuth.qml, JmapAuth.qml, OutlookAuth.qml,
// M365Auth.qml, HeyAuth.qml), against the same backend methods with the same
// params. The pages own the form; these own the round trips.
//
// Security: a secret typed into a form goes to the backend once to be
// verified and once to the keyring (credentials.put / auth.store) and is
// dropped. Nothing here logs, stores in Storage or puts a secret in a URL;
// every error a server could have written passes the provider's redact or
// is replaced by a fixed sentence.
import { openUrl } from "nsh";
import { Backend } from "omamail-native";
import { BackendError, call } from "../../backend/client";
import type { Account } from "../../mail/accounts";
import * as Google from "../../mail/providers/google";
import * as Imap from "../../mail/providers/imap";
import * as Jmap from "../../mail/providers/jmap";
import { forgetM365Check, verifyM365Account } from "../../mail/providers/m365-check";
import * as M365 from "../../mail/providers/m365";
import * as Microsoft from "../../mail/providers/microsoft";

export function codeOf(error: unknown): string {
  return error instanceof BackendError ? error.message : error instanceof Error ? error.message : String(error ?? "");
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A flow the page can stop: its loop checks `stopped` after every await. */
export class Abort {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

let previewing = false;

/**
 * Fixtures only: no browser is opened and the Google client file is neither
 * read nor written, so a screenshot run on a real platform touches nothing
 * of this machine's.
 */
export function previewMode(): void {
  previewing = true;
}

/** Opens `url` in the system browser; false when nothing opened it. */
export async function openExternal(url: string): Promise<boolean> {
  if (previewing || !/^https:\/\//i.test(url)) return false;
  try {
    return (await openUrl(url)).opened;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- credentials

type CredentialKind = "imap-password" | "jmap-secret" | "google-refresh-token" | "outlook-refresh-token";

function credentialFields(kind: CredentialKind, accountId: string, clientId?: string) {
  const fields: Record<string, string> = { kind, accountId };
  if (clientId) fields.clientId = clientId;
  return fields;
}

export async function credentialPresent(kind: CredentialKind, accountId: string, clientId?: string): Promise<boolean> {
  const result = await call<{ found?: boolean }>("credentials.get", credentialFields(kind, accountId, clientId));
  return !!result && result.found === true;
}

/** The saved secret, only to re-verify it in place (JMAP's Save changes); "" when there is none. */
export async function readCredential(kind: CredentialKind, accountId: string): Promise<string> {
  try {
    const result = await call<{ found?: boolean; secret?: string }>("credentials.get", credentialFields(kind, accountId));
    return result && result.found === true ? String(result.secret ?? "") : "";
  } catch {
    return "";
  }
}

export async function storeCredential(kind: CredentialKind, accountId: string, secret: string, clientId?: string): Promise<boolean> {
  try {
    const result = await call<{ stored?: boolean }>("credentials.put", { ...credentialFields(kind, accountId, clientId), secret });
    return !!result && result.stored === true;
  } catch {
    return false;
  }
}

export async function deleteCredential(kind: CredentialKind, accountId: string, clientId?: string): Promise<boolean> {
  try {
    await call("credentials.delete", credentialFields(kind, accountId, clientId));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the Google client

/** The owner-only credentials.json, or "" when there is none (or no native config). */
export function readClientFile(): string {
  if (previewing) return "";
  try {
    return String(Backend.readConfig("credentials.json") ?? "");
  } catch {
    return "";
  }
}

/** Writes the client owner-only; never anywhere world-readable. */
export function writeClientFile(text: string): boolean {
  if (previewing) return false;
  try {
    Backend.writeConfig("credentials.json", text);
    return true;
  } catch {
    return false;
  }
}

let shipped: Promise<Google.Client> | null = null;

/** The client a release backend ships (auth.builtinClient, API 9); empty when it has none. */
export function builtinClient(): Promise<Google.Client> {
  if (!shipped) {
    shipped = call("auth.builtinClient", {})
      .then((result) => Google.builtin(result))
      .catch(() => Google.emptyClient());
  }
  return shipped;
}

export async function googleClient(accountId: string): Promise<{ client: Google.Client; builtin: boolean }> {
  const text = readClientFile();
  const fallback = await builtinClient();
  return { client: Google.effective(text, accountId, fallback), builtin: Google.usingBuiltin(text, accountId, fallback) };
}

// ---------------------------------------------------------------- Gmail

export interface GmailResult {
  ok: boolean;
  error: string;
  email: string;
  /** Held only until the mailbox is named by its address: never written under a name-less key. */
  refreshToken: string;
}

/** Writes the grant under the mailbox the profile named, bound to its client. */
export async function gmailStoreGrant(accountId: string, clientId: string, refreshToken: string): Promise<string> {
  if (!refreshToken) return "";
  return (await storeCredential("google-refresh-token", accountId, refreshToken, clientId))
    ? ""
    : "Signed in, but the session could not be saved. You may need to sign in again after a restart";
}

/** auth.begin, the browser, auth.poll every 500 ms; 180 s at most. The backend keeps the refresh token. */
export async function gmailSignIn(
  client: Google.Client,
  port: number,
  loginHint: string,
  abort: Abort,
): Promise<GmailResult> {
  if (!Google.isConfigured(client)) return { ok: false, error: "Connect a Google Cloud OAuth client first", email: "", refreshToken: "" };
  const normalized = Google.normalizedPort(port);
  let flow = "";
  try {
    const begun = await call<{ id?: string; url?: string }>("auth.begin", {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      port: normalized,
      scopes: Google.SCOPES.concat(Google.OPTIONAL_SCOPES),
      loginHint,
    });
    flow = String(begun?.id ?? "");
    if (abort.stopped) {
      if (flow) void call("auth.cancel", { id: flow }).catch(() => {});
      return { ok: false, error: "", email: "", refreshToken: "" };
    }
    if (!flow || !begun?.url) return { ok: false, error: "Could not start secure Google sign-in", email: "", refreshToken: "" };
    // Google's own page only: the backend built it, and nothing else is opened.
    if (!/^https:\/\/accounts\.google\.com\//.test(String(begun.url))) {
      void call("auth.cancel", { id: flow }).catch(() => {});
      return { ok: false, error: "Could not start secure Google sign-in", email: "", refreshToken: "" };
    }
    void openExternal(String(begun.url));
  } catch (error) {
    return {
      ok: false,
      error:
        codeOf(error) === "auth_port_unavailable"
          ? "Could not listen on port " + normalized + ". Close the other listener or change the port in settings"
          : "Could not start secure Google sign-in",
      email: "",
      refreshToken: "",
    };
  }
  const deadline = Date.now() + 180000;
  for (;;) {
    await wait(500);
    if (abort.stopped) {
      void call("auth.cancel", { id: flow }).catch(() => {});
      return { ok: false, error: "", email: "", refreshToken: "" };
    }
    if (Date.now() > deadline) {
      void call("auth.cancel", { id: flow }).catch(() => {});
      return { ok: false, error: "Google sign-in took too long. Please try again", email: "", refreshToken: "" };
    }
    let result: any;
    try {
      result = await call("auth.poll", { id: flow });
    } catch (error) {
      void call("auth.cancel", { id: flow }).catch(() => {});
      return { ok: false, error: Google.signInErrorMessage(codeOf(error)), email: "", refreshToken: "" };
    }
    if (abort.stopped) return { ok: false, error: "", email: "", refreshToken: "" };
    if (result && result.pending) continue;
    const status = Number(result?.status) || 0;
    if (status < 200 || status >= 300) return { ok: false, error: Google.SIGN_IN_GENERIC, email: "", refreshToken: "" };
    const problem = Google.grantProblem(result?.body);
    if (problem) return { ok: false, error: Google.redact(problem), email: "", refreshToken: "" };
    const email = String(result?.profile?.emailAddress ?? "").trim();
    if (!email) return { ok: false, error: Google.SIGN_IN_SENTENCES.auth_invalid_profile, email: "", refreshToken: "" };
    return { ok: true, error: "", email, refreshToken: refreshTokenOf(result?.body) };
  }
}

function refreshTokenOf(body: unknown): string {
  try {
    const payload = typeof body === "string" ? JSON.parse(body) : body;
    return payload && typeof payload.refresh_token === "string" ? payload.refresh_token : "";
  } catch {
    return "";
  }
}

export async function gmailSignedIn(accountId: string): Promise<"signedIn" | "signedOut" | "unknown"> {
  try {
    await call("auth.token", { provider: "gmail", accountId, resource: "mail" });
    return "signedIn";
  } catch (error) {
    const code = codeOf(error);
    return code === "gmail_signed_out" || code === "credential_missing" ? "signedOut" : "unknown";
  }
}

export async function gmailSignOut(accountId: string, clientId: string): Promise<boolean> {
  return deleteCredential("google-refresh-token", accountId, clientId);
}

// ---------------------------------------------------------------- IMAP

let requestSerial = 0;

/** Verifies the settings and the credential by reading the folders (imap.folders), as the Qt client did. */
export async function imapVerify(settings: Imap.Settings, credential: string, oauth: boolean): Promise<string> {
  try {
    await call("imap.folders", {
      refresh: true,
      requestToken: "setup:" + String(++requestSerial),
      settings,
      credential,
      oauth,
    });
    return "";
  } catch (error) {
    return Imap.backendError(codeOf(error));
  }
}

export async function imapSignIn(accountId: string, settings: Imap.Settings, password: string): Promise<string> {
  const checked = Imap.checkedPassword(password);
  if (!checked.ok) return checked.error;
  const valid = Imap.validateSettings(settings);
  if (!valid.ok) return valid.error;
  const error = await imapVerify(valid.settings, valid.settings.username + ":" + checked.value, false);
  if (error) return error;
  if (!(await storeCredential("imap-password", accountId, checked.value)))
    return "The password could not be saved in the system keyring. Unlock it, then try again";
  return "";
}

// ---------------------------------------------------------------- JMAP

export interface JmapVerified {
  error: string;
  needsServer: boolean;
  rejected: boolean;
  result: any;
}

export async function jmapVerify(settings: object, address: string, secret: string): Promise<JmapVerified> {
  try {
    const result = await call("jmap.verify", {
      requestId: "jmap-verify-" + Date.now() + "-" + String(++requestSerial),
      settings,
      address,
      secret,
    });
    if (!result) return { error: "Could not verify this JMAP mailbox", needsServer: false, rejected: false, result: null };
    return { error: "", needsServer: false, rejected: false, result };
  } catch (error) {
    const verdict = Jmap.verifyError(codeOf(error));
    return { error: verdict.message, needsServer: verdict.needsServer, rejected: verdict.rejected, result: null };
  }
}

// ---------------------------------------------------------------- Outlook

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
}

export interface OutlookResult {
  ok: boolean;
  error: string;
  /** Signed in for mail, but Graph (sending, the calendar) was not allowed: the sentence, and Allow Microsoft Graph... is offered. */
  graphError?: string;
}

type Form = (endpoint: "device" | "token", body: string) => Promise<{ status: number; body: string }>;

function outlookForm(tenant: string): Form {
  return (endpoint, body) =>
    call<{ status?: number; body?: string }>("auth.form", { provider: "outlook", endpoint, tenant, body })
      .then((r) => ({ status: Number(r?.status) || 0, body: String(r?.body ?? "") }))
      .catch(() => ({ status: 0, body: "" }));
}

type Granted = Extract<Microsoft.TokenResult, { ok: true }>;

/** One device code: shown, opened on Microsoft's page, polled until answered, expired or cancelled. */
async function deviceFlow(
  form: Form,
  clientId: string,
  scopes: string[],
  onCode: (code: DeviceCode | null) => void,
  abort: Abort,
): Promise<{ token: Granted | null; error: string }> {
  const device = await form("device", Microsoft.deviceAuthorizationBody(clientId, scopes));
  if (abort.stopped) return { token: null, error: "" };
  const started = Microsoft.parseDeviceResponse(device.status, device.body);
  if (!started.ok) return { token: null, error: started.error };
  onCode({ userCode: started.userCode, verificationUri: started.verificationUri });
  void openExternal(started.verificationUri);
  const expires = Date.now() + started.expiresIn * 1000;
  let interval = started.interval * 1000;
  for (;;) {
    await wait(interval);
    if (abort.stopped) return { token: null, error: "" };
    if (Date.now() >= expires) return { token: null, error: "The Microsoft sign-in code expired. Please try again" };
    const answer = await form("token", Microsoft.deviceTokenBody(clientId, started.deviceCode));
    if (abort.stopped) return { token: null, error: "" };
    const result = Microsoft.parseTokenResponse(answer.status, answer.body, "");
    if (result.pending) {
      if (result.slowDown) interval += 5000;
      continue;
    }
    onCode(null);
    if (!result.ok) return { token: null, error: result.error };
    return { token: result, error: "" };
  }
}

async function storeGrant(accountId: string, clientId: string, refreshToken: string): Promise<boolean> {
  try {
    const stored = await call<{ saved?: boolean }>("auth.store", { accountId, clientId, token: refreshToken });
    return !!stored && stored.saved === true;
  } catch {
    return false;
  }
}

/** The account the mail sign-in was made as (tenant/object), held for the Graph code to be checked against. */
const mailKeys = new Map<string, string>();

/**
 * The device-code sign-in: a code from Microsoft, the browser opened on
 * Microsoft's page, the token polled, IMAP verified with it, the grant
 * stored (auth.store). A tenant that sends through Graph is then checked
 * for Graph's consent, and a second code collects it where it is missing.
 */
export async function outlookSignIn(
  account: { accountId: string; clientId: string; tenant: string; settings: Imap.Settings; email?: string },
  onCode: (code: DeviceCode | null, purpose?: "mail" | "graph") => void,
  onStage: (text: string) => void,
  abort: Abort,
): Promise<OutlookResult> {
  const tenant = Microsoft.normalizeTenant(account.tenant);
  const clientId = Microsoft.effectiveClientId(account.clientId);
  if (!clientId) return { ok: false, error: "Add the mailbox address and Microsoft OAuth client ID first" };
  const form = outlookForm(tenant);
  const { token, error } = await deviceFlow(form, clientId, Microsoft.SCOPES, (code) => onCode(code, "mail"), abort);
  if (!token) return { ok: false, error };
  const missing = Microsoft.missingMailScopes(token.scope);
  if (missing.length > 0) return { ok: false, error: Microsoft.missingScopeMessage(missing) };
  if (!token.refreshToken)
    return { ok: false, error: "Microsoft sign-in did not grant offline access. Check the app registration and sign in again" };
  onStage("Checking the mailbox…");
  const verifyError = await imapVerify(account.settings, token.accessToken, true);
  if (abort.stopped) return { ok: false, error: "" };
  if (verifyError) return { ok: false, error: verifyError || "Outlook rejected this mailbox sign-in" };
  if (!(await storeGrant(account.accountId, clientId, token.refreshToken)))
    return { ok: false, error: "Could not update the saved Microsoft session" };
  mailKeys.set(account.accountId, Microsoft.accountKey(token.idToken));
  if (account.settings.send !== "graph") return { ok: true, error: "" };

  // The sign-in's tail is Graph's from here: cut short, the mail half is in.
  onStage("Checking Microsoft Graph…");
  const probe = await outlookGraphProbe(account.accountId);
  if (abort.stopped || probe === "granted") return { ok: true, error: "" };
  if (probe !== "needed") return { ok: true, error: "", graphError: probe };
  const graph = await outlookGraphSignIn(
    { accountId: account.accountId, clientId, tenant, email: account.email ?? "" },
    (code) => onCode(code, "graph"),
    onStage,
    abort,
  );
  return { ok: true, error: "", graphError: graph };
}

/**
 * Whether the saved grant can be exchanged for a Graph token with Mail.Send:
 * "granted", "needed" (consent is missing: a second code collects it), or the
 * sentence for any other refusal, which is sending's to report.
 */
export async function outlookGraphProbe(accountId: string): Promise<string> {
  try {
    const result = await call<{ scope?: string; access_token?: string }>("auth.token", {
      provider: "outlook",
      accountId,
      resource: "graph",
    });
    return Microsoft.missingGraphScope(result?.scope) ? "needed" : "granted";
  } catch (error) {
    const code = codeOf(error);
    if (code === "auth_consent_required") return "needed";
    if (code === "auth_signed_out") return "Sign in to Outlook first";
    return "Microsoft Graph could not be checked: " + Microsoft.redact(code || "unknown error") + ". Sending will ask again";
  }
}

/**
 * The second code, for Graph: its token must name the mailbox's own account,
 * and carry Mail.Send. Resolves with "" when Graph is allowed, else the
 * sentence; the mail sign-in stands either way.
 */
export async function outlookGraphSignIn(
  account: { accountId: string; clientId: string; tenant: string; email: string },
  onCode: (code: DeviceCode | null) => void,
  onStage: (text: string) => void,
  abort: Abort,
): Promise<string> {
  const clientId = Microsoft.effectiveClientId(account.clientId);
  const form = outlookForm(Microsoft.normalizeTenant(account.tenant));
  onStage("Allowing Microsoft Graph…");
  const { token, error } = await deviceFlow(form, clientId, Microsoft.GRAPH_SIGN_IN_SCOPES, onCode, abort);
  if (abort.stopped) return "";
  if (!token) return Microsoft.graphRefusedMessage(error || "Microsoft sign-in failed");
  // A code entered as someone else would file that someone's token as this mailbox's.
  if (!Microsoft.sameAccount(token.idToken, account.email, mailKeys.get(account.accountId) ?? ""))
    return Microsoft.graphRefusedMessage(Microsoft.otherAccountMessage(Microsoft.signedInAs(token.idToken), account.email));
  // The refresh token is the same user's and client's, and exchangeable for either resource: it is kept.
  if (token.refreshToken && !(await storeGrant(account.accountId, clientId, token.refreshToken)))
    return "Could not update the saved Microsoft session";
  if (Microsoft.missingGraphScope(token.scope)) return Microsoft.graphRefusedMessage(Microsoft.graphScopeMessage());
  return "";
}

export async function outlookSignedIn(accountId: string): Promise<"signedIn" | "signedOut" | "unknown"> {
  try {
    await call("auth.token", { provider: "outlook", accountId, resource: "mail" });
    return "signedIn";
  } catch (error) {
    const code = codeOf(error);
    return code === "auth_signed_out" || code === "credential_missing" ? "signedOut" : "unknown";
  }
}

export async function outlookSignOut(accountId: string, clientId: string): Promise<boolean> {
  try {
    await call("auth.invalidate", { accountId });
  } catch {
    // The memory session may already be gone; the saved grant is what matters.
  }
  try {
    const result = await call<{ cleared?: boolean }>("auth.clear", {
      accountId,
      clientId: Microsoft.effectiveClientId(clientId),
    });
    return !!result && result.cleared === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Microsoft 365

export async function m365SignIn(
  account: { accountId: string; address: string; clientId: string },
  onCode: (code: DeviceCode | null) => void,
  onStage: (text: string) => void,
  abort: Abort,
): Promise<OutlookResult> {
  onStage("Asking Microsoft for a code");
  let begin: M365.Begin | null = null;
  try {
    begin = M365.beginResult(
      await call("m365.signInBegin", {
        accountId: account.accountId,
        address: account.address,
        clientId: M365.clientId(account.clientId),
      }),
    );
  } catch (error) {
    return { ok: false, error: M365.failureSentence(M365.errorCode(codeOf(error)), "", account.address) };
  }
  if (!begin) return { ok: false, error: M365.sentence("m365_invalid_response") };
  const requestId = begin.requestId;
  if (abort.stopped) {
    void m365SignOut(account.accountId, account.clientId);
    return { ok: false, error: "" };
  }
  onCode({ userCode: begin.userCode, verificationUri: begin.verificationUri });
  onStage("Waiting for you to finish on the Microsoft page");
  void openExternal(begin.verificationUri);
  for (;;) {
    await wait(begin.interval * 1000);
    let result: unknown = null;
    let failure: unknown = null;
    try {
      result = await call("m365.signInPoll", { requestId });
    } catch (error) {
      failure = codeOf(error);
    }
    if (abort.stopped) {
      // A poll no longer wanted may still have saved a grant: it is signed out.
      if (M365.pollMayHaveSaved(result, failure)) void m365SignOut(account.accountId, account.clientId);
      return { ok: false, error: "" };
    }
    if (failure) return { ok: false, error: M365.sentence(failure) };
    const poll = M365.pollResult(result);
    if (poll.state === "pending") continue;
    if (poll.state !== "signedIn") {
      onCode(null);
      return { ok: false, error: M365.failureSentence(poll.code, poll.who, account.address) };
    }
    break;
  }
  onCode(null);
  onStage("Signed in on Microsoft's side. Checking the mailbox");
  try {
    if (!M365.verified(await verifyM365Account(account.accountId)))
      return { ok: false, error: M365.sentence("m365_invalid_response") };
  } catch (error) {
    return { ok: false, error: M365.sentence(codeOf(error)) };
  }
  return { ok: true, error: "" };
}

export async function m365SignedIn(accountId: string): Promise<"signedIn" | "signedOut" | "unknown"> {
  try {
    return M365.verified(await verifyM365Account(accountId)) ? "signedIn" : "unknown";
  } catch (error) {
    return M365.isNothingSaved(codeOf(error)) ? "signedOut" : "unknown";
  }
}

/** "" when the saved sign-in is gone, else the sentence for why not. */
export async function m365SignOut(accountId: string, clientId: string): Promise<string> {
  const client = M365.clientId(clientId);
  forgetM365Check(accountId);
  if (!client) return "";
  try {
    await call("m365.signOut", { accountId, clientId: client });
    return "";
  } catch (error) {
    return M365.signOutFailure(codeOf(error));
  }
}

// ---------------------------------------------------------------- HEY

const HEY_ERROR = "HEY could not complete this request";

export async function heyProgram(): Promise<string> {
  try {
    const result = await call<{ program?: string }>("hey.probe", {});
    return String(result?.program ?? "");
  } catch {
    return "";
  }
}

export async function heySignedIn(): Promise<boolean> {
  try {
    const result = await call<{ authenticated?: boolean }>("hey.status", {});
    return !!result && result.authenticated === true;
  } catch {
    return false;
  }
}

export async function heySignIn(abort: Abort): Promise<string> {
  try {
    await call("hey.loginStart", {});
  } catch {
    return HEY_ERROR;
  }
  for (;;) {
    await wait(500);
    if (abort.stopped) {
      void call("hey.loginCancel", {}).catch(() => {});
      return "";
    }
    try {
      const result = await call<{ running?: boolean }>("hey.loginPoll", {});
      if (!result || !result.running) return "";
    } catch {
      return HEY_ERROR;
    }
  }
}

export async function heyProfileEmail(): Promise<string> {
  try {
    const result = await call<{ email?: string }>("hey.profile", {});
    return String(result?.email ?? "").trim();
  } catch {
    return "";
  }
}

export async function heySignOut(): Promise<string> {
  void call("hey.loginCancel", {}).catch(() => {});
  try {
    await call("hey.logout", {});
    return "";
  } catch {
    return HEY_ERROR;
  }
}

// ---------------------------------------------------------------- any provider

/** Whether a saved mailbox can sign in from what is stored. */
export async function signedIn(account: Account): Promise<"signedIn" | "signedOut" | "unknown"> {
  if (!account.id) return "signedOut";
  try {
    switch (account.provider) {
      case "gmail":
        return await gmailSignedIn(account.id);
      case "outlook":
        return await outlookSignedIn(account.id);
      case "m365":
        return await m365SignedIn(account.id);
      case "hey":
        return (await heySignedIn()) ? "signedIn" : "signedOut";
      case "imap":
        return (await credentialPresent("imap-password", account.id)) ? "signedIn" : "signedOut";
      case "jmap":
        return (await credentialPresent("jmap-secret", account.id)) ? "signedIn" : "signedOut";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

/** Signs a mailbox out: its saved credential goes. "" on success. */
export async function signOut(account: Account): Promise<string> {
  switch (account.provider) {
    case "gmail": {
      const { client } = await googleClient(account.id);
      return (await gmailSignOut(account.id, account.clientId || client.clientId))
        ? ""
        : "The saved Google session could not be removed";
    }
    case "outlook":
      return (await outlookSignOut(account.id, account.clientId)) ? "" : "Could not update the saved Microsoft session";
    case "m365":
      return m365SignOut(account.id, account.clientId);
    case "hey":
      return heySignOut();
    case "imap":
      return (await deleteCredential("imap-password", account.id)) ? "" : "The saved password could not be removed";
    case "jmap":
      return (await deleteCredential("jmap-secret", account.id)) ? "" : "The saved app password could not be removed";
  }
  return "";
}

/** What must go before the row may: only Microsoft 365 holds a grant the backend keeps per client. */
export async function forgetBeforeRemoval(account: Account): Promise<string> {
  if (account.provider !== "m365") return "";
  const problem = await m365SignOut(account.id, account.clientId);
  return problem ? "The mailbox was not removed. " + problem : "";
}
