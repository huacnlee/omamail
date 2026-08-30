import assert from "node:assert/strict";

import { applyCommand } from "../app/application/commands.js";
import { companionPublisher } from "../app/application/companion.js";

// ------------------------------------------------------------ the door

/** The window, as much of it as a command can touch. */
function windowStub(overrides = {}) {
  const app = {
    primed: 0,
    synced: 0,
    refreshed: 0,
    drafts: [],
    state: { route: "mail" },
    accountList: { accounts: [], activeId: "one@example.com" },
    controller: null,
    primeCompose() {
      app.primed += 1;
    },
    syncComposeFields() {
      app.synced += 1;
    },
    compose: {
      mailto(next) {
        app.drafts.push(next);
      },
    },
    ...overrides,
  };
  return app;
}

function contextStub() {
  return { notified: 0, notify() {
    this.notified += 1;
  } };
}

{
  const app = windowStub();
  const cx = contextStub();
  assert.equal(
    applyCommand(app, { verb: "compose-mailto", payload: "mailto:jane@example.com?subject=Lunch&body=Tuesday" }, cx),
    true,
  );
  assert.deepEqual(app.drafts, [
    {
      accountId: "one@example.com",
      to: "jane@example.com",
      cc: "",
      bcc: "",
      subject: "Lunch",
      body: "Tuesday",
    },
  ]);
  assert.equal(app.state.route, "compose", "the link opens the composer");
  assert.equal(app.primed, 1, "the From list and the completions come with it");
  assert.equal(app.synced, 1, "the fields hold what the link said");
  assert.equal(cx.notified, 1);
}

{
  // The account is whichever mailbox is open, and the controller is the one
  // that knows — the saved list is only the answer before it starts.
  const app = windowStub({
    controller: {
      snapshot: () => ({ accounts: { activeId: "imap:two@example.com" } }),
      refresh() {},
    },
  });
  applyCommand(app, { verb: "compose-mailto", payload: "mailto:a@example.com" }, contextStub());
  assert.equal(app.drafts[0].accountId, "imap:two@example.com");
}

{
  // A stranger's link is a stranger's text. `Mailto.parse` is what keeps a
  // CRLF out of a header, and this is the window agreeing that it did.
  const app = windowStub();
  applyCommand(
    app,
    {
      verb: "compose-mailto",
      payload: "mailto:jane@example.com?subject=Stop%0D%0ABcc:%20victim@example.com",
    },
    contextStub(),
  );
  assert.equal(app.drafts[0].subject, "Stop Bcc: victim@example.com");
  assert.equal(app.drafts[0].bcc, "", "an injected header is not a recipient");
}

{
  const app = windowStub();
  const cx = contextStub();
  // The router refuses these before they reach here. This is the second reader
  // agreeing rather than assuming.
  for (const command of [
    { verb: "compose-mailto", payload: "https://example.com" },
    { verb: "compose-mailto", payload: "" },
    { verb: "quit" },
    {},
    null,
  ]) {
    assert.equal(applyCommand(app, command, cx), false, `${JSON.stringify(command)} is refused`);
  }
  assert.deepEqual(app.drafts, []);
  assert.equal(app.state.route, "mail", "a refused command leaves the window alone");
}

{
  const app = windowStub({
    controller: {
      snapshot: () => ({ accounts: { activeId: "one@example.com" } }),
      refresh() {
        app.refreshed += 1;
      },
    },
  });
  const cx = contextStub();
  assert.equal(applyCommand(app, { verb: "refresh" }, cx), true);
  assert.equal(app.refreshed, 1);
  assert.equal(app.state.route, "mail", "a refresh does not move the window");

  // Before any account has been signed in there is no controller, and being
  // asked to look for mail is not a reason to fall over.
  const empty = windowStub();
  assert.equal(applyCommand(empty, { verb: "refresh" }, contextStub()), true);
}

{
  // The window is the application: being asked to open it is answered by the
  // activation the caller has already done.
  const app = windowStub();
  assert.equal(applyCommand(app, { verb: "open" }, contextStub()), true);
  assert.equal(app.state.route, "mail");
  assert.deepEqual(app.drafts, []);
}

// ------------------------------------------------------- the bar's number

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

{
  const published = [];
  const publisher = companionPublisher(async () => ({
    set_unread(count) {
      published.push(count);
      return true;
    },
  }));

  publisher.setUnread(3);
  await settle();
  assert.deepEqual(published, [3]);

  publisher.setUnread(0);
  await settle();
  assert.deepEqual(published, [3, 0], "reaching zero is a count, not a silence");

  // `Status.parse` floors and clamps on the way out; the window does not hand
  // the file a number it would have to fix.
  published.length = 0;
  for (const total of [12.9, -4, Number.NaN, "7"]) publisher.setUnread(total);
  await settle();
  assert.deepEqual(published, [12, 0, 0, 7]);
}

{
  // The two calls that race the one import must not leave the bar showing the
  // older of them.
  const published = [];
  const publisher = companionPublisher(async () => ({
    set_unread(count) {
      published.push(count);
      return true;
    },
  }));
  publisher.setUnread(1);
  publisher.setUnread(9);
  await settle();
  assert.deepEqual(
    published.at(-1),
    9,
    "the newest total is what the bar is left holding",
  );
}

{
  // A host without the module — the test harness, and any build without the
  // bar. A count nobody can publish is not a reason for a mailbox to stop.
  const publisher = companionPublisher(async () => {
    throw new Error("no such module");
  });
  publisher.setUnread(4);
  publisher.setUnread(5);
  await settle();

  const throwing = companionPublisher(async () => ({
    set_unread() {
      throw new Error("the host went away");
    },
  }));
  throwing.setUnread(4);
  await settle();
}

console.log("test_app_commands.mjs ok");
