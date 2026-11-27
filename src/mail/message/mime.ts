// The small part of omarchy/ui/message/Message.js the reader needs: decoding a
// MIME leaf the backend handed over (a calendar part), Content-Type
// parameters, addresses as one line, and byte sizes.

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charAt(i)] = i;
// The URL-safe alphabet reads the same: Gmail's body data is base64url.
B64_LOOKUP["-"] = 62;
B64_LOOKUP["_"] = 63;

/** Base64 (either alphabet) to bytes; characters outside it are skipped. */
export function base64ToBytes(text: unknown): number[] {
  const input = String(text ?? "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i++) {
    const value = B64_LOOKUP[input.charAt(i)];
    if (value === undefined) continue;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

function latin1(bytes: number[]): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** Bytes in `charset`, falling back to Latin-1 where the runtime cannot read it. */
export function decodeBytes(charset: string, bytes: number[]): string {
  const name = String(charset || "utf-8").trim().toLowerCase();
  if (name === "us-ascii" || name === "iso-8859-1" || name === "latin1") return latin1(bytes);
  try {
    return new TextDecoder(name === "utf8" ? "utf-8" : name).decode(new Uint8Array(bytes));
  } catch {
    try {
      return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
    } catch {
      return latin1(bytes);
    }
  }
}

export interface MimeHeader {
  name?: string;
  value?: string;
}

export interface MimePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: MimeHeader[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: MimePart[];
}

function partCharset(part: MimePart | null | undefined): string {
  const mime = String(part?.mimeType ?? "");
  const match = mime.match(/charset="?([^";]+)"?/i);
  if (match) return match[1];
  for (const header of part?.headers ?? []) {
    if (String(header.name ?? "").toLowerCase() !== "content-type") continue;
    const found = String(header.value ?? "").match(/charset="?([^";\s]+)"?/i);
    if (found) return found[1];
  }
  return "";
}

/** A leaf's text, from its base64 body data in its declared charset. */
export function decodePart(part: MimePart | null | undefined): string {
  const data = part?.body?.data ?? "";
  if (!data) return "";
  return decodeBytes(partCharset(part) || "utf-8", base64ToBytes(data));
}

/**
 * A Content-Type parameter, quoted or bare. RFC 2231 continuations are not
 * handled: a truncated filename is a smaller loss than a parser that guesses.
 */
export function contentTypeParam(value: unknown, name: string): string {
  const pattern = new RegExp(name + "\\s*=\\s*(\"([^\"]*)\"|([^;\\s]+))", "i");
  const match = String(value ?? "").match(pattern);
  if (!match) return "";
  return (match[2] !== undefined ? match[2] : match[3] || "").trim();
}

export interface Address {
  display?: string;
  email?: string;
}

/** "Name <email>", or whichever of the two there is. */
export function fullAddress(address: Address | null | undefined): string {
  if (!address) return "";
  const name = String(address.display ?? "");
  const email = String(address.email ?? "");
  return name && email && name !== email ? name + " <" + email + ">" : email || name;
}

export function fullAddressList(addresses: readonly Address[] | null | undefined): string {
  return (addresses ?? []).map(fullAddress).join(", ");
}

/** A byte count as people read it: "512 B", "1.4 KB", "12 MB". */
export function formatSize(bytes: unknown): string {
  const value = Math.max(0, Math.floor(Number(bytes) || 0));
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10240 ? 1 : 0) + " KB";
  return (value / (1024 * 1024)).toFixed(value < 10485760 ? 1 : 0) + " MB";
}
