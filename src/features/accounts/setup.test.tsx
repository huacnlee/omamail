// Adding a mailbox end to end, on a stand-in backend: the chooser on a first
// run, the IMAP form, and where the password goes. The credential is
// synthetic; the test checks it reaches only the keyring call and the folder
// check, never the registry the backend writes to disk.
import { expect, open, test } from "nsh/test";

const SECRET = "synthetic-app-password-1";

interface Request {
  method: string;
  params: any;
}

function backend(requests: Request[], options: { refuse?: boolean } = {}) {
  let saved: any = { version: 1, accounts: [], activeId: "" };
  return {
    "omamail-native": {
      "Backend.request": (method: string, params: any) => {
        requests.push({ method, params: JSON.parse(JSON.stringify(params ?? {})) });
        switch (method) {
          case "accounts.read":
            return { result: { revision: "r" + requests.length, registry: saved } };
          case "accounts.save":
            saved = params.registry;
            return { result: { revision: "r" + requests.length } };
          case "imap.folders":
            return options.refuse ? { error: { code: -32000, message: "imap_auth_failed" } } : { result: { folders: [] } };
          case "credentials.get":
            return { result: { found: false } };
          case "credentials.put":
            return { result: { stored: true } };
          case "system.info":
            return { result: { version: "0.12.0", apiVersion: 10, capabilities: { agent: false } } };
          default:
            return { result: null };
        }
      },
      "Backend.nextEvent": () => null,
      "Backend.shutdown": () => undefined,
      "Backend.os": () => "linux",
      "Backend.readConfig": () => null,
      "Backend.writeConfig": () => undefined,
    },
  };
}

test("a first run opens the chooser, and IMAP signs in through the keyring", async () => {
  const requests: Request[] = [];
  const app = await open("../../../App.tsx", { modules: backend(requests), width: 1280, height: 820 });
  await app.waitFor("text:Add a mailbox");
  expect(app.shows("text:Which kind?")).toBe(true);
  await app.press("id:provider-imap");
  await app.waitFor("id:setup-address");
  await app.type("id:setup-address", "jane@example.org");
  await app.type("id:setup-password", SECRET);
  await app.press("id:setup-connect");
  await app.waitUntil(() => requests.some((r) => r.method === "credentials.put"));

  const put = requests.find((r) => r.method === "credentials.put")!;
  expect(put.params.kind).toBe("imap-password");
  expect(put.params.accountId).toBe("imap:jane@example.org");
  const check = requests.find((r) => r.method === "imap.folders")!;
  expect(check.params.settings.imapHost).toBe("imap.example.org");

  // The forbidden effect: the password in what is saved to disk.
  const saves = requests.filter((r) => r.method === "accounts.save");
  expect(saves.length > 0).toBe(true);
  for (const save of saves) expect(JSON.stringify(save.params).indexOf(SECRET)).toBe(-1);
});

test("a refused password is said, and nothing is stored", async () => {
  const requests: Request[] = [];
  const app = await open("../../../App.tsx", { modules: backend(requests, { refuse: true }), width: 1280, height: 820 });
  await app.waitFor("id:provider-imap");
  await app.press("id:provider-imap");
  await app.type("id:setup-address", "jane@example.org");
  await app.type("id:setup-password", SECRET);
  await app.press("id:setup-connect");
  await app.waitUntil(() => requests.some((r) => r.method === "imap.folders"));
  await app.waitFor("id:setup-connect");
  expect(requests.some((r) => r.method === "credentials.put")).toBe(false);
  for (const r of requests.filter((x) => x.method === "accounts.save"))
    expect(JSON.stringify(r.params).indexOf(SECRET)).toBe(-1);
});

test("settings lists the mailbox, and Edit... opens its form without the password", async () => {
  const requests: Request[] = [];
  const modules = backend(requests);
  const app = await open("../../../App.tsx", { modules, width: 1280, height: 820 });
  // A mailbox added through the form first, so the registry holds one.
  await app.press("id:provider-imap");
  await app.type("id:setup-address", "jane@example.org");
  await app.type("id:setup-password", SECRET);
  await app.press("id:setup-connect");
  await app.waitUntil(() => requests.some((r) => r.method === "credentials.put"));
  await app.keyboard.press("meta+,");
  await app.waitFor("id:settings-page");
  await app.waitFor("id:settings-mailbox-imap:jane@example.org");
  await app.press("id:settings-mailbox-edit-imap:jane@example.org");
  await app.waitFor("id:setup-password");
  expect(app.shows("text:" + SECRET)).toBe(false);
});

// The plugin-settings.json import is covered by settings/model.test.ts: a
// stand-in module answers with a promise, so the synchronous readConfig the
// store does cannot see a stand-in file here (see src/shell/Shell.test.tsx).
