// Port of ui/tests/test_agent.js (the parts that are not Rust's projection).
import { expect, test } from "nsh/test";
import * as a from "./agent";
import * as e from "./events";

const A = "imap:ada@example.com";
const B = "imap:bob@example.com";
const quote = "On Monday, Bob wrote:\n> Original question";

test("draft chats belong to one account and draft", () => {
  const readerChat = { id: "r", accountId: A, messageId: "original", draftKey: "" };
  const draftA = { accountId: A, replyMessageId: "original", draftKey: "draft-A" };
  const draftB = { ...draftA, draftKey: "draft-B" };
  expect(a.canUseDraftChat(readerChat, draftA)).toBe(true);
  const owned = { ...readerChat, draftKey: "draft-A" };
  expect(a.canUseDraftChat(owned, draftA)).toBe(true);
  expect(a.canUseDraftChat(owned, draftB)).toBe(false);
  expect(a.canUseDraftChat(readerChat, draftB)).toBe(true);
  expect(a.canUseDraftChat({ ...readerChat, accountId: B }, draftB)).toBe(false);
  expect(a.canUseDraftChat({ ...readerChat, messageId: "different" }, draftB)).toBe(false);
});

test("only the app's own quote is detached", () => {
  expect(a.replyOnly("My reply\n\n" + quote, quote)).toBe("My reply");
  expect(a.replyOnly("My reply\n\n> A deliberate quotation", quote)).toBe("My reply\n\n> A deliberate quotation");
  const saved = { accountId: A, body: "My reply", replyQuote: quote, threadId: "t" };
  expect(a.proposalEnvelope(saved).body).toBe("My reply\n\n" + quote);
  expect(saved.body).toBe("My reply");
  expect(a.proposalEnvelope(a.proposalEnvelope(saved)).body).toBe("My reply\n\n" + quote);
  expect(a.proposalEnvelope({ accountId: A, body: "Legacy complete reply" }).body).toBe("Legacy complete reply");
});

test("a proposal draft copies attachment bytes and owns no file", () => {
  const attachment = { filename: "notes.txt", data: "SGVsbG8=", path: "/private/editor-file", owned: true };
  const draft = a.proposalDraft({ accountId: A, from: "ada@example.com", to: "bob@example.com", subject: "Re: Hello",
    body: "Reply\n\n" + quote, replyQuote: quote, replyMessageId: "original", threadId: "thread", inReplyTo: "message",
    attachments: [attachment] }, "chat", "draft");
  expect(draft.body).toBe("Reply\n\n" + quote);
  expect(draft.bodyQuote).toBe(quote);
  expect(draft.draftAttachments[0]).toEqual({ filename: "notes.txt", data: "SGVsbG8=", path: "", owned: false });
  expect(attachment.path).toBe("/private/editor-file");
  expect(draft.agentParentJobId).toBe("chat");
  expect(a.proposalDraft({ accountId: A, body: "Legacy" }, "chat", "draft").bodyQuote).toBe("");
});

test("proposals sit after the complete reply, before the next question", () => {
  expect(a.conversationWithProposals([
    { role: "user", text: "Draft a reply" }, { role: "assistant", text: "Here is a draft" },
    { role: "assistant", text: "Would you like a warmer tone?" },
  ], [{ id: "first", afterTurn: 2 }, { id: "second", afterTurn: 2 }])).toEqual([
    { role: "user", text: "Draft a reply" }, { role: "assistant", text: "Here is a draft" },
    { role: "assistant", text: "Would you like a warmer tone?" },
    { role: "proposal", text: "first" }, { role: "proposal", text: "second" },
  ]);
  expect(a.conversationWithProposals([
    { role: "user", text: "Draft" }, { role: "status", text: "Creating draft" },
    { role: "assistant", text: "Please review it" }, { role: "user", text: "Make it shorter" },
  ], [{ id: "draft", afterTurn: 2 }])).toEqual([
    { role: "user", text: "Draft" }, { role: "status", text: "Creating draft" },
    { role: "assistant", text: "Please review it" }, { role: "proposal", text: "draft" },
    { role: "user", text: "Make it shorter" },
  ]);
});

test("labels, answers and fingerprints", () => {
  expect(a.stateLabel({ id: "r", state: "running", resultReady: true })).toBe("Ready");
  expect(a.detailText({ id: "f", state: "failed", error: "No terminal" })).toBe("No terminal");
  expect(a.draftAnswer({ id: "1", state: "running" }, "Partial")).toBe("");
  expect(a.draftAnswer({ id: "1", state: "running", resultReady: true }, "Ready")).toBe("Ready");
  expect(a.draftAnswer({ id: "1", state: "done", question: "Clarify?" }, "Not a body")).toBe("");
  expect(a.draftAnswer({ id: "1", state: "failed" }, "Unusable")).toBe("");
  expect(a.draftAnswer({ id: "1", state: "done" }, "Full text\nQUESTION: ordinary\n")).toBe("Full text\nQUESTION: ordinary\n");
  const turns = [{ role: "user" as const, text: a.MAIL_TRANSFORM_FORMAT }];
  expect(a.draftAnswer({ id: "1", state: "done" }, "Title: New title\n\nBody:\nNew body", turns)).toBe("New body");
  expect(a.draftAnswer({ id: "1", state: "done" }, "Unstructured response", turns)).toBe("");
  const fields = { to: "x@example.com", subject: "Plan", body: "Keep this", from: "alias@example.com" };
  expect(a.draftFingerprint(fields)).toBe(a.draftFingerprint({ ...fields }));
  expect(a.draftFingerprint({ ...fields, body: "Changed" })).not.toBe(a.draftFingerprint(fields));
  expect(a.chatEntries([{ role: "user", text: "Question" }, { role: "assistant", text: "<b>Plain</b>" },
    { role: "status", text: "Reading context" }, { role: "thinking", text: "hidden" }, { role: "user", text: 17 }]))
    .toEqual([{ role: "user", text: "Question" }, { role: "assistant", text: "<b>Plain</b>" }, { role: "status", text: "Reading context" }]);
  expect(a.workingText({ id: "w", state: "running", created: 100 }, 2580000, 0)).toBe("• Working (41m 20s • Esc to interrupt)");
  expect(a.workingText(null, 3500, 1000)).toBe("• Preparing (0m 2s)");
  expect(a.suggestsClear("/cl")).toBe(true);
  expect(a.suggestsClear("/x")).toBe(false);
  expect(a.commandMatches("/h")).toEqual(["/history"]);
});

test("the pending queue waits on its conversation and has limits", () => {
  const history = [
    { id: "a1", conversationId: "a1", accountId: A, created: 1 },
    { id: "a2", conversationId: "a1", accountId: A, created: 3 },
    { id: "b1", accountId: A, created: 2 },
  ];
  expect(a.pendingJob(history, null, false, "a1", "a1")!.id).toBe("a2");
  expect(a.pendingJob(history, history[0], false, "", "")).toBe(null);
  expect(a.pendingJob(history, history[0], true, "", "a1")).toBe(null);
  expect(a.pendingLimit(Array(20).fill("next"), "next").length > 0).toBe(true);
  expect(a.pendingLimit([], "x".repeat(65537)).length > 0).toBe(true);
  expect(a.pendingLimit(["one"], "two")).toBe("");
});

test("suggested events: the gate", () => {
  for (const text of ["See you Thursday at 3pm", "Dinner on 12 September", "Sep 12 works for me", "12/09/2026 at the office",
    "2026-09-12", "call at 14:30", "tomorrow morning", "next week then", "May 12 works", "on Thu, then", "Dinner on Thursday?",
    "Friday evening?", "by Monday please"]) expect(e.mentionsDate(text)).toBe(true);
  for (const text of ["I may go", "he sat down and thought", "the sun was out", "no dates in here", "", "march on",
    "a dec in the code", "Sunday was lovely", "the September issue", "Thursday", "every day in May"]) expect(e.mentionsDate(text)).toBe(false);
  const person = { from: { email: "bob@example.com" }, labelIds: ["INBOX"] };
  expect(e.automatedMail(person)).toBe(false);
  for (const email of ["noreply@github.com", "no-reply@email.claude.com", "notifications@github.com", "mailer-daemon@example.com",
    "alerts@bank.example", "newsletter@shop.example", "bounces+1@list.example", "donotreply@x.y"]) expect(e.automatedMail({ from: { email } })).toBe(true);
  expect(e.automatedMail({ from: { email: "serviceinfo@dbs.com" } })).toBe(false);
  expect(e.automatedMail({ from: { email: "bob@example.com" }, labelIds: ["CATEGORY_PROMOTIONS"] })).toBe(true);
  expect(e.worthALook(person, "Dinner Thursday at 7pm?", false)).toBe(true);
  expect(e.worthALook(person, "Dinner Thursday at 7pm?", true)).toBe(false);
  const now = Date.parse("2026-09-07T12:00:00Z");
  expect(e.tooOldForEvents(now - 3 * 86400000, now)).toBe(false);
  expect(e.tooOldForEvents(now - 90 * 86400000, now)).toBe(true);
  expect(e.tooOldForEvents(0, now)).toBe(true);
});

test("suggested events: what was found and how it reads", () => {
  const look = { id: "e1", kind: "events", messageId: "m1", accountId: A, state: "running", created: 3 };
  const done = { id: "e0", kind: "events", messageId: "m2", accountId: A, state: "done", created: 2,
    events: [{ title: "Dinner", startMs: 1789232400000, endMs: 1789239600000 }] };
  expect(a.finishedNote(done)).toBe("The agent found an event in the message");
  expect(a.finishedNote({ id: "e2", kind: "events", state: "done", events: [], subject: "S" })).toBe("");
  expect(a.finishedNote({ id: "e3", kind: "events", state: "done", subject: "S", events: [{}, {}] })).toBe("The agent found 2 events in “S”");
  const looks = { [A]: { m1: look, m2: done } };
  expect(e.lookFor(looks, A, "m1")).toBe(look);
  expect(e.lookFor(looks, B, "m1")).toBe(null);
  expect(e.lookFor(looks, "", "m1")).toBe(null);
  const found = e.eventSuggestions(done, []);
  expect(found.length).toBe(1);
  expect(found[0].key).toBe("e0:0");
  expect(e.eventSuggestions(done, ["e0:0"])).toEqual([]);
  expect(e.eventSuggestions(look, [])).toEqual([]);
  expect(e.eventSuggestions({ id: "x", state: "done", events: [{ title: "x", startMs: 1 }] }, [])).toEqual([]);
  expect(e.eventSuggestions({ id: "e7", kind: "events", state: "done", events: [{ title: "T", startMs: 1000 }] }, [])[0].endMs).toBe(1000 + 3600000);
  const sep12 = new Date(2026, 8, 12, 19, 0).getTime();
  const thisYear = new Date(2026, 8, 7).getTime();
  expect(e.suggestionWhen({ startMs: sep12, endMs: sep12 + 3600000 }, thisYear)).toBe("Sat 12 Sep, 19:00–20:00");
  expect(e.suggestionWhen({ startMs: sep12, endMs: sep12 }, thisYear)).toBe("Sat 12 Sep, 19:00");
  const day = new Date(2026, 8, 12).getTime();
  expect(e.suggestionWhen({ startMs: day, endMs: day + 86400000, allDay: true }, thisYear)).toBe("Sat 12 Sep (all day)");
  expect(e.suggestionWhen({ startMs: day, endMs: day + 2 * 86400000, allDay: true }, thisYear)).toBe("Sat 12 Sep – Sun 13 Sep (all day)");
  expect(e.suggestionWhen({ startMs: sep12, endMs: sep12 + 3600000 }, new Date(2027, 0, 1).getTime())).toBe("Sat 12 Sep 2026, 19:00–20:00");
  const late = e.eventPrefill({ title: "Party", startMs: sep12, endMs: sep12 + 5 * 3600000, notes: "Bring wine" });
  expect(new Date(late.endMs).getHours()).toBe(23);
  expect(late.description).toBe("Bring wine\n\nThe message has it ending Sun 13 Sep, 00:00.");
  const twoDays = e.eventPrefill({ title: "Offsite", startMs: new Date(2026, 9, 2).getTime(), endMs: new Date(2026, 9, 4).getTime(), allDay: true });
  expect(twoDays.description).toBe("All day through Sat 3 Oct, as the message put it.");
});
