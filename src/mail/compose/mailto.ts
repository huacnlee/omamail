// A mailto: URL is a draft, not a page. Port of omarchy/ui/message/Mailto.js.
//
// RFC 6068: `mailto:` [ to ] [ "?" hfields ]. Headers in the query are not
// trusted: a subject holding a newline is how a stranger writes a Bcc of
// their own, so those values lose their line breaks before they reach a
// field. The body is allowed them; that is what a body is. Nothing here sends.

export interface MailtoDraft {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
}

function percentDecode(value: string): string {
  const text = String(value ?? "").replace(/\+/g, " ");
  try {
    return decodeURIComponent(text);
  } catch {
    // A stray percent that is not an escape: the raw text is closer to what
    // the sender meant than nothing is.
    return text;
  }
}

export function headerSafe(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

function bodyText(value: string): string {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function appendAddresses(list: string[], value: string) {
  for (const part of String(value ?? "").split(",")) {
    const address = part.trim();
    if (address !== "") list.push(address);
  }
}

export function emptyDraft(): MailtoDraft {
  return { to: "", cc: "", bcc: "", subject: "", body: "" };
}

/** The longest link read, in characters: a link is outside input. */
export const MAX_LENGTH = 32 * 1024;

export function parse(entry: unknown): MailtoDraft | null {
  const text = String(entry ?? "").trim();
  if (text.length > MAX_LENGTH) return null;
  if (!/^mailto:/i.test(text)) return null;
  let rest = text.substring(7);
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.substring(0, hash);
  const mark = rest.indexOf("?");
  const to: string[] = [];
  const cc: string[] = [];
  const bcc: string[] = [];
  let subject = "";
  let body = "";
  appendAddresses(to, headerSafe(percentDecode(mark < 0 ? rest : rest.substring(0, mark))));
  if (mark >= 0) {
    for (const pair of rest.substring(mark + 1).split("&")) {
      const equals = pair.indexOf("=");
      if (equals < 0) continue;
      const key = pair.substring(0, equals).toLowerCase();
      const raw = percentDecode(pair.substring(equals + 1));
      if (key === "to") appendAddresses(to, headerSafe(raw));
      else if (key === "cc") appendAddresses(cc, headerSafe(raw));
      else if (key === "bcc") appendAddresses(bcc, headerSafe(raw));
      else if (key === "subject") subject = headerSafe(raw);
      else if (key === "body") body = bodyText(raw);
    }
  }
  return { to: to.join(", "), cc: cc.join(", "), bcc: bcc.join(", "), subject, body };
}

/** What an open request puts in compose; null leaves the window alone. */
export function draftFromPayload(payload: unknown): MailtoDraft | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as { mailto?: unknown; compose?: unknown };
  if (value.mailto) return parse(value.mailto);
  if (value.compose === true) return emptyDraft();
  return null;
}
