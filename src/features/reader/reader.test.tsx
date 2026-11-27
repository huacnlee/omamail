// The reader on a stand-in backend: what opens, the three bodies, the images
// it will not fetch until asked, links that ask first, and the one-click
// unsubscribe. The harness opens message `m1` of one Gmail account.
import { expect, open, test } from "nsh/test";
import * as Calendar from "../../mail/message/calendar";
import { ICS, RESOURCE, TINY_PNG, render } from "./fixtures/sample";

/** window.json as the stand-in backend holds it, by file name. */
const files: Record<string, string> = {};
const windowFile = () => files["window.json"] ?? "";

type Answers = Record<string, (params: any) => unknown>;

function backend(log: { method: string; params: any }[], resource: Record<string, unknown> = RESOURCE, answers: Answers = {}, windowJson?: string) {
  for (const name of Object.keys(files)) delete files[name];
  if (windowJson !== undefined) files["window.json"] = windowJson;
  return {
    "omamail-native": {
      "Backend.request": (method: string, params: any) => {
        log.push({ method, params });
        if (answers[method]) return { result: answers[method](params) };
        if (method === "reader.open") return { result: resource };
        if (method === "message.compose") return { result: { raw: "UkFX", threadId: params?.fields?.threadId ?? "", draftId: "" } };
        // The backend's real shape: opening stores in a fresh private directory
        // under the runtime dir (`<runtime>/omamail-attachment-<pid>-<n>/`);
        // only a plain save goes to Downloads.
        if (method === "attachment.store") {
          const dir = params.open === true ? "/run/user/1000/omamail-attachment-4242-0/" : "/home/jane/Downloads/";
          return { result: { path: dir + params.filename } };
        }
        if (method === "gmail.attachment" || method === "imap.attachment") return { result: { data: "UERG" } };
        if (method === "reader.render") return { result: { nativeRender: render(params?.options?.allowRemoteImages === true) } };
        if (method === "public.image") return { result: { data: TINY_PNG } };
        if (method === "public.unsubscribe") return { result: { status: 200 } };
        return { result: null };
      },
      "Backend.nextEvent": () => null,
      "Backend.shutdown": () => undefined,
      "Backend.openDownload": (path: string) => {
        log.push({ method: "Backend.openDownload", params: path });
      },
      "Backend.os": () => "linux",
      "Backend.readConfig": (name: string) => files[name] ?? null,
      "Backend.writeConfig": (name: string, text: string) => {
        files[name] = text;
      },
    },
  };
}

async function openReader(storage: Record<string, string> = {}, resource: Record<string, unknown> = RESOURCE, answers: Answers = {}, windowJson?: string) {
  const log: { method: string; params: any }[] = [];
  const app = await open("./testing/ReaderHarness.tsx", { modules: backend(log, resource, answers, windowJson), width: 900, height: 760, storage });
  await app.waitFor("text:Quarterly report");
  return { app, log };
}

test("a message opens on its reading, header first, with nothing remote fetched", async () => {
  const { app, log } = await openReader();
  await app.waitFor("text:Reading body");
  expect(app.shows("text:Ann Lee <ann@example.com>")).toBe(true);
  expect(app.shows("text:To: jane@example.com")).toBe(true);
  expect(app.shows("text:Nov 27, 2026 09:30")).toBe(true);
  expect(app.shows("text:2 images are blocked: loading them tells the sender this message was opened")).toBe(true);
  const opened = log.filter((r) => r.method === "reader.open");
  expect(opened.length).toBe(2);
  expect(opened[0].params).toMatchObject({ accountId: "jane@example.com", id: "m1", cacheOnly: true, options: { allowRemoteImages: false, withReader: true } });
  expect(opened[1].params.cacheOnly).toBe(false);
  expect(log.some((r) => r.method === "public.image")).toBe(false);
});

test("the mode picker switches the body and remembers the choice", async () => {
  const { app } = await openReader();
  await app.press("text:Original");
  await app.waitFor("text:Original body");
  await app.press("text:Plain");
  await app.waitFor("text:Plain body");
  await app.waitUntil(() => windowFile().includes('"bodyMode":"plain"'));
});

test("Show images grants this message only, through the backend's worker", async () => {
  const { app, log } = await openReader();
  await app.press("text:Show images");
  await app.waitUntil(() => log.some((r) => r.method === "public.image"));
  const fetched = log.find((r) => r.method === "public.image")!;
  expect(fetched.params).toEqual({ url: "https://cdn.example.com/a.png" });
  const rendered = log.filter((r) => r.method === "reader.render");
  expect(rendered[0].params).toMatchObject({ accountId: "jane@example.com", id: "m1", readerKey: "k1", options: { allowRemoteImages: true } });
  await app.waitFor("text:2 images are blocked: loading them tells the sender this message was opened", { state: "gone" });
  expect(windowFile().includes('"alwaysShowImages":true')).toBe(false);
});

test("Always show is the standing answer", async () => {
  const { app } = await openReader();
  await app.press("text:Always show");
  await app.waitUntil(() => windowFile().includes('"alwaysShowImages":true'));
});

test("a link opens only after the real address was shown and accepted", async () => {
  const { app } = await openReader();
  await app.waitFor("text:Read the report");
  app.onDialog((dialog) => dialog.buttons.find((b) => b !== "Open link") ?? null);
  await app.press("text:Read the report");
  await app.waitUntil(() => app.dialogs().length > 0);
  expect(app.dialogs()[0].message).toBe("https://example.com/report");
  expect(app.openedUrls()).toEqual([]);
  app.onDialog((dialog) => (dialog.buttons.includes("Open link") ? "Open link" : null));
  await app.press("text:Read the report");
  await app.waitUntil(() => app.openedUrls().length > 0);
  expect(app.openedUrls()).toEqual(["https://example.com/report"]);
});

test("a one-click list is left with one POST, and says so", async () => {
  const { app, log } = await openReader();
  expect(app.shows("text:This sender accepts a one-click unsubscribe")).toBe(true);
  await app.press("text:Unsubscribe");
  await app.waitFor("text:Unsubscribed from this list");
  expect(log.find((r) => r.method === "public.unsubscribe")!.params).toEqual({ url: "https://lists.example.com/u?x=1" });
});

test("attachments fold under their count", async () => {
  const { app } = await openReader();
  await app.press("text:1 attachment · Show");
  await app.waitFor("text:report.pdf");
  expect(app.shows("text:2.0 KB")).toBe(true);
});

test("Move to... opens the picker for the open message", async () => {
  const { app } = await openReader();
  await app.press("label:Move to...");
  await app.waitFor("text:No folders or labels to move into");
});

test("a list that takes mail is left with one message, sent on the press", async () => {
  const resource = {
    ...RESOURCE,
    payload: { headers: [{ name: "List-Unsubscribe", value: "<mailto:leave@lists.example.com?subject=remove>" }] },
  };
  const { app, log } = await openReader({}, resource);
  expect(app.shows("text:Unsubscribing sends a message to this list")).toBe(true);
  await app.press("text:Unsubscribe");
  await app.waitFor("text:Unsubscribe request sent to leave@lists.example.com");
  const built = log.find((r) => r.method === "message.compose")!;
  expect(built.params.fields).toMatchObject({ from: "jane@example.com", to: "leave@lists.example.com", subject: "remove" });
  expect(log.find((r) => r.method === "gmail.send")!.params).toEqual({ raw: "UkFX", accountId: "jane@example.com" });
});

test("an attachment that is not a picture is stored privately for opening, then opened from that path", async () => {
  const { app, log } = await openReader();
  await app.press("text:1 attachment · Show");
  await app.press("label:Open report.pdf");
  await app.waitUntil(() => log.some((r) => r.method === "Backend.openDownload"));
  expect(log.find((r) => r.method === "attachment.store")!.params).toMatchObject({ filename: "report.pdf", data: "UERG", open: true });
  expect(log.find((r) => r.method === "Backend.openDownload")!.params).toBe("/run/user/1000/omamail-attachment-4242-0/report.pdf");
});

test("an invitation on IMAP is answered with an RFC 5546 reply, sent on the press", async () => {
  const invite = Calendar.invitationFrom(ICS, "REQUEST");
  expect(invite).not.toBe(null);
  const { app, log } = await openReader({ "harness.provider": "imap" }, { ...RESOURCE, cachedInvite: invite });
  await app.waitFor("text:Planning");
  await app.press("id:invite-accepted");
  // The card reads the answer back out of the invitation it rewrote.
  await app.waitFor("text:jane@example.com — Yes");
  const built = log.find((r) => r.method === "message.compose")!.params.fields;
  expect(built.to).toBe("ann@example.com");
  expect(built.from).toBe("jane@example.com");
  expect(built.calendar.method).toBe("REPLY");
  expect(built.calendar.text).toContain("PARTSTAT=ACCEPTED");
  expect(log.find((r) => r.method === "imap.send")!.params).toEqual({ raw: "UkFX", accountId: "jane@example.com" });
  expect(log.some((r) => r.method === "calendar.attendance")).toBe(false);
});

test("a JMAP account without submission offers no mail unsubscribe, only the page", async () => {
  const resource = {
    ...RESOURCE,
    payload: { headers: [{ name: "List-Unsubscribe", value: "<mailto:leave@lists.example.com>, <https://lists.example.com/leave>" }] },
  };
  const mail = "urn:ietf:params:jmap:mail";
  const session = { primaryAccounts: { [mail]: "a1" }, accounts: { a1: { accountCapabilities: { [mail]: {} } } } };
  const { app, log } = await openReader({ "harness.provider": "jmap" }, resource, {
    "jmap.session": () => ({ data: {}, state: { session, mailboxes: [{ id: "b1", role: "inbox" }] } }),
  });
  await app.waitFor("text:Unsubscribing opens this sender's page in a browser");
  expect(log.find((r) => r.method === "jmap.session")!.params.accountId).toBe("jane@example.com");
  expect(app.shows("text:Unsubscribing sends a message to this list")).toBe(false);
});

test("a Gmail invitation follows Calendar: the event's fields and the owner's answer", async () => {
  const invite = Calendar.invitationFrom(ICS, "REQUEST");
  const { app, log } = await openReader({}, { ...RESOURCE, cachedInvite: invite }, {
    "calendar.attendance": () => ({
      response: "accepted",
      event: {
        id: "e1", iCalUID: "u1@example.com", status: "confirmed", sequence: 2, summary: "Planning, moved",
        start: { dateTime: "2026-12-03T15:00:00Z" }, end: { dateTime: "2026-12-03T16:00:00Z" },
      },
    }),
  });
  await app.waitFor("text:Planning, moved");
  await app.waitFor("text:jane@example.com — Yes");
  const asked = log.find((r) => r.method === "calendar.attendance")!.params;
  expect(asked).toMatchObject({ accountId: "jane@example.com", uid: "u1@example.com", organizer: "ann@example.com" });
  // Reading the answer back writes nothing.
  expect(asked.response).toBe(undefined);
  expect(log.some((r) => r.method === "message.compose" || r.method === "calendar.saveInvitation")).toBe(false);
});

test("an event the agent found is a card: Add opens no write, Dismiss waves it away", async () => {
  const look = {
    id: "job1", kind: "events", state: "done", accountId: "jane@example.com", messageId: "m1",
    events: [{ title: "Design review", startMs: Date.parse("2026-12-04T10:00:00Z"), endMs: Date.parse("2026-12-04T11:00:00Z"), location: "Room 2" }],
  };
  const { app, log } = await openReader({ "harness.look": JSON.stringify(look) });
  await app.press("text:The agent found an event in this message");
  await app.waitFor("text:Design review");
  await app.press("label:Add to calendar...");
  // With no calendar to write to, nothing is written: the owner is told instead.
  expect(log.some((r) => r.method.startsWith("calendar."))).toBe(false);
  await app.press("label:Dismiss");
  await app.waitFor("text:The agent found an event in this message", { state: "gone" });
});

test("a Microsoft 365 mailbox that cannot send offers no mail unsubscribe, only the page", async () => {
  const resource = {
    ...RESOURCE,
    payload: { headers: [{ name: "List-Unsubscribe", value: "<mailto:leave@lists.example.com>, <https://lists.example.com/leave>" }] },
  };
  const { app, log } = await openReader({ "harness.provider": "m365" }, resource, {
    "m365.verify": () => ({ ok: true, email: "jane@example.com", roles: {}, refusals: { send: "This mailbox has no Sent folder" } }),
  });
  await app.waitFor("text:Unsubscribing opens this sender's page in a browser");
  expect(app.shows("text:Unsubscribing sends a message to this list")).toBe(false);
  // One mailbox check, the accounts feature's; the reader asks none of its own.
  expect(log.filter((r) => r.method === "m365.verify").length).toBe(1);
  // The page opens only after its real address was shown and accepted.
  app.onDialog((dialog) => (dialog.buttons.includes("Open link") ? "Open link" : null));
  await app.press("text:Unsubscribe...");
  await app.waitUntil(() => app.openedUrls().length > 0);
  expect(app.openedUrls()).toEqual(["https://lists.example.com/leave"]);
  expect(log.some((r) => r.method === "message.compose" || r.method === "m365.send")).toBe(false);
});

test("standing alone, the reader offers Back, which returns to the list", async () => {
  const { app } = await openReader({ "harness.compact": "1" });
  await app.waitFor("id:reader-back");
  // Above the message: the header and the bar both in view, the bar first.
  const bar = app.layout("id:reader-backbar")!;
  const header = app.layout("id:reader-header")!;
  expect(bar.y + bar.height <= header.y).toBe(true);
  await app.press("id:reader-back");
  await app.waitFor("id:reader-back", { state: "gone" });
  expect(app.shows("text:Quarterly report")).toBe(false);
});

test("in a wider window the reader shows no Back", async () => {
  const { app } = await openReader();
  await app.waitFor("text:Reading body");
  expect(app.shows("id:reader-back")).toBe(false);
});

test("a body zoomed below the floor is read at 80%, shown in the bar, and one press resets it", async () => {
  // Qt's floor was 60%: a 15pt body at 9pt. A stored 0.6 is raised to 0.8.
  const { app } = await openReader({}, RESOURCE, {}, JSON.stringify({ bodyZoom: 0.6 }));
  await app.waitFor("text:Reading body");
  await app.waitFor("id:reader-zoom");
  expect(app.shows("text:80%")).toBe(true);
  expect(app.spanStyle("text:Reading body").fontSize).toBe(12);
  await app.press("id:reader-zoom");
  await app.waitFor("id:reader-zoom", { state: "gone" });
  expect(app.spanStyle("text:Reading body").fontSize).toBe(15);
  await app.waitUntil(() => windowFile().includes('"bodyZoom":1'));
});

test("at 100% the bar shows no zoom; a zoomed-in body shows its percentage", async () => {
  const plain = await openReader();
  await plain.app.waitFor("text:Reading body");
  expect(plain.app.shows("id:reader-zoom")).toBe(false);
  const { app } = await openReader({}, RESOURCE, {}, JSON.stringify({ bodyZoom: 1.25 }));
  await app.waitFor("id:reader-zoom");
  expect(app.shows("text:125%")).toBe(true);
  expect(app.spanStyle("text:Reading body").fontSize).toBe(19);
});
