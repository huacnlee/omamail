// JMAP setup rules: where discovery starts, what a typed server means and
// what the user is told. Port of the setup half of providers/JmapProtocol.js;
// discovery and the session itself run in Rust (jmap.verify).
//
// Security: every URL is HTTPS. Discovery starts at the address domain's
// well-known URL (RFC 8620 section 2.2) unless the user typed a server.

export const STEP_TYPED = "typed";
export const STEP_WELL_KNOWN = "well-known";
const WELL_KNOWN_PATH = "/.well-known/jmap";
/** What a bare typed host means: the path the reference Stalwart serves. */
const SESSION_PATH = "/jmap/session";

function trimmed(value: unknown): string {
  return String(value === undefined || value === null ? "" : value).trim();
}

export function isValidHost(value: unknown): boolean {
  const host = trimmed(value);
  if (host === "" || host.length > 253) return false;
  if (/[\s/\\@:?#"'<>]/.test(host)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(host);
}

function bareHost(value: unknown): string {
  return trimmed(value).toLowerCase().replace(/\.+$/, "");
}

function isValidPort(value: unknown): boolean {
  const port = Math.floor(Number(value));
  return isFinite(port) && port >= 1 && port <= 65535;
}

export function addressDomain(address: unknown): string {
  const text = trimmed(address);
  const at = text.lastIndexOf("@");
  if (at < 0) return "";
  const domain = bareHost(text.substring(at + 1));
  return isValidHost(domain) ? domain : "";
}

/** A typed server to its session URL: an https URL as written, a host (and port) to `/jmap/session`; "" when it is not HTTPS or not a host. */
export function typedSessionUrl(server: unknown): string {
  const text = trimmed(server);
  if (text === "") return "";
  if (/^https:\/\//i.test(text)) return text;
  if (text.indexOf("://") >= 0) return "";
  const slash = text.indexOf("/");
  if (slash >= 0) {
    const written = bareHost(text.substring(0, slash));
    return isValidHost(written) ? "https://" + written + text.substring(slash) : "";
  }
  const colon = text.lastIndexOf(":");
  if (colon >= 0) {
    const host = bareHost(text.substring(0, colon));
    const port = text.substring(colon + 1);
    if (!/^[0-9]{1,5}$/.test(port) || !isValidPort(port) || !isValidHost(host)) return "";
    return "https://" + host + ":" + Math.floor(Number(port)) + SESSION_PATH;
  }
  const bare = bareHost(text);
  return isValidHost(bare) ? "https://" + bare + SESSION_PATH : "";
}

export interface DiscoveryPlan {
  error: string;
  domain: string;
  steps: { kind: string; url: string }[];
}

export function discoveryPlan(address: unknown, server: unknown): DiscoveryPlan {
  const domain = addressDomain(address);
  if (trimmed(server) !== "") {
    const typed = typedSessionUrl(server);
    if (typed === "") return { error: "The server must be reached over HTTPS", domain, steps: [] };
    return { error: "", domain, steps: [{ kind: STEP_TYPED, url: typed }] };
  }
  if (domain === "") return { error: "", domain: "", steps: [] };
  return { error: "", domain, steps: [{ kind: STEP_WELL_KNOWN, url: "https://" + domain + WELL_KNOWN_PATH }] };
}

/** The session's host, for "Signed in · host"; "" when it is not an https URL. */
export function sessionHost(url: unknown): string {
  const match = /^https:\/\/([^/?#]+)/i.exec(trimmed(url));
  if (!match) return "";
  let authority = match[1];
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.substring(at + 1);
  return authority.toLowerCase();
}

/** What the user calls the credential that worked. */
export function schemeLabel(scheme: unknown): string {
  return trimmed(scheme).toLowerCase() === "bearer" ? "API token" : "app password";
}

/** The sentence for a failed jmap.verify, and whether the server field should open. */
export function verifyError(code: unknown): { message: string; needsServer: boolean; rejected: boolean } {
  const value = String(code || "");
  const message =
    value === "jmap_unauthorized"
      ? "The server rejected that app password or API token"
      : value === "jmap_discovery_failed"
        ? "No JMAP server answered. Enter the server yourself"
        : value === "jmap_no_mailbox"
          ? "The server has no mailbox for this account"
          : value === "jmap_unsupported_sort"
            ? "The server cannot sort mail by date, which this client needs"
            : "Could not verify this JMAP mailbox";
  return {
    message,
    needsServer: value === "jmap_discovery_failed" || value === "jmap_invalid_url",
    rejected: value === "jmap_unauthorized",
  };
}
