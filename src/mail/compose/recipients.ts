// Recipient text for the compose fields: reply addressing, suggestions from
// the contact book, and how a chosen contact is written into a field. Port of
// omarchy/ui/compose/Recipients.js.
//
// The fields stay comma-separated text because the backend writes that text
// into the To/Cc/Bcc headers; chips are a rendering of it (`tokens`), never a
// second source of truth.

export interface Contact {
  name: string;
  email: string;
}

/** A summary's address as the backend lists it. */
export interface AddressLike {
  name?: unknown;
  email?: unknown;
}

export interface ReplySource {
  from?: AddressLike | null;
  replyTo?: AddressLike | null;
  to?: AddressLike[] | null;
  cc?: AddressLike[] | null;
}

export type ReplyMode = "reply" | "replyAll" | "forward" | "new" | "draft";

// A name in a header that needs quotes. Kept beside the address writer so the
// quoting rule and the field text cannot drift apart (Message.js NAME_SPECIALS).
const NAME_SPECIALS = /[()<>\[\]:;@\\,."]/;

/** Display-name text without control characters (Message.js nameText). */
export function nameText(text: unknown): string {
  return String(text === undefined || text === null ? "" : text)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim();
}

/** A phrase quoted when it holds a special, or always (Message.js quotedPhrase). */
export function quotedPhrase(text: unknown, always = false): string {
  const value = nameText(text);
  if (value === "" || (!always && !NAME_SPECIALS.test(value))) return value;
  return '"' + value.replace(/([\\"])/g, "\\$1") + '"';
}

export function cleanContact(value: unknown): Contact | null {
  const contact = (value && typeof value === "object" ? value : {}) as AddressLike;
  const name = String(contact.name || "").replace(/[\r\n]+/g, " ").trim();
  const email = String(contact.email || "").replace(/[\r\n\s]+/g, "").trim();
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return { name, email };
}

/** Valid contacts, first spelling of each address kept. */
export function normalize(values: unknown): Contact[] {
  const contacts = Array.isArray(values) ? values : [];
  const seen = new Set<string>();
  const out: Contact[] = [];
  for (const value of contacts) {
    const contact = cleanContact(value);
    if (!contact) continue;
    const key = contact.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(contact);
  }
  return out;
}

// A follow-up to our own message addresses its To list, not its author.
// Only the draft owner's identities count as self; another mailbox on a
// merged view can still be a real recipient. Never carry Bcc into a reply.
export function replyFields(
  summary: ReplySource | null | undefined,
  mode: ReplyMode,
  ownAddresses: unknown,
): { to: string; cc: string; outgoing: boolean } {
  const source = summary ?? {};
  const self = new Set(normalize(ownAddresses).map((c) => c.email.toLowerCase()));
  const seen = new Set<string>();
  const to: string[] = [];
  const cc: string[] = [];
  const sender = cleanContact(source.from);
  const outgoing = !!(sender && self.has(sender.email.toLowerCase()));
  const keep = (values: unknown, target: string[]) => {
    for (const contact of normalize(values)) {
      const key = contact.email.toLowerCase();
      if (self.has(key) || seen.has(key)) continue;
      seen.add(key);
      target.push(contact.email);
    }
  };
  if (outgoing) {
    keep(source.to, to);
  } else {
    const replyTo = cleanContact(source.replyTo) ?? sender;
    keep(replyTo ? [replyTo] : [], to);
  }
  if (mode === "replyAll") {
    if (!outgoing) keep(source.to, cc);
    keep(source.cc, cc);
  }
  return { to: to.join(", "), cc: cc.join(", "), outgoing };
}

/** The address being typed: what follows the last separator. */
export function currentToken(text: string): string {
  const value = String(text ?? "");
  return value.substring(Math.max(value.lastIndexOf(","), value.lastIndexOf(";")) + 1).trim();
}

function usedAddresses(text: string): Set<string> {
  const parts = String(text ?? "").split(/[,;]/);
  const used = new Set<string>();
  for (let i = 0; i < parts.length - 1; i++) {
    const angle = parts[i].match(/<([^>]+)>/);
    used.add(String(angle ? angle[1] : parts[i]).trim().toLowerCase());
  }
  return used;
}

function byName(left: Contact, right: Contact): number {
  const a = (left.name || left.email).toLowerCase();
  const b = (right.name || right.email).toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Contacts matching the token being typed, prefix matches first. */
export function suggest(values: unknown, text: string, limit = 5): Contact[] {
  const query = currentToken(text).toLowerCase();
  if (query === "") return [];
  const used = usedAddresses(text);
  const ranked: { contact: Contact; score: number }[] = [];
  for (const contact of normalize(values)) {
    const email = contact.email.toLowerCase();
    const name = contact.name.toLowerCase();
    if (used.has(email) || query === email) continue;
    const emailAt = email.indexOf(query);
    const nameAt = name.indexOf(query);
    if (emailAt < 0 && nameAt < 0) continue;
    ranked.push({ contact, score: emailAt === 0 || nameAt === 0 ? 0 : 1 });
  }
  ranked.sort((l, r) => l.score - r.score || byName(l.contact, r.contact));
  const count = Math.max(1, Math.floor(Number(limit) || 5));
  return ranked.slice(0, count).map((r) => r.contact);
}

// A contact as To text. The name is often a stranger's, harvested from mail
// that arrived, and the backend writes this text into the header, so a name
// holding a special is quoted here or it stops being one name there.
export function address(contact: unknown): string {
  const value = cleanContact(contact);
  if (!value) return "";
  const name = quotedPhrase(value.name, false);
  return name === "" ? value.email : `${name} <${value.email}>`;
}

/** Replaces the token being typed with the chosen contact. */
export function accept(text: string, contact: unknown): string {
  const value = String(text ?? "");
  const split = Math.max(value.lastIndexOf(","), value.lastIndexOf(";"));
  const prefix = split >= 0 ? value.substring(0, split + 1).trim() + " " : "";
  return prefix + address(contact);
}

/** Adds a contact at the end, unless it is already there. */
export function append(text: string, contact: unknown): string {
  const addr = address(contact);
  if (!addr) return String(text ?? "");
  let current = String(text ?? "").trim();
  if (current === "") return addr;
  current = current.replace(/[,;]+$/, "").trim();
  const clean = cleanContact(contact);
  if (clean && usedAddresses(current + ",").has(clean.email.toLowerCase())) return current;
  return current + ", " + addr;
}

/** The contacts picker's list: a substring of name or address, by name. */
export function filter(values: unknown, query: string, limit?: number): Contact[] {
  const q = String(query ?? "").trim().toLowerCase();
  const out = normalize(values).filter(
    (c) => q === "" || c.email.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
  );
  out.sort(byName);
  return typeof limit === "number" && limit > 0 ? out.slice(0, limit) : out;
}

/** One finished entry of a field, as a chip shows it. */
export interface Token {
  /** The text as written ("Jane <jane@example.com>"). */
  text: string;
  /** What the chip says: the name, or the address. */
  label: string;
  email: string;
  /** It does not look like an address: the chip says so. */
  invalid: boolean;
}

/**
 * The finished entries of a field (everything before the last separator),
 * and what is still being typed. A quoted name may hold a comma, so the
 * split respects quotes and angle brackets.
 */
export function tokens(text: string): { done: Token[]; pending: string } {
  const value = String(text ?? "");
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && quoted && i + 1 < value.length) {
      current += ch + value[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if ((ch === "," || ch === ";") && !quoted && !angled) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  const done: Token[] = [];
  for (const part of parts) {
    const entry = part.trim();
    if (entry === "") continue;
    done.push(token(entry));
  }
  return { done, pending: current.replace(/^\s+/, "") };
}

function token(entry: string): Token {
  const angle = /^(.*)<([^<>]*)>\s*$/.exec(entry);
  const email = (angle ? angle[2] : entry).trim();
  const rawName = angle ? angle[1].trim() : "";
  const name = rawName.replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim();
  const valid = cleanContact({ email }) !== null && !/\s/.test(email);
  return { text: entry, label: nameText(name) || email, email, invalid: !valid };
}

/** The field text with entry `index` removed (a chip's close button). */
export function removeToken(text: string, index: number): string {
  const { done, pending } = tokens(text);
  const kept = done.filter((_, i) => i !== index).map((t) => t.text);
  const head = kept.join(", ");
  if (pending.trim() === "") return head === "" ? "" : head + ", ";
  return head === "" ? pending : head + ", " + pending;
}

/** A recipient list as chips: every entry ends with a separator, so none reads as half-typed. */
export function committed(text: string): string {
  const value = String(text ?? "").trim();
  if (value === "") return "";
  return /[,;]$/.test(value) ? value + " " : value + ", ";
}

/** A recipient list as a header takes it: no trailing separator. */
export function addressList(text: string): string {
  return String(text ?? "").trim().replace(/[\s,;]+$/, "");
}
