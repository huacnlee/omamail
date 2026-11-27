// The From address is always set when a mailbox can send, however the draft
// started and whenever the mailboxes and their send-as rows arrive; Send is
// held, with words that say why, while none can. Synthetic mailboxes only.
import { expect, test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";

async function start() {
  const { app, guard } = await openGuarded("./fixtures/FromApp.tsx", { width: 1100, height: 800, platform: "linux" });
  await app.waitFor("id:probe");
  return { app, guard };
}

function probe(app: any): string {
  return (app.texts() as string[]).find((t) => t.startsWith("from=")) ?? "";
}

async function expectProbe(app: any, part: string) {
  const end = Date.now() + 2000;
  while (!probe(app).includes(part)) {
    if (Date.now() > end) throw new Error(`expected "${part}" in "${probe(app)}"`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Both mailboxes listed and read, Sam's open: the active one is not the first. */
async function ready(app: any) {
  await app.press("id:load-accounts");
  await app.press("id:activate-sam");
}

test("a new message takes the active mailbox's own address, not the first mailbox's", async () => {
  const { app, guard } = await start();
  await ready(app);
  await app.press("id:new");
  await expectProbe(app, "from=sam@example.org acct=imap:sam@example.org send=true");
  expect(app.shows("Choose a From address")).toBe(false);
  assertGuarded(guard);
});

test("the header's bare overlay still gets a draft with From", async () => {
  const { app, guard } = await start();
  await ready(app);
  await app.press("id:bare-overlay");
  await expectProbe(app, "from=sam@example.org acct=imap:sam@example.org send=true");
  assertGuarded(guard);
});

test("mailboxes that arrive after the draft opened fill From; until then Send says why", async () => {
  const { app, guard } = await start();
  await app.press("id:new");
  await expectProbe(app, "from= acct= send=false reason=Add a mailbox to send from");
  expect(app.shows("Send is off: Add a mailbox to send from")).toBe(true);
  await app.press("id:load-accounts");
  // No mailbox open (the unified view): the first one, as a new message there.
  await expectProbe(app, "from=jane@example.com acct=jane@example.com send=true reason=");
  assertGuarded(guard);
});

test("send-as rows that arrive late fill From when the registry has no aliases", async () => {
  const { app, guard } = await start();
  await app.press("id:hold-identities");
  // Mailboxes listed, but not the registry's aliases: only the send-as rows can say.
  await app.press("id:list-accounts");
  await app.press("id:new");
  await expectProbe(app, "from= acct=jane@example.com send=false reason=Choose a From address");
  expect(app.shows("Send is off: Choose a From address")).toBe(true);
  await app.press("id:release-identities");
  await expectProbe(app, "from=jane@example.com acct=jane@example.com send=true");
  assertGuarded(guard);
});

test("a reply sends as the alias the original reached", async () => {
  const { app, guard } = await start();
  await ready(app);
  await app.press("id:reply");
  await expectProbe(app, "from=team@example.org acct=imap:sam@example.org send=true");
  assertGuarded(guard);
});

test("reply all and forward keep the owning mailbox's address", async () => {
  const { app, guard } = await start();
  await ready(app);
  await app.press("id:reply-all");
  await expectProbe(app, "from=team@example.org acct=imap:sam@example.org");
  const second = await start();
  await ready(second.app);
  await second.app.press("id:forward");
  // A forward reached nobody in particular: the mailbox's primary address.
  await expectProbe(second.app, "from=sam@example.org acct=imap:sam@example.org send=true");
  assertGuarded(guard);
  assertGuarded(second.guard);
});

test("a reopened draft keeps the From it was saved with, and one saved without gets the default", async () => {
  const { app, guard } = await start();
  await ready(app);
  await app.press("id:reopen-draft");
  await expectProbe(app, "from=team@example.org acct=imap:sam@example.org");
  const second = await start();
  await ready(second.app);
  await second.app.press("id:reopen-draft-nofrom");
  await expectProbe(second.app, "from=sam@example.org acct=imap:sam@example.org");
  assertGuarded(guard);
  assertGuarded(second.guard);
});

test("a mailto: link opens with the active mailbox's address", async () => {
  const { app, guard } = await start();
  await ready(app);
  await app.press("id:mailto");
  await expectProbe(app, "from=sam@example.org acct=imap:sam@example.org send=true");
  assertGuarded(guard);
});

test("an address the user chose is not replaced when the lists change", async () => {
  const { app, guard } = await start();
  await ready(app);
  await app.press("id:new");
  await expectProbe(app, "from=sam@example.org");
  await app.press("id:compose-from");
  await app.press("text:team@example.org · Team");
  await expectProbe(app, "from=team@example.org");
  await app.press("id:load-accounts");
  await expectProbe(app, "from=team@example.org");
  assertGuarded(guard);
});
