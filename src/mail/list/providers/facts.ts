// What the list needs to know about each provider: the query behind each
// mailbox key and the capabilities that decide which actions a row offers.
// A copy of omarchy/ui/providers/NativeDomain.js (from Rust
// `providers::domain::snapshot`) restricted to the list; when src/mail/providers/
// carries these facts, read them from there.

export interface ListCapabilities {
  archive: boolean;
  star: boolean;
  spam: boolean;
  move: boolean;
  labels: boolean;
  conversations: boolean;
  batch: boolean;
  web: boolean;
  /** "Open web inbox...": the provider has a web view of a query (core `webBox`). */
  webBox: boolean;
  search: boolean;
}

interface Facts {
  name: string;
  capabilities: ListCapabilities;
  queries: Record<string, string>;
}

const cap = (c: Partial<ListCapabilities>): ListCapabilities => ({
  archive: false, star: false, spam: false, move: false, labels: false,
  conversations: false, batch: false, web: false, webBox: false, search: false, ...c,
});

const IMAP_QUERIES = {
  all: "search:ALL", archive: "folder:\\Archive", drafts: "folder:\\Drafts", inbox: "folder:INBOX",
  sent: "folder:\\Sent", spam: "folder:\\Junk", starred: "folder:INBOX FLAGGED", trash: "folder:\\Trash",
  unread: "folder:INBOX UNSEEN",
};
const ROLE_QUERIES = {
  archive: "role:archive", drafts: "role:drafts", inbox: "role:inbox", sent: "role:sent", spam: "role:junk",
  starred: "role:inbox flagged", trash: "role:trash", unread: "role:inbox unseen",
};

const FACTS: Record<string, Facts> = {
  gmail: {
    name: "Gmail",
    capabilities: cap({ archive: true, star: true, spam: true, move: true, labels: true, batch: true, web: true, webBox: true, search: true }),
    queries: {
      all: "in:anywhere -in:spam -in:trash", drafts: "in:drafts", inbox: "in:inbox", sent: "in:sent",
      spam: "in:spam", starred: "is:starred", trash: "in:trash",
      unread: "in:inbox is:unread -category:promotions -category:social -category:forums",
    },
  },
  hey: {
    name: "HEY",
    capabilities: cap({ spam: true, labels: true, conversations: true, batch: true, web: true, search: true }),
    queries: {
      aside: "box:asidebox", drafts: "drafts:", feed: "box:feedbox", inbox: "box:imbox", later: "box:laterbox",
      papertrail: "box:trailbox", trash: "box:trash", unread: "box:imbox unseen",
    },
  },
  imap: {
    name: "IMAP",
    capabilities: cap({ archive: true, star: true, move: true, batch: true, search: true }),
    queries: IMAP_QUERIES,
  },
  outlook: {
    name: "Outlook",
    capabilities: cap({ archive: true, star: true, move: true, batch: true, search: true }),
    queries: IMAP_QUERIES,
  },
  jmap: {
    name: "JMAP",
    capabilities: cap({ archive: true, star: true, spam: true, conversations: true, batch: true, search: true }),
    queries: ROLE_QUERIES,
  },
  m365: {
    name: "Microsoft 365",
    capabilities: cap({ archive: true, star: true, batch: true, search: true }),
    queries: ROLE_QUERIES,
  },
};

function facts(provider: string): Facts {
  return FACTS[String(provider ?? "").trim().toLowerCase()] ?? FACTS.gmail;
}

export function providerName(provider: string): string {
  return facts(provider).name;
}

export function capabilitiesOf(provider: string): ListCapabilities {
  return facts(provider).capabilities;
}

/** The query a mailbox key lists, or "" for a key the provider lacks. */
export function mailboxQuery(provider: string, mailboxKey: string): string {
  return facts(provider).queries[String(mailboxKey ?? "")] ?? "";
}

/** The query the mailbox watch counts unread mail with. */
export function unreadQuery(provider: string): string {
  return mailboxQuery(provider, "unread");
}

/** The only origins "Open in browser" and "Open web inbox..." may open, per
 * provider. Exactly the providers core `providers::PROVIDERS` gives `web` /
 * `webBox` (Gmail, HEY; `webBox` Gmail only), the hosts `providers::domain`
 * builds their URLs on from a server-controlled id or the list's query. */
const WEB_HOSTS: Record<string, string> = { gmail: "mail.google.com", hey: "app.hey.com" };

/** Whether a resolved web-message URL stays on the provider's own web mail:
 * https, the provider's exact host, no credentials, no control characters. */
export function webMessageUrlAllowed(provider: string, url: string): boolean {
  const text = String(url ?? "");
  const host = WEB_HOSTS[String(provider ?? "").toLowerCase()];
  if (!host || text === "" || /[\u0000-\u001f\u007f\s\\]/.test(text)) return false;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname === host && parsed.port === ""
    && parsed.username === "" && parsed.password === "";
}
