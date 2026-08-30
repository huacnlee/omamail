import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createSettingsController,
  preferenceSchema,
} from "../app/settings/controller.js";

// The standalone window has no shell dialog, so every setting `manifest.json`
// declares to the bar widget is drawn by this page instead. The table is a
// transcription; this is what stops it becoming a second, disagreeing set of
// bounds.
{
  const manifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
  );
  const declared = manifest.barWidget.schema;
  const table = preferenceSchema();
  for (const setting of declared) {
    const entry = table.find((row) => row.schema === setting.key);
    assert.ok(entry, `${setting.key} is missing from the settings page`);
    assert.ok(entry.detail, `${setting.key} has no helper text`);
    assert.ok(entry.section, `${setting.key} belongs to no section`);
    if (setting.type === "integer") {
      assert.equal(entry.kind, "number", setting.key);
      assert.equal(entry.min, setting.min, setting.key);
      assert.equal(entry.max, setting.max, setting.key);
      assert.equal(entry.step, setting.step, setting.key);
      assert.equal(entry.defaultValue, setting.defaultValue, setting.key);
    } else if (setting.type === "string") {
      assert.equal(entry.kind, "text", setting.key);
      assert.equal(entry.defaultValue, setting.defaultValue, setting.key);
    } else {
      // A two-option enum is a boolean wearing a hat; the page may draw it as
      // a switch, but it still has to carry the shell's own two option strings.
      assert.ok(["choice", "toggle"].includes(entry.kind), setting.key);
      assert.deepEqual(entry.options, setting.options, setting.key);
      if (entry.kind === "choice")
        assert.equal(entry.defaultValue, setting.defaultValue, setting.key);
      else
        assert.equal(
          entry.defaultValue,
          setting.defaultValue === setting.options[1],
          setting.key,
        );
    }
  }
}

const gmail = {
  id: "one@example.com",
  email: "one@example.com",
  provider: "gmail",
  clientId: "client.apps.googleusercontent.com",
};
const imap = {
  id: "imap:two@example.com",
  email: "two@example.com",
  provider: "imap",
  imap: {
    username: "two",
    imapHost: "imap.example.com",
    imapPort: 993,
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    insecure: false,
  },
};

function harness({
  failForget = false,
  uncertainForget = false,
  failRemoteImages = false,
  initialRemoteImages = false,
  initialHeavyMessages = false,
  initialUndoSendSeconds = 10,
} = {}) {
  let accounts = { version: 1, activeId: gmail.id, accounts: [gmail, imap] };
  const configured = [];
  const saved = [];
  const forgotten = [];
  const cleared = [];
  const remoteImageWrites = [];
  let remoteImages = initialRemoteImages;
  let heavyMessages = initialHeavyMessages;
  let undoSendSeconds = initialUndoSendSeconds;
  const heavyMessageWrites = [];
  const undoSendWrites = [];
  const controller = createSettingsController({
    readAccounts: () => accounts,
    saveAccounts(next) {
      accounts = structuredClone(next);
      saved.push(structuredClone(next));
    },
    async configure(next) {
      configured.push(next.map((entry) => entry.id));
    },
    async revokeGmail(accountId, clientId) {
      forgotten.push(["gmail", accountId, clientId]);
      return { outcome: "deleted" };
    },
    async forgetImap(descriptor) {
      forgotten.push(["imap", descriptor]);
      if (failForget || uncertainForget) {
        const error = new Error("secret details must not escape");
        if (uncertainForget) error.credentialOutcome = "uncertain";
        else error.credentialOutcome = "beforeEffect";
        throw error;
      }
      return { outcome: "deleted" };
    },
    clearCache(accountId) {
      cleared.push(accountId);
    },
    readRemoteImages: () => remoteImages,
    async saveRemoteImages(enabled) {
      remoteImageWrites.push(enabled);
      if (failRemoteImages) throw new Error("storage details must not escape");
      remoteImages = enabled;
    },
    readHeavyMessages: () => heavyMessages,
    async saveHeavyMessages(enabled) {
      heavyMessageWrites.push(enabled);
      heavyMessages = enabled;
    },
    readUndoSendSeconds: () => undoSendSeconds,
    async saveUndoSendSeconds(seconds) {
      undoSendWrites.push(seconds);
      undoSendSeconds = seconds;
    },
  });
  return {
    controller,
    current: () => accounts,
    configured,
    saved,
    forgotten,
    cleared,
    remoteImageWrites,
    heavyMessageWrites,
    undoSendWrites,
  };
}

{
  const { controller, current, configured, cleared } = harness({
    uncertainForget: true,
  });
  const result = await controller.confirmRemoval(
    controller.requestRemoval(imap.id),
  );
  assert.equal(result.ok, false);
  assert.equal(result.removed, true);
  assert.equal(result.uncertain, true);
  assert.equal(result.error, "Credential state uncertain; sign in again");
  assert.equal(
    current().accounts.length,
    1,
    "uncertain deletion never restores a fake usable account",
  );
  assert.deepEqual(configured, [[gmail.id]], "removed context stays removed");
  assert.deepEqual(cleared, [imap.id], "uncertain account cache is cleared");
}

{
  const { controller } = harness();
  const snapshot = controller.snapshot();
  assert.equal(snapshot.accounts.length, 2);
  assert.equal(snapshot.accounts[0].active, true);
  assert.equal(snapshot.accounts[0].detail, "Showing now");
  assert.equal(snapshot.accounts[1].active, false);
  assert.equal(snapshot.accounts[1].providerName, "IMAP");
  const named = Object.fromEntries(
    snapshot.preferences.map((entry) => [entry.key, entry]),
  );
  assert.equal(named.remoteImages.value, false);
  assert.equal(named.remoteImages.disabled, false);
  assert.match(named.remoteImages.detail, /tells its host/i);
  assert.equal(named.heavyMessageRendering.value, false);
  assert.equal(snapshot.undoSend.seconds, 10);
  // A preference the host cannot store is still on the page, disabled, and
  // says why — a control that fails after it is pressed is worse than one
  // that never offered.
  assert.equal(named.maxMessages.disabled, true);
  assert.match(named.maxMessages.detail, /nowhere to store/i);
  assert.equal(named.maxMessages.value, 25);
  // Sections are the table's, in the order the page draws them.
  assert.deepEqual(
    [...new Set(snapshot.preferences.map((entry) => entry.section))],
    ["Reading", "Writing", "In the bar", "Google OAuth client"],
  );
}

// Anything the host is willing to keep is writable through one pair, and the
// arithmetic on a stepped number belongs here rather than in the view.
{
  const stored = {};
  const controller = createSettingsController({
    readAccounts: () => ({ version: 1, activeId: "", accounts: [] }),
    saveAccounts() {},
    configure: async () => {},
    readPreference: (key) => stored[key],
    savePreference: async (key, value) => {
      stored[key] = value;
    },
  });
  assert.deepEqual(await controller.setPreference("maxMessages", 40), {
    ok: true,
    value: 40,
  });
  assert.equal(stored.maxMessages, 40);
  // Bounds are the manifest's, and a value outside them is clamped rather than
  // stored.
  assert.equal((await controller.setPreference("oauthPort", 70000)).value, 65535);
  assert.equal((await controller.setPreference("oauthPort", 3)).value, 1024);
  // An option the schema does not name falls back to the default.
  assert.equal(
    (await controller.setPreference("notifyNewMail", "Sometimes")).value,
    "On",
  );
  assert.equal((await controller.setPreference("notifyNewMail", "Off")).value, "Off");
  // A default search goes back out to Gmail and to an IMAP server, so it loses
  // its line breaks before it is stored.
  assert.equal(
    (await controller.setPreference("defaultQuery", " in:inbox\n-in:spam ")).value,
    "in:inbox -in:spam",
  );
  // Stepping snaps onto the manifest's own grid before it moves.
  assert.equal((await controller.setPreference("refreshIntervalSec", 125)).value, 125);
  assert.equal((await controller.stepPreference("refreshIntervalSec", 1)).value, 120);
  assert.equal((await controller.stepPreference("refreshIntervalSec", 1)).value, 150);
  assert.equal((await controller.stepPreference("refreshIntervalSec", -1)).value, 120);
  // And stops at the ends rather than running past them.
  await controller.setPreference("undoSendSeconds", 0);
  assert.equal((await controller.stepPreference("undoSendSeconds", -1)).value, 0);
  assert.equal((await controller.setPreference("nonsense", 1)).ok, false);
}

// A source the host reports reaches the page; a Google calendar is served by
// its mailbox and carries no remove of its own.
{
  const controller = createSettingsController({
    readAccounts: () => ({ version: 1, activeId: "", accounts: [] }),
    saveAccounts() {},
    configure: async () => {},
    readOauthClient: () => ({ present: true, description: "Omamail desktop client" }),
    readCalendarSources: () => [
      { id: "google:one", kind: "google", name: "Personal" },
      { id: "caldav:family", kind: "caldav", name: "Family", url: "https://example.test/dav/" },
    ],
  });
  const snapshot = controller.snapshot();
  assert.equal(snapshot.oauthClient.present, true);
  assert.equal(snapshot.oauthClient.description, "Omamail desktop client");
  assert.deepEqual(
    snapshot.calendars.sources.map((source) => [source.id, source.removable]),
    [
      ["google:one", false],
      ["caldav:family", true],
    ],
  );
}

// The row's second line is the QML page's, when the host has a status to give.
{
  const controller = createSettingsController({
    readAccounts: () => ({
      version: 1,
      activeId: "one@example.com",
      accounts: [gmail, imap],
    }),
    saveAccounts() {},
    configure: async () => {},
    readAccountStatus: () => ({
      "one@example.com": { signedIn: true, unread: 4 },
      "imap:two@example.com": { signedIn: false },
    }),
  });
  const accounts = controller.snapshot().accounts;
  assert.equal(accounts[0].detail, "4 unread messages · showing now");
  assert.equal(accounts[1].detail, "Signed out");
}

{
  const { controller, heavyMessageWrites, undoSendWrites } = harness();
  assert.deepEqual(await controller.toggleHeavyMessages(true), {
    ok: true,
    enabled: true,
  });
  assert.deepEqual(await controller.setUndoSendSeconds(61), {
    ok: true,
    seconds: 60,
  });
  assert.deepEqual(await controller.setUndoSendSeconds(-1), {
    ok: true,
    seconds: 0,
  });
  assert.deepEqual(heavyMessageWrites, [true]);
  assert.deepEqual(undoSendWrites, [60, 0]);
}

{
  const { controller, remoteImageWrites } = harness({
    initialRemoteImages: true,
  });
  assert.equal(controller.preference("remoteImages"), true);
  assert.deepEqual(await controller.toggleRemoteImages(false), {
    ok: true,
    enabled: false,
  });
  assert.deepEqual(remoteImageWrites, [false]);
  assert.equal(controller.preference("remoteImages"), false);
  assert.equal(controller.snapshot().error, "");
}

{
  const { controller, remoteImageWrites } = harness({
    initialRemoteImages: true,
    failRemoteImages: true,
  });
  const result = await controller.toggleRemoteImages(false);
  assert.equal(result.ok, false);
  assert.equal(
    result.enabled,
    true,
    "failed persistence keeps the prior value",
  );
  assert.match(result.error, /could not be saved/i);
  assert.deepEqual(remoteImageWrites, [false]);
  assert.equal(controller.preference("remoteImages"), true);
  assert.equal(controller.snapshot().busy, false);
  assert.equal(controller.snapshot().error, result.error);
}

{
  const { controller, current } = harness();
  assert.equal(controller.switchAccount(imap.id), true);
  assert.equal(current().activeId, imap.id);
  assert.equal(controller.switchAccount("unknown"), false);
  assert.equal(current().activeId, imap.id);
}

{
  const { controller, current, configured, forgotten, cleared } = harness();
  const confirmation = controller.requestRemoval(imap.id);
  assert.equal(confirmation.accountId, imap.id);
  assert.match(confirmation.title, /two@example\.com/);
  const result = await controller.confirmRemoval(confirmation);
  assert.equal(result.ok, true);
  assert.equal(current().accounts.length, 1);
  assert.equal(current().activeId, gmail.id);
  assert.deepEqual(configured, [[gmail.id]]);
  assert.deepEqual(forgotten, [
    [
      "imap",
      {
        accountId: imap.id,
        imapHost: "imap.example.com",
        imapPort: 993,
        username: "two",
      },
    ],
  ]);
  assert.deepEqual(cleared, [imap.id]);
}

{
  const { controller, current, configured, cleared } = harness({
    failForget: true,
  });
  const result = await controller.confirmRemoval(
    controller.requestRemoval(imap.id),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "Account could not be removed");
  assert.equal(current().accounts.length, 2, "local state is compensated");
  assert.deepEqual(configured, [[gmail.id], [gmail.id, imap.id]]);
  assert.deepEqual(cleared, [], "cache survives a failed removal");
}

{
  let accounts = { version: 1, activeId: gmail.id, accounts: [gmail] };
  const revoked = [];
  const configured = [];
  const controller = createSettingsController({
    readAccounts: () => accounts,
    saveAccounts: (next) => {
      accounts = next;
    },
    configure: async (next) => {
      configured.push(next.map((entry) => entry.id));
    },
    revokeGmail: async (accountId, clientId) => {
      revoked.push([accountId, clientId]);
      return { outcome: "deleted" };
    },
    forgetImap: async () => ({ outcome: "deleted" }),
    clearCache() {},
  });
  const result = await controller.confirmRemoval(
    controller.requestRemoval(gmail.id),
  );
  assert.equal(result.ok, true);
  assert.equal(result.empty, true);
  assert.equal(accounts.activeId, "");
  assert.deepEqual(accounts.accounts, []);
  assert.deepEqual(
    configured,
    [[]],
    "removing the last account replaces native contexts with the empty set",
  );
  assert.deepEqual(
    revoked,
    [[gmail.id, gmail.clientId]],
    "Gmail revocation is exact",
  );
}

{
  const hey = { id: "hey:me@hey.com", email: "me@hey.com", provider: "hey" };
  let accounts = { version: 1, activeId: hey.id, accounts: [hey] };
  let credentialCalls = 0;
  const controller = createSettingsController({
    readAccounts: () => accounts,
    saveAccounts: (next) => {
      accounts = next;
    },
    configure: async () => {},
    revokeGmail: async () => {
      credentialCalls += 1;
    },
    forgetImap: async () => {
      credentialCalls += 1;
    },
    clearCache() {},
  });
  const confirmation = controller.requestRemoval(hey.id);
  assert.match(confirmation.detail, /stays signed in/i);
  assert.equal((await controller.confirmRemoval(confirmation)).ok, true);
  assert.equal(
    credentialCalls,
    0,
    "local HEY removal never performs machine-global logout",
  );
}

console.log("settings controller tests passed");
