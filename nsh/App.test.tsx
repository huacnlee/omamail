import { expect, open, test } from "nsh/test";

const row = (id: string, subject: string, unread: boolean) => ({
  id,
  threadId: id,
  from: { name: "Ada Lovelace", email: "ada@example.org" },
  subject,
  snippet: `About ${subject}`,
  date: "2026-11-26T10:42:00.000Z",
  time: "10:42",
  unread,
  starred: false,
});

const modules = {
  "omamail-native": {
    "Accounts.list": async () => [{ id: "me", email: "me@example.org", label: "", provider: "imap", pending: false }],
    "Mail.list": async () => ({ messages: [row("1", "Engine notes", true), row("2", "Lunch", false)], nextPageToken: "", estimate: 2 }),
    "Mail.read": async () => ({
      id: "1",
      subject: "Engine notes",
      from: { name: "Ada Lovelace", email: "ada@example.org" },
      to: [],
      cc: [],
      date: "2026-11-26T10:42:00.000Z",
      text: "The engine weaves algebraic patterns.",
      attachments: [],
    }),
    "Mail.act": async () => undefined,
  },
};

test("opens a message from the inbox", async () => {
  const app = await open("./App.tsx", { modules, width: 1280, height: 800 });
  await app.waitFor("Engine notes");
  await app.press("Engine notes");
  await app.waitFor("The engine weaves algebraic patterns.");
  expect(app.count("text:No message selected")).toBe(0);
});
