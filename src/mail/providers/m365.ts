// Microsoft 365 over Graph: the device-code sign-in Rust holds
// (m365.signInBegin / signInPoll / signOut / verify) and the sentences for
// what it reports. Port of providers/M365Protocol.js's sign-in half. Tokens
// never reach the UI; these functions only read the backend's answers, which
// are still checked as untrusted (codes, links and names are bounded).
import * as Microsoft from "./microsoft";

export const MIN_API_VERSION = 8;
export const ENTRA_APPS_URL = Microsoft.ENTRA_APPS_URL;

/** A client id as stored on the account: a GUID, lower-cased; "" otherwise. */
export function clientId(value: unknown): string {
  return Microsoft.isValidClientId(value) ? String(value).trim().toLowerCase() : "";
}

function trimmed(value: unknown): string {
  return String(value === undefined || value === null ? "" : value).trim();
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One line of untrusted text: invisible and control characters become spaces, at most `limit`. */
export function lineText(value: unknown, limit: number): string {
  const text = trimmed(
    String(value).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g, " "),
  );
  return text.length > limit ? text.substring(0, limit - 3) + "..." : text;
}

const SIGN_IN_AGAIN = "Sign in to Microsoft 365 again";

export const SENTENCES: Record<string, string> = {
  auth_account_missing: "This mailbox is not set up on this computer",
  auth_keyring_failed: "The system keyring is locked or unavailable. Unlock it: the mailbox's sign-in is kept there",
  backend_needs_update: "Update the mail backend to use this mailbox",
  credential_store_unavailable: "The credential store is unavailable",
  m365_access_denied:
    "Microsoft refused access to this mailbox or message. Ask your administrator if it keeps happening",
  m365_auth_failed:
    "Microsoft refused this sign-in. Check the Application (client) ID and that the app allows public client flows and accounts of your organization, then try again",
  m365_bad_response: "Microsoft's answer was not what Omamail expected. Try again in a moment",
  m365_cancelled: "Cancelled",
  m365_consent_required:
    "Your organization's administrator has to approve this app before it can open the mailbox. Ask them to grant consent for it, then sign in again. If the page named another company, your browser was signed in to a different Microsoft account: try a private window",
  m365_declined: "The sign-in was declined on the Microsoft page. Press Sign in to try again",
  m365_expired: "The code ran out before it was used. Press Sign in for a new one",
  m365_invalid_request: "Omamail could not make that request. Try again",
  m365_invalid_response: "Microsoft's answer was not what Omamail expected. Try again in a moment",
  m365_network_failed: "Microsoft 365 could not be reached. Check your connection",
  m365_request_limit: "Too many requests are waiting. Try again in a moment",
  m365_response_too_large: "Microsoft's answer was larger than Omamail accepts",
  m365_server_error: "Microsoft 365 reported an error while handling the request. Try again in a moment",
  m365_signed_out: SIGN_IN_AGAIN,
  m365_tenant_invalid: "Microsoft could not find an organization for that address. Check the address",
  m365_throttled: "Microsoft asked Omamail to slow down. Try again in a moment",
  m365_timeout: "Microsoft 365 took too long to answer",
  m365_tls_failed: "The secure connection to Microsoft could not be verified",
  m365_wrong_account:
    "The code was entered with a different Microsoft account than this mailbox's. Press Sign in again; if the browser offers the wrong account, open the page in a private window",
  request_timed_out: "Microsoft 365 took too long to answer",
};

const GENERIC = "Microsoft 365 could not complete this request";
const NOT_SAVED = "The sign-in could not be saved in the system keyring. Unlock it, then sign in again";

export function errorCode(error: unknown): string {
  if (error === undefined || error === null) return "";
  return trimmed(typeof error === "object" ? (error as any).message : error);
}

export function sentence(error: unknown): string {
  const code = errorCode(error);
  return Object.prototype.hasOwnProperty.call(SENTENCES, code) ? SENTENCES[code] : GENERIC;
}

const TRANSIENT = [
  "m365_network_failed",
  "m365_timeout",
  "request_timed_out",
  "m365_throttled",
  "m365_server_error",
  "m365_request_limit",
  "m365_bad_response",
  "auth_keyring_failed",
];

export function isTransient(error: unknown): boolean {
  return TRANSIENT.indexOf(errorCode(error)) >= 0;
}

export function isSignedOut(error: unknown): boolean {
  return errorCode(error) === "m365_signed_out";
}

export function isNothingSaved(error: unknown): boolean {
  return isSignedOut(error) || errorCode(error) === "auth_account_missing";
}

const SIGN_OUT_UNFINISHED =
  "Signing out could not be completed while the sign-in was in use, so it may still be " +
  "saved on this computer. Unlock the system keyring if it asks, and sign out again if the mailbox comes back signed in";

export function signOutFailure(error: unknown): string {
  if (errorCode(error) === "m365_timeout") return SIGN_OUT_UNFINISHED;
  return "The saved sign-in could not be removed. " + sentence(error);
}

/** Waits between restore attempts after a transient failure. */
export const RETRY_DELAYS = [5000, 15000, 60000, 300000];

export interface Begin {
  requestId: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}

/** signInBegin's answer, checked: a bounded request id, a plausible code and a Microsoft page; null otherwise. */
export function beginResult(result: unknown): Begin | null {
  const value = isObject(result) ? result : {};
  const requestId = trimmed(value.requestId);
  const code = trimmed(value.userCode);
  const link = Microsoft.verificationUri(value.verificationUri);
  const interval = Math.floor(Number(value.interval));
  if (
    requestId === "" ||
    requestId.length > 256 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(requestId) ||
    !/^[A-Za-z0-9-]{4,32}$/.test(code) ||
    link === ""
  )
    return null;
  return { requestId, userCode: code, verificationUri: link, interval: interval > 0 ? Math.min(30, interval) : 5 };
}

export type PollState = "pending" | "signedIn" | "declined" | "expired" | "failed";

export function pollResult(result: unknown): { state: PollState; code: string; who: string } {
  const value = isObject(result) ? result : {};
  const state = value.state;
  if (state === "pending" || state === "signedIn") return { state, code: "", who: "" };
  if (state === "declined" || state === "expired") return { state, code: "m365_" + state, who: "" };
  if (state !== "failed") return { state: "failed", code: "m365_invalid_response", who: "" };
  const code = errorCode(value.error);
  return {
    state: "failed",
    who: typeof value.signedInAs === "string" ? lineText(value.signedInAs, 80) : "",
    code: Object.prototype.hasOwnProperty.call(SENTENCES, code) ? code : "m365_auth_failed",
  };
}

const LOST = ["request_timed_out", "Backend request timed out", "Backend response timed out", "Backend stopped", "Invalid backend response"];

export function isLostAnswer(error: unknown): boolean {
  return LOST.indexOf(errorCode(error)) >= 0;
}

/** Whether a poll that is no longer wanted may still have saved a grant, which must then be signed out. */
export function pollMayHaveSaved(result: unknown, failure: unknown): boolean {
  if (failure) return isLostAnswer(failure);
  const value = isObject(result) ? result : {};
  return value.state === "signedIn" || (value.state === "pending" && value.warning === "m365_exchange_running");
}

export function failureSentence(code: string, who: string, address: string): string {
  if (code === "auth_keyring_failed") return NOT_SAVED;
  if (code !== "m365_wrong_account" || who === "") return sentence(code);
  return (
    "The code was entered as " +
    who +
    ", not " +
    trimmed(address) +
    ". Press Sign in again; if the browser keeps offering that account, open the page in a private window"
  );
}

export function verified(result: unknown): boolean {
  return isObject(result) && result.ok === true;
}

/** The one-time app setup, in order. */
export const SETUP_STEPS = [
  "In Microsoft Entra, register an app for accounts in your organization's directory. It needs no redirect URI: the sign-in uses a code.",
  "Under Authentication, set Allow public client flows to Yes.",
  "Under API permissions, add the delegated Microsoft Graph permissions Mail.ReadWrite, Mail.Send, Calendars.ReadWrite, openid, profile, email and offline_access.",
  "Copy the Application (client) ID from the app's Overview page into the field above.",
];
