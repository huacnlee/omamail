// Ports omarchy/ui/tests/test_drop.js and the mailbox-table cases.
import { expect, test } from "nsh/test";
import { verbFor, wouldAct } from "./mailboxes-drop";
import { capabilities, labelsAreFolders, mailboxes, sharedMailboxes } from "./mailboxes";

const inbox = { mailboxKey: "inbox", searchQuery: "", rawQuery: "", rawLabelId: "", canReportSpam: true };
const plain = { id: "1", unread: false, starred: false, labelIds: ["INBOX"] };

test("a drop acts only where it changes something", () => {
  expect(wouldAct("mailbox", "inbox", inbox, [plain])).toBe(false);
  expect(wouldAct("mailbox", "archive", inbox, [plain])).toBe(true);
  expect(wouldAct("mailbox", "trash", inbox, [plain])).toBe(true);
  expect(wouldAct("mailbox", "spam", { ...inbox, canReportSpam: false }, [plain])).toBe(false);
  expect(wouldAct("mailbox", "starred", inbox, [plain])).toBe(true);
  expect(wouldAct("mailbox", "starred", inbox, [{ ...plain, starred: true }])).toBe(false);
  expect(wouldAct("mailbox", "unread", inbox, [{ ...plain, unread: true }])).toBe(false);
  expect(wouldAct("mailbox", "unread", inbox, [plain])).toBe(true);
  expect(verbFor("all", inbox)).toBe("archive");
  expect(verbFor("all", { ...inbox, mailboxKey: "trash" })).toBe("untrash");
  expect(wouldAct("mailbox", "all", { ...inbox, mailboxKey: "sent" }, [plain])).toBe(false);
  expect(wouldAct("mailbox", "all", inbox, [plain])).toBe(true);
  expect(verbFor("sent", inbox)).toBe("");
  expect(wouldAct("mailbox", "sent", inbox, [plain])).toBe(false);
  expect(wouldAct("label", "Label_1", inbox, [plain])).toBe(true);
  expect(wouldAct("label", "INBOX", inbox, [plain])).toBe(false);
  expect(wouldAct("label", "Label_1", { ...inbox, rawQuery: "label:x", rawLabelId: "Label_1" }, [plain])).toBe(false);
  expect(wouldAct("label", "Label_1", inbox, [])).toBe(false);
});

test("a provider's mailboxes drop the absent ones and follow the API revision", () => {
  expect(mailboxes("gmail").map((b) => b.key)).toEqual(["inbox", "unread", "starred", "drafts", "sent", "all", "spam", "trash"]);
  expect(mailboxes("jmap", ["archive"]).some((b) => b.key === "archive")).toBe(false);
  expect(mailboxes("imap", null, 10).map((b) => b.key)).toContain("all");
  expect(mailboxes("imap", null, 10).map((b) => b.key)).not.toContain("archive");
  expect(mailboxes("imap", null, 5).map((b) => b.key)).toContain("archive");
  expect(mailboxes("unknown")[0].label).toBe("Inbox");
  expect(mailboxes("hey")[0].label).toBe("Imbox");
});

test("a combined view keeps the rows every mailbox has, in the first one's order", () => {
  expect(sharedMailboxes([mailboxes("gmail"), mailboxes("imap")]).map((b) => b.key))
    .toEqual(["inbox", "unread", "starred", "drafts", "sent", "all", "spam", "trash"]);
  expect(sharedMailboxes([mailboxes("hey"), mailboxes("gmail")]).map((b) => b.key)).toEqual(["inbox", "unread", "drafts", "trash"]);
  expect(sharedMailboxes([])).toEqual([]);
});

test("label capabilities per provider", () => {
  expect(capabilities("gmail").manageLabels).toBe(true);
  expect(capabilities("hey").manageLabels).toBe(false);
  expect(labelsAreFolders("imap")).toBe(true);
  expect(labelsAreFolders("gmail")).toBe(false);
  expect(capabilities("nope").labels).toBe(false);
});
