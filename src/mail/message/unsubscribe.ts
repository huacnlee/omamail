// Getting off a mailing list, out of the headers the list already sends.
// Port of omarchy/ui/message/Unsubscribe.js.
//
// `List-Unsubscribe` has been in every newsletter since RFC 2369, and RFC 8058
// added the one line that makes a single click enough: a sender that also sends
// `List-Unsubscribe-Post` has promised that one POST removes the address, with
// no page to visit and no form to fill in.
//
// Everything here decides; nothing here fetches. Which URL may be posted to is
// the one question worth being careful about, and it is answered in one place.
import { imageSourceKind } from "./html";

/** A header long enough to be an attack rather than a list. Real ones are two entries. */
export const MAX_HEADER_LENGTH = 2048;
export const MAX_ENTRIES = 8;

export interface UnsubscribeMail {
  to: string;
  subject: string;
  body: string;
}

export interface UnsubscribeInfo {
  available: boolean;
  oneClick: boolean;
  url: string;
  postUrl: string;
  mail: UnsubscribeMail | null;
}

export type UnsubscribePlan = "post" | "mail" | "browser" | "";

// Entries are bracketed rather than separated, because a mailto's query string
// legitimately holds the comma the RFC also uses as the separator.
export function entries(value: unknown): string[] {
  const text = String(value ?? "");
  if (text.length > MAX_HEADER_LENGTH) return [];
  const found: string[] = [];
  let open = -1;
  for (let i = 0; i < text.length && found.length < MAX_ENTRIES; i++) {
    const character = text.charAt(i);
    if (character === "<") {
      open = i;
      continue;
    }
    if (character !== ">" || open < 0) continue;
    const raw = text.substring(open + 1, i);
    const entry = /[\u0000-\u001f\u007f]/.test(raw) ? "" : raw.trim();
    if (entry !== "") found.push(entry);
    open = -1;
  }
  return found;
}

function percentDecode(value: string): string {
  const text = String(value ?? "").replace(/\+/g, " ");
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// Anything that could start a header of its own is removed rather than escaped.
function headerSafe(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

export function parseMailto(entry: unknown): UnsubscribeMail | null {
  const text = String(entry ?? "");
  if (!/^mailto:/i.test(text)) return null;
  const rest = text.substring(7);
  const mark = rest.indexOf("?");
  // One recipient: the first is the one that unambiguously belongs to this list.
  const to = headerSafe(percentDecode(mark < 0 ? rest : rest.substring(0, mark))).split(",")[0].trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return null;
  let subject = "";
  let body = "";
  if (mark >= 0) {
    for (const pair of rest.substring(mark + 1).split("&")) {
      const equals = pair.indexOf("=");
      if (equals < 0) continue;
      const key = pair.substring(0, equals).toLowerCase();
      const raw = percentDecode(pair.substring(equals + 1));
      if (key === "subject") subject = headerSafe(raw);
      else if (key === "body") body = String(raw);
    }
  }
  // `send` refuses an empty body, and an empty subject reads as a mistake.
  return { to, subject: subject !== "" ? subject : "Unsubscribe", body: body !== "" ? body : "Unsubscribe" };
}

/** Where the sender's address points: only http(s) at a host on the public internet. */
export function isPublicWebUrl(value: unknown): boolean {
  if (/[\u0000-\u001f\u007f]/.test(String(value ?? ""))) return false;
  const text = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(text)) return false;
  return imageSourceKind(text) === "remote";
}

/** A one-click POST is https only (RFC 8058): the request says this address reads this mail. */
export function isPostableUrl(value: unknown): boolean {
  return /^https:\/\//i.test(String(value ?? "").trim()) && isPublicWebUrl(value);
}

export function empty(): UnsubscribeInfo {
  return { available: false, oneClick: false, url: "", postUrl: "", mail: null };
}

/** What this message offers, out of its own two headers. */
export function from(listHeader: unknown, postHeader: unknown): UnsubscribeInfo {
  const result = empty();
  const list = entries(listHeader);
  if (list.length === 0) return result;
  for (const entry of list) {
    if (/^mailto:/i.test(entry)) {
      if (!result.mail) result.mail = parseMailto(entry);
      continue;
    }
    if (result.url === "" && isPublicWebUrl(entry)) result.url = entry;
  }
  const oneClick = /List-Unsubscribe\s*=\s*One-Click/i.test(String(postHeader ?? ""));
  if (oneClick && isPostableUrl(result.url)) {
    result.oneClick = true;
    result.postUrl = result.url;
  }
  result.available = result.oneClick || !!result.mail || result.url !== "";
  return result;
}

interface HeaderLike {
  name?: unknown;
  value?: unknown;
}

export function fromHeaders(headers: unknown): UnsubscribeInfo {
  const list = Array.isArray(headers) ? (headers as HeaderLike[]) : [];
  let listHeader = "";
  let postHeader = "";
  for (const header of list) {
    const name = String(header?.name ?? "").toLowerCase();
    if (name === "list-unsubscribe" && listHeader === "") listHeader = String(header.value ?? "");
    else if (name === "list-unsubscribe-post" && postHeader === "") postHeader = String(header.value ?? "");
  }
  return from(listHeader, postHeader);
}

/** The Gmail message resource shape, which is what every provider hands back. */
export function fromMessage(message: unknown): UnsubscribeInfo {
  const m = message as { payload?: { headers?: unknown }; headers?: unknown } | null | undefined;
  const headers = m && m.payload && Array.isArray(m.payload.headers)
    ? m.payload.headers
    : m && Array.isArray(m.headers) ? m.headers : [];
  return fromHeaders(headers);
}

/**
 * How the button behaves, in order of how little the user has to do: a
 * declared one-click POST, a mail to the list on an account that can send,
 * then the sender's page in a browser.
 */
export function plan(info: UnsubscribeInfo | null | undefined, canSend: boolean): UnsubscribePlan {
  const found = info ?? empty();
  if (found.oneClick && found.postUrl !== "") return "post";
  if (found.mail && canSend === true) return "mail";
  if (found.url !== "") return "browser";
  if (found.mail) return "mail";
  return "";
}

/** A page is the only way that leaves the window, and the label says so. */
export function label(info: UnsubscribeInfo | null | undefined, canSend: boolean): string {
  const how = plan(info, canSend);
  if (how === "") return "";
  return how === "browser" ? "Unsubscribe..." : "Unsubscribe";
}

/** The sentence beside the button: what pressing it does. */
export function explanation(info: UnsubscribeInfo | null | undefined, canSend: boolean): string {
  const how = plan(info, canSend);
  if (how === "post") return "This sender accepts a one-click unsubscribe";
  if (how === "mail") return "Unsubscribing sends a message to this list";
  if (how === "browser") return "Unsubscribing opens this sender's page in a browser";
  return "";
}

export function postBody(): string {
  return "List-Unsubscribe=One-Click";
}

export function postContentType(): string {
  return "application/x-www-form-urlencoded";
}
