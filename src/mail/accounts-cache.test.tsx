// The query cache is bound to the identity a mailbox's server reports (Qt's
// MailAccount.loadProfile -> cache.queryBind): Gmail and JMAP by their profile
// answer, IMAP by its configured address; an answer that is no address binds
// nothing; a switch binds the opened one again; signing out empties the cache.
// Synthetic accounts and a stand-in backend only.
import { expect, open, test } from "nsh/test";

const REGISTRY = {
  version: 1,
  activeId: "imap:jane@example.org",
  accounts: [
    { id: "imap:jane@example.org", provider: "imap", email: "jane@example.org",
      imap: { host: "imap.example.org", port: 993, smtpHost: "smtp.example.org", smtpPort: 465, username: "jane@example.org" } },
    { id: "typed@example.com", provider: "gmail", email: "typed@example.com" },
    { id: "jmap:bad@example.net", provider: "jmap", email: "bad@example.net" },
  ],
};

interface Options {
  /** What `gmail.profile` answers: an address, or "offline" for a failed read. */
  gmailProfile?: string;
  /** The address a restored Gmail cache was last bound to (core's persisted `store.account`). */
  restoredGmail?: string;
}

function backend(options: Options = {}) {
  const calls: string[] = [];
  // Core's rule, for the Gmail cache: a bind to another address empties the store.
  let gmailAccount = options.restoredGmail ?? "";
  let gmailRows = true;
  const modules = {
    "omamail-native": {
      "Backend.request": async (method: string, params: any) => {
        if (method.startsWith("cache.") || method.endsWith(".profile")) {
          calls.push(method + " " + String(params.accountId) + (params.email ? "=" + params.email : ""));
        }
        switch (method) {
          case "accounts.read":
            return { result: { revision: "r1", registry: REGISTRY } };
          case "cache.queryRestore": {
            const account = params.accountId === "typed@example.com" ? gmailAccount : "";
            return { result: { generation: 1, store: { version: 2, account, profile: null, labels: [], session: null } } };
          }
          case "accounts.save":
            return { result: { revision: "r2" } };
          case "cache.queryGet":
            if (params.accountId === "typed@example.com" && !gmailRows)
              return { result: { key: "", entry: null, local: [], stale: true, summaries: [] } };
            return { result: { key: "", entry: null, local: [], stale: true, summaries: [
              { id: "1:INBOX", subject: "Cached for Gmail", snippet: "", dateMs: 0, from: { name: "S", email: "s@example.com" }, unread: false, labelIds: ["INBOX"] },
            ] } };
          case "cache.queryBind":
            if (params.accountId === "typed@example.com") {
              if (gmailAccount !== "" && gmailAccount.toLowerCase() !== String(params.email).toLowerCase()) gmailRows = false;
              gmailAccount = String(params.email);
            }
            return { result: { store: { version: 2, account: params.email ?? "", profile: null, labels: [], session: null } } };
          case "cache.queryClear":
            return { result: { store: { version: 2, account: params.email ?? "", profile: null, labels: [], session: null } } };
          case "gmail.profile":
            if (options.gmailProfile === "offline") return { error: { code: -32000, message: "network_unreachable" } };
            // The server's identity, not what the registry holds.
            return { result: { email: options.gmailProfile ?? "server@example.com", messagesTotal: 0, threadsTotal: 0, historyId: "" } };
          case "jmap.profile":
            // An answer that is no address binds nothing.
            return { result: { data: { email: "not an address\r\nx" }, state: {} } };
          default:
            return { error: { code: -32601, message: "stand-in" } };
        }
      },
    },
  };
  return { modules, calls };
}

const binds = (calls: string[]) => calls.filter((c) => c.startsWith("cache.queryBind"));

test("each mailbox binds its cache to the identity its server reports", async () => {
  const fake = backend();
  const app = await open("./fixtures/AccountsCacheApp.tsx", { modules: fake.modules, width: 400, height: 300 });
  await app.waitUntil(() => binds(fake.calls).length >= 2 && fake.calls.some((c) => c.startsWith("jmap.profile")));
  await app.wait(200);
  expect([...binds(fake.calls)].sort()).toEqual([
    "cache.queryBind imap:jane@example.org=jane@example.org",
    "cache.queryBind typed@example.com=server@example.com",
  ]);
  expect(fake.calls).toContain("gmail.profile typed@example.com");
  // A switch binds the opened one again, to the address its server gave, without asking again.
  await app.press("id:open-gmail");
  await app.waitUntil(() => binds(fake.calls).length >= 3);
  expect(binds(fake.calls)[2]).toBe("cache.queryBind typed@example.com=server@example.com");
  expect(fake.calls.filter((c) => c.startsWith("gmail.profile")).length).toBe(1);
  await app.press("id:open-gmail");
  await app.wait(200);
  expect(binds(fake.calls).length).toBe(3);
});

test("signing out empties the cache; the next sign-in asks the server again", async () => {
  const fake = backend();
  const app = await open("./fixtures/AccountsCacheApp.tsx", { modules: fake.modules, width: 400, height: 300 });
  await app.waitUntil(() => binds(fake.calls).length >= 2);
  await app.press("id:sign-out-gmail");
  await app.waitUntil(() => fake.calls.includes("cache.queryClear typed@example.com"));
  await app.press("id:sign-in-gmail");
  await app.waitUntil(() => fake.calls.filter((c) => c.startsWith("gmail.profile")).length === 2);
  await app.waitUntil(() => binds(fake.calls).length >= 3);
  expect(binds(fake.calls)[2]).toBe("cache.queryBind typed@example.com=server@example.com");
});

test("a removed mailbox's cache is emptied and can never paint again", async () => {
  const fake = backend();
  const app = await open("./fixtures/AccountsCacheApp.tsx", { modules: fake.modules, width: 400, height: 400 });
  await app.waitUntil(() => binds(fake.calls).some((c) => c.includes("typed@example.com=")));
  // Bound: its cached row paints.
  await app.press("id:peek-gmail");
  await app.waitFor("peek=1");
  await app.press("id:remove-gmail");
  await app.waitUntil(() => fake.calls.includes("cache.queryClear typed@example.com"));
  // Removed: nothing asks its cache, and nothing paints from it.
  const gets = fake.calls.filter((c) => c === "cache.queryGet typed@example.com").length;
  await app.press("id:peek-gmail");
  await app.waitFor("peek=null");
  expect(fake.calls.filter((c) => c === "cache.queryGet typed@example.com").length).toBe(gets);
});

test("offline, a mailbox whose address the server confirmed before paints its cache at once (as Qt did)", async () => {
  const fake = backend({ gmailProfile: "offline", restoredGmail: "typed@example.com" });
  const app = await open("./fixtures/AccountsCacheApp.tsx", { modules: fake.modules, width: 400, height: 400 });
  await app.waitUntil(() => fake.calls.includes("gmail.profile typed@example.com"));
  await app.press("id:peek-gmail");
  await app.waitFor("peek=1");
  // No profile answer, so no bind from the account side.
  expect(binds(fake.calls).some((c) => c.startsWith("cache.queryBind typed@example.com"))).toBe(false);
});

test("never confirmed, a mailbox paints nothing until its server answers", async () => {
  const fake = backend({ gmailProfile: "offline" });
  const app = await open("./fixtures/AccountsCacheApp.tsx", { modules: fake.modules, width: 400, height: 400 });
  await app.waitUntil(() => fake.calls.includes("gmail.profile typed@example.com"));
  await app.press("id:peek-gmail");
  await app.waitFor("peek=null");
  expect(fake.calls.includes("cache.queryGet typed@example.com")).toBe(false);
});

test("a server answering another address rebinds, and the old address's rows are gone", async () => {
  const fake = backend({ gmailProfile: "other@example.com", restoredGmail: "typed@example.com" });
  const app = await open("./fixtures/AccountsCacheApp.tsx", { modules: fake.modules, width: 400, height: 400 });
  await app.waitUntil(() => fake.calls.includes("cache.queryBind typed@example.com=other@example.com"));
  await app.press("id:peek-gmail");
  await app.waitUntil(() => /^peek=(0|null)$/.test((app.texts() as string[]).find((t) => t.startsWith("peek=")) ?? ""));
});
