// Send-as aliases: the addresses a mailbox may send from besides its own.
// Port of account/Aliases.js. A list is parsed from what a person types
// ("Jane <jane@example.com> (default), other@example.com") or from a provider's
// rows, and every entry is checked against the same address pattern the
// account list uses, so nothing that is not an address becomes a From line.

export interface Alias {
  email: string;
  displayName: string;
  isPrimary: boolean;
  isDefault: boolean;
}

const EMAIL_PATTERN = /^[^\s@]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

function trimmed(value: unknown): string {
  return String(value === undefined || value === null ? "" : value).trim();
}

/** Splits on commas and newlines that are outside quotes and angle brackets. */
function splitEntries(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (let i = 0; i < text.length; i++) {
    const character = text.charAt(i);
    if (quoted) {
      if (character === "\\" && i + 1 < text.length) {
        current += character + text.charAt(i + 1);
        i++;
        continue;
      }
      if (character === '"') quoted = false;
      current += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
      current += character;
      continue;
    }
    if (character === "<") angled = true;
    else if (character === ">") angled = false;
    if (!angled && (character === "," || character === "\n" || character === "\r")) {
      out.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  out.push(current);
  return out;
}

function unquoted(value: string): string {
  const text = trimmed(value);
  if (text.length < 2 || text.charAt(0) !== '"' || text.charAt(text.length - 1) !== '"') return text;
  return text.substring(1, text.length - 1).replace(/\\([\\"])/g, "$1");
}

function withoutDefaultMarker(text: string): { text: string; isDefault: boolean } {
  const value = trimmed(text);
  const match = value.match(/^(.*?)\s*(?:\(default\)|\[default\])$/i);
  if (match) return { text: trimmed(match[1]), isDefault: true };
  if (/\*+$/.test(value)) return { text: value.replace(/\*+$/, "").trim(), isDefault: true };
  if (/^\*+/.test(value)) return { text: value.replace(/^\*+/, "").trim(), isDefault: true };
  return { text: value, isDefault: false };
}

function fromText(entry: string) {
  const marked = withoutDefaultMarker(entry);
  const angle = marked.text.match(/^(.*?)\s*<([^\s@<>]+@[^<>]+)>$/);
  if (angle) {
    return { email: trimmed(angle[2]).toLowerCase(), displayName: unquoted(angle[1]), isDefault: marked.isDefault };
  }
  return { email: marked.text.toLowerCase(), displayName: "", isDefault: marked.isDefault };
}

function fromObject(item: any) {
  return {
    email: trimmed(item.email || item.sendAsEmail).toLowerCase(),
    displayName: trimmed(item.displayName || item.name),
    isDefault: item.isDefault === true || item.default === true || item.defaultFrom === true,
  };
}

/** Typed text or provider rows to a deduplicated list; at most one default. */
export function parse(value: unknown): Alias[] {
  if (!value) return [];
  let raw: unknown[];
  if (Array.isArray(value)) raw = value;
  else if (typeof value === "string") raw = splitEntries(value);
  else return [];
  const out: Alias[] = [];
  const seen: Record<string, boolean> = {};
  let haveDefault = false;
  for (const item of raw) {
    const parsed =
      typeof item === "string" ? fromText(item) : item && typeof item === "object" ? fromObject(item) : null;
    if (!parsed || !parsed.email || !EMAIL_PATTERN.test(parsed.email)) continue;
    if (seen[parsed.email]) continue;
    seen[parsed.email] = true;
    const isDefault = parsed.isDefault && !haveDefault;
    if (isDefault) haveDefault = true;
    out.push({ email: parsed.email, displayName: parsed.displayName, isPrimary: false, isDefault });
  }
  return out;
}

function quotedName(name: string): string {
  const text = trimmed(name);
  if (text === "") return "";
  if (!/[",]/.test(text)) return text;
  return '"' + text.replace(/([\\"])/g, "\\$1") + '"';
}

/** The list as the setup field shows it, which `parse` reads back unchanged. */
export function format(aliases: unknown): string {
  return parse(aliases)
    .map((item) => {
      let text = item.displayName !== "" ? quotedName(item.displayName) + " <" + item.email + ">" : item.email;
      if (item.isDefault) text += " (default)";
      return text;
    })
    .join(", ");
}

/** The account's own address first, then the aliases; the default is the alias that claims it, else the address. */
export function sendAsList(address: string, aliases: unknown): Alias[] {
  const primary = trimmed(address);
  const list: Alias[] = [];
  const seen: Record<string, boolean> = {};
  const rows = parse(aliases);
  const claimed = rows.some((row) => row.isDefault);
  if (primary !== "") {
    seen[primary.toLowerCase()] = true;
    list.push({ email: primary, displayName: "", isPrimary: true, isDefault: !claimed });
  }
  for (const row of rows) {
    if (seen[row.email]) continue;
    seen[row.email] = true;
    list.push({ ...row, isPrimary: false });
  }
  return list;
}

/** The primary row named `name`; the others as they are. */
export function withSenderName(rows: Alias[], name: string): Alias[] {
  const list = Array.isArray(rows) ? rows : [];
  const wanted = trimmed(name);
  if (wanted === "") return list;
  return list.map((row) => (row && row.isPrimary === true ? { ...row, displayName: wanted } : row));
}
