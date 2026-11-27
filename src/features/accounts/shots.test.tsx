// The chooser, the IMAP form and Settings as drawn, light and dark. On a
// real platform (`nsh test --target macos`) it saves screenshots to
// .nsh/shots/; headless it checks the same content.
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


async function shot(app: Awaited<ReturnType<typeof open>>, path: string) {
  try {
    await app.screenshot(path);
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
  }
}

for (const scheme of ["light", "dark"] as const) {
  test(`setup and settings are drawn (${scheme})`, async () => {
    const requests: Request[] = [];
    const app = await open("../../../App.tsx", { modules: backend(requests), width: 1280, height: 820 });
    await app.setColorScheme(scheme);
    await app.waitFor("id:provider-gmail");
    await app.wait(400);
    await shot(app, `.nsh/shots/accounts-${scheme}-picker.png`);
    await app.press("id:provider-imap");
    await app.waitFor("id:setup-address");
    await app.type("id:setup-address", "jane@fastmail.com");
    await app.press("id:imap-server-disclosure");
    await app.waitFor("id:setup-imap-host");
    await app.wait(400);
    await shot(app, `.nsh/shots/accounts-${scheme}-imap.png`);
    await app.type("id:setup-password", SECRET);
    await app.press("id:setup-connect");
    await app.waitUntil(() => requests.some((r) => r.method === "credentials.put"));
    await app.keyboard.press("meta+,");
    await app.waitFor("id:settings-page");
    await app.wait(400);
    await shot(app, `.nsh/shots/settings-${scheme}.png`);
    await app.press("id:settings-rail-mailboxes");
    await app.wait(400);
    await shot(app, `.nsh/shots/settings-${scheme}-mailboxes.png`);
    expect(app.shows("text:Add a mailbox...")).toBe(true);
  });
}
