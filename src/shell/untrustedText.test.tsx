// Folder names come from the mail server and subjects and sender names from
// whoever wrote the message. They reach the sidebar, the list row and the
// sidebar's tooltip as plain Text: markup in them is shown as typed, never
// interpreted, and never asks for a remote resource. Successor of the Qt client's
// test_sidebar_text.py, test_tooltip_text.py and test_qml_text_format.py.
// Synthetic account and mail on a stand-in backend; the network is stubbed,
// so any fetch the TSX made is listed by app.requests(). The headless engine
// loads no pictures, so markup drawn as rich text is caught by the literal
// text going missing (a TextView draws it as an object mark and "bold"), not
// by a request.
import { expect, open, test } from "nsh/test";

const TRACKER = "https://tracker.example/x.png";
const MARKUP = `<img src="${TRACKER}"> <b>bold</b>`;
// The server's hierarchy delimiter; "|" keeps the URL's slashes in one name.
const FOLDER = "Lists|" + MARKUP;
const ACCOUNT = { email: "jane@example.com", provider: "imap", label: "Jane" };

// A value that is the URL itself, at any depth.
function namesUrl(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith("https://tracker.example");
  if (Array.isArray(value)) return value.some(namesUrl);
  if (value && typeof value === "object") return Object.values(value).some(namesUrl);
  return false;
}

function backend() {
  const calls: { method: string; params: any }[] = [];
  const row = {
    id: "1:INBOX", subject: "Subject " + MARKUP, snippet: "Snippet " + MARKUP, dateMs: Date.now() - 60000,
    from: { name: "Sender " + MARKUP, email: "sender@example.com" }, unread: false, labelIds: ["INBOX"],
  };
  const modules = {
    "omamail-native": {
      "Backend.request": (method: string, params: any) => {
        calls.push({ method, params });
        switch (method) {
          case "accounts.read":
            return { result: { revision: "r1", registry: { version: 1, accounts: [ACCOUNT], activeId: "" } } };
          case "imap.folders":
            return { result: { labels: [
              { id: "INBOX", name: "INBOX", rawName: "INBOX", system: true, unread: 0 },
              { id: "Lists", name: "Lists", rawName: "Lists", delimiter: "|", unread: 0 },
              { id: "Lists|x", name: FOLDER, rawName: FOLDER, delimiter: "|", unread: 1 },
            ] } };
          case "imap.list":
            return { result: { page: { ids: [row.id], nextPageToken: "", estimate: 1 } } };
          case "imap.messages":
            return { result: { messages: params.ids.includes(row.id) ? [row] : [] } };
          case "message.summaries":
            return { result: { summaries: params.messages } };
          default:
            return { result: null };
        }
      },
      "Backend.nextEvent": () => null,
      "Backend.shutdown": () => undefined,
      "Backend.os": () => "linux",
      "Backend.readConfig": (name: string) => name === "analytics.json" ? "false" : null,
      "Backend.writeConfig": () => undefined,
    },
  };
  return { modules, calls };
}

test("server and sender markup shows as typed in the sidebar, its tooltip and the list, and asks for nothing", async () => {
  const fake = backend();
  const app = await open("../../App.tsx", { modules: fake.modules, network: {}, width: 1280, height: 820, platform: "linux" });

  // The scenario was reached: the folder and the row are on screen.
  await app.waitFor(`id:label-${FOLDER}`);
  await app.waitFor("text:Subject " + MARKUP);
  expect(app.shows("text:" + MARKUP)).toBe(true);
  expect(app.shows("text:Sender " + MARKUP)).toBe(true);
  expect(app.shows("text:Snippet " + MARKUP)).toBe(true);
  expect(app.texts()).not.toContain("bold");

  // A nested folder's tooltip carries its whole path (then its count), still as typed.
  expect(app.texts().some((t) => t.startsWith(FOLDER))).toBe(false);
  await app.hover(`id:label-${FOLDER}`);
  await app.waitUntil(() => app.texts().includes(FOLDER + " · 1"));

  // Nothing asked for the tracker: no fetch from the TSX, and no backend
  // call that loads a public resource or takes the URL as a value of its own
  // (message.summaries carries the subject, markup and all, which is fine).
  expect(app.requests().map((r) => r.url)).toEqual([]);
  expect(fake.calls.filter((c) => c.method.startsWith("public.")).map((c) => c.method)).toEqual([]);
  expect(fake.calls.filter((c) => namesUrl(c.params)).map((c) => c.method)).toEqual([]);
});
