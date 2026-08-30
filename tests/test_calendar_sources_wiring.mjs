import assert from "node:assert/strict";
import {
  addCalDavCalendar,
  availableCalendarSources,
  bindCalendarSources,
  calendarSourceModel,
  readCalendarSources,
  removeCalendar,
  saveCalendarPassword,
  setCalendarColor,
  setCalendarEnabled,
} from "../app/application/calendar-sources.js";
import { createSettingsController } from "../app/settings/controller.js";
import { renderSettings } from "../app/ui/settings.js";

const cx = {
  theme: () => ({
    colors: new Proxy({}, { get: (_, key) => String(key) }),
    spacing: { xs: 1, sm: 1, md: 1, lg: 1, xl: 1 },
    radius: { sm: 1 },
  }),
};

function find(node, id) {
  if (node?.elementId === id) return node;
  for (const child of node?.childNodes || []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const CALDAV = {
  id: "caldav:nextcloud-example-remote-php-dav-calendars-me-personal",
  kind: "caldav",
  name: "Personal",
  url: "https://nextcloud.example/remote.php/dav/calendars/me/personal/",
  username: "me",
  remoteCalendarId: "",
  accountId: "",
  enabled: true,
  readOnly: false,
  colorKey: "blue",
};

/**
 * A host that answers the way `src/calendar_store.rs` does: it keeps the text
 * it was given and hands it back, so the window is tested against the answer
 * it will really get rather than against the payload it sent.
 */
function fakeHost(initial = { version: 1, sources: [] }) {
  const host = {
    text: `${JSON.stringify(initial)}\n`,
    requests: [],
    refuse: "",
    dispatch: async (json) => {
      const request = JSON.parse(json);
      host.requests.push(request);
      if (host.refuse) return JSON.stringify({ ok: false, error: host.refuse });
      if (request.operation === "calendars.read")
        return JSON.stringify({ ok: true, text: host.text });
      if (request.operation === "calendars.write") {
        // The real host rebuilds the list out of the fields a source has, so
        // nothing else in the payload survives the round trip.
        const list = JSON.parse(request.payload);
        host.text = `${JSON.stringify({
          version: 1,
          sources: list.sources.map((source) => ({
            id: source.id,
            kind: source.kind,
            name: source.name,
            url: source.url,
            username: source.username,
            remoteCalendarId: source.remoteCalendarId,
            accountId: source.accountId,
            enabled: source.enabled,
            readOnly: source.readOnly,
            colorKey: source.colorKey,
          })),
        })}\n`;
        return JSON.stringify({ ok: true, text: host.text });
      }
      if (request.operation === "calendars.savePassword")
        return JSON.stringify({ ok: true });
      return JSON.stringify({ ok: false, error: "unknown operation" });
    },
  };
  return host;
}

function makeApp(host, accounts = []) {
  const app = {
    calendarSources: [],
    accountList: { accounts, activeId: accounts[0]?.id ?? "" },
    omarchyColors: "color4 = \"#4444ff\"\n",
    configured: [],
    configureNativeHost: async (list, sources) => {
      app.configured.push(sources.map((source) => source.id));
    },
    calendar: { refreshed: 0, refresh() { this.refreshed += 1; } },
  };
  bindCalendarSources(app, null, host.dispatch);
  return app;
}

const written = (host) =>
  host.requests.filter((request) => request.operation === "calendars.write");

// The gap this exists to close: the window's calendar list is what the file
// holds, not the empty array nothing ever filled.
{
  const host = fakeHost({ version: 1, sources: [CALDAV] });
  const app = makeApp(host);
  await readCalendarSources(app);
  assert.deepEqual(host.requests[0], { operation: "calendars.read" });
  assert.equal(app.calendarSources.length, 1);
  assert.equal(app.calendarSources[0].id, CALDAV.id);
  assert.equal(app.calendarSources[0].colorKey, "blue");
  // And the host is told which calendars it may talk to, or every read of one
  // is refused for having no context.
  assert.deepEqual(app.configured.at(-1), [CALDAV.id]);
}

// A signed-in Google mailbox brings its calendar without anybody writing it
// down, which is what `withGoogleAccounts` is for.
{
  const host = fakeHost();
  const app = makeApp(host, [
    { id: "someone@example.com", email: "someone@example.com", provider: "gmail" },
  ]);
  await readCalendarSources(app);
  const available = availableCalendarSources(app);
  assert.equal(available.length, 1);
  assert.equal(available[0].id, "google:someone@example.com");
  assert.equal(available[0].kind, "google");
  assert.equal(app.calendarSources.length, 0, "and it is not written down yet");
  assert.deepEqual(app.configured.at(-1), ["google:someone@example.com"]);
}

// A read that failed is not a list. Writing after one would publish an empty
// file over a configured one, so nothing is written at all.
{
  const host = fakeHost({ version: 1, sources: [CALDAV] });
  const app = makeApp(host);
  host.refuse = "Could not save the calendar";
  await readCalendarSources(app);
  assert.equal(app.calendarSourceForm.loaded, false);
  host.refuse = "";
  const result = await setCalendarEnabled(app, CALDAV.id, false, null);
  assert.equal(result.ok, false);
  assert.equal(written(host).length, 0);
}

// Switching a calendar off is a write of the whole list, and the grid is asked
// for again because a disabled calendar is not read.
{
  const host = fakeHost({ version: 1, sources: [CALDAV] });
  const app = makeApp(host);
  await readCalendarSources(app);
  const before = app.calendar.refreshed;
  await setCalendarEnabled(app, CALDAV.id, false, null);
  assert.equal(app.calendarSources[0].enabled, false);
  assert.equal(app.calendar.refreshed, before + 1);
  await setCalendarEnabled(app, CALDAV.id, true, null);
  assert.equal(app.calendarSources[0].enabled, true);
}

// Recolouring one writes the key and does not re-read the range: the events on
// the grid are the same events in a different colour.
{
  const host = fakeHost({ version: 1, sources: [CALDAV] });
  const app = makeApp(host);
  await readCalendarSources(app);
  const before = app.calendar.refreshed;
  await setCalendarColor(app, CALDAV.id, "green", null);
  assert.equal(app.calendarSources[0].colorKey, "green");
  assert.equal(app.calendar.refreshed, before);
  // A key the palette does not name changes nothing.
  await setCalendarColor(app, CALDAV.id, "puce", null);
  assert.equal(app.calendarSources[0].colorKey, "green");
}

// Changing a Google calendar is what writes it down, exactly as
// `setSourceEnabled` does in the QML controller.
{
  const host = fakeHost();
  const app = makeApp(host, [
    { id: "someone@example.com", email: "someone@example.com", provider: "gmail" },
  ]);
  await readCalendarSources(app);
  await setCalendarEnabled(app, "google:someone@example.com", false, null);
  assert.equal(app.calendarSources.length, 1);
  assert.equal(app.calendarSources[0].id, "google:someone@example.com");
  assert.equal(app.calendarSources[0].enabled, false);
}

{
  const host = fakeHost({ version: 1, sources: [CALDAV] });
  const app = makeApp(host);
  await readCalendarSources(app);
  await removeCalendar(app, CALDAV.id, null);
  assert.equal(app.calendarSources.length, 0);
}

// Adding one: `Sources.validate`'s refusals are the page's refusals, and a
// refused calendar is never written.
{
  const host = fakeHost();
  const app = makeApp(host);
  await readCalendarSources(app);
  const insecure = await addCalDavCalendar(
    app,
    { name: "Personal", url: "http://nextcloud.example/dav/", username: "me" },
    "hunter2",
    null,
  );
  assert.equal(insecure.ok, false);
  assert.equal(insecure.error, "Use an HTTPS CalDAV calendar address");
  const unnamed = await addCalDavCalendar(
    app,
    { name: "", url: "https://nextcloud.example/dav/", username: "me" },
    "hunter2",
    null,
  );
  assert.equal(unnamed.error, "Add a calendar name");
  const secretless = await addCalDavCalendar(
    app,
    { name: "Personal", url: "https://nextcloud.example/dav/", username: "me" },
    "",
    null,
  );
  assert.equal(secretless.error, "Add the calendar password");
  assert.equal(written(host).length, 0);
  assert.equal(app.calendarSources.length, 0);
}

// The one property the whole arrangement exists for: the password goes to the
// keyring in a request of its own, and nothing that is written to the file has
// ever carried it.
{
  const host = fakeHost();
  const app = makeApp(host);
  await readCalendarSources(app);
  const added = await addCalDavCalendar(
    app,
    {
      name: "Personal",
      url: "https://nextcloud.example/remote.php/dav/calendars/me/personal/",
      username: "me",
    },
    "hunter2",
    null,
  );
  assert.equal(added.ok, true);
  assert.equal(app.calendarSources.length, 1);
  assert.equal(app.calendarSources[0].id, CALDAV.id);
  assert.equal(app.calendarSources[0].username, "me");

  const writes = written(host);
  assert.equal(writes.length, 1);
  assert.ok(!writes[0].payload.includes("hunter2"));
  assert.ok(!writes[0].payload.includes("password"));
  assert.ok(!host.text.includes("hunter2"));

  const secrets = host.requests.filter(
    (request) => request.operation === "calendars.savePassword",
  );
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].sourceId, CALDAV.id);
  assert.equal(secrets[0].password, "hunter2");
  // The list is written first, so a password is never stored for a calendar
  // nothing lists.
  assert.ok(
    host.requests.indexOf(writes[0]) < host.requests.indexOf(secrets[0]),
  );
}

// Setting the password on a calendar that is already listed touches only the
// keyring.
{
  const host = fakeHost({ version: 1, sources: [CALDAV] });
  const app = makeApp(host);
  await readCalendarSources(app);
  const empty = await saveCalendarPassword(app, CALDAV.id, "", null);
  assert.equal(empty.ok, false);
  assert.equal(empty.error, "Enter the calendar password");
  const saved = await saveCalendarPassword(app, CALDAV.id, "hunter2", null);
  assert.equal(saved.ok, true);
  assert.equal(written(host).length, 0);
}

// A host that refuses says so on the page rather than throwing at the window.
{
  const host = fakeHost({ version: 1, sources: [CALDAV] });
  const app = makeApp(host);
  await readCalendarSources(app);
  host.refuse = "Could not save the calendar";
  const result = await removeCalendar(app, CALDAV.id, null);
  assert.equal(result.ok, false);
  assert.equal(app.calendarSourceForm.result, "Could not save the calendar");
  assert.equal(app.calendarSources.length, 1, "and the list is left alone");
}

// The settings page draws a row per calendar, with the controls the QML
// controller's operations need and no colour-only state.
{
  const host = fakeHost({ version: 1, sources: [CALDAV] });
  const app = makeApp(host);
  await readCalendarSources(app);
  const settings = createSettingsController({
    readPreference: () => null,
    savePreference: () => {},
    readAccounts: () => ({ accounts: [], activeId: "" }),
    saveAccounts: () => {},
    configure: async () => {},
    readCalendarSources: () => availableCalendarSources(app),
  });
  const snapshot = settings.snapshot();
  assert.equal(snapshot.calendars.sources[0].enabled, true);
  assert.equal(snapshot.calendars.sources[0].colorKey, "blue");
  assert.equal(snapshot.calendars.sources[0].removable, true);
  assert.ok(snapshot.calendars.sources[0].colorKeys.includes("green"));

  const model = { ...snapshot, ...calendarSourceModel(app) };
  const page = renderSettings(model, cx);
  for (const id of [
    `settings-calendar-${CALDAV.id}`,
    `settings-calendar-enabled-${CALDAV.id}`,
    `settings-calendar-color-${CALDAV.id}`,
    `settings-calendar-color-${CALDAV.id}-green`,
    `settings-calendar-password-${CALDAV.id}`,
    `settings-calendar-remove-${CALDAV.id}`,
    "settings-add-calendar",
  ])
    assert.ok(find(page, id), `${id} is drawn`);
  assert.equal(
    find(page, `settings-calendar-enabled-${CALDAV.id}`).accessibilityRole,
    "switch",
  );
  assert.equal(
    find(page, `settings-calendar-color-${CALDAV.id}`).accessibilityRole,
    "radio_group",
  );
  // The add form is the button's answer, not something that is always there.
  assert.equal(find(page, "settings-calendar-new"), null);
  model.onCalendarAdd(null);
  const adding = renderSettings({ ...model, ...calendarSourceModel(app) }, cx);
  assert.ok(find(adding, "settings-calendar-new-url"));
  assert.ok(find(adding, "settings-calendar-save"));
  assert.equal(find(adding, "settings-add-calendar"), null);

  // And the password field only under the calendar it was asked for.
  model.onCalendarAddCancel(null);
  model.onCalendarPassword(CALDAV.id, null);
  const editing = renderSettings({ ...model, ...calendarSourceModel(app) }, cx);
  assert.ok(find(editing, `settings-calendar-password-field-${CALDAV.id}`));
  assert.ok(find(editing, `settings-calendar-password-save-${CALDAV.id}`));
}

console.log("calendar source wiring tests passed");
