import { expect, open, test } from "nsh/test";

const PROMPT = "id:analytics-consent-action";
const SETTING = "id:analytics-setting";
const CONSENT_FILE = "fixture.consentFile";
const INSTALL_ID = "nsmetry.uid";
const ENTRY = "./fixtures/ConsentApp.tsx";
const SIZE = { width: 600, height: 400 };

type App = Awaited<ReturnType<typeof open>>;
function batches(app: App): string[] {
  return JSON.parse(app.storage()["fixture.batches"] ?? "[]");
}

test("analytics creates no ID or traffic before consent and remembers refusal", async () => {
  const app = await open(ENTRY, SIZE);
  await app.waitFor(PROMPT);
  await app.setLifecycle("background");
  expect(batches(app)).toEqual([]);
  expect(app.storage()[INSTALL_ID]).toBe(undefined);

  await app.setLifecycle("active");
  await app.press("id:analytics-consent-cancel");
  await app.waitUntil(() => app.storage()[CONSENT_FILE] === "false");
  const relaunched = await open(ENTRY, { ...SIZE, storage: { [CONSENT_FILE]: app.storage()[CONSENT_FILE]! } });
  await relaunched.waitUntil(() => relaunched.accessibility(SETTING)?.disabled === false);
  expect(relaunched.shows(PROMPT)).toBe(false);
  await relaunched.press("role:button[Calendar]");
  await relaunched.setLifecycle("background");
  expect(batches(relaunched)).toEqual([]);
  expect(relaunched.storage()[INSTALL_ID]).toBe(undefined);
});

test("an opt-in that cannot be saved creates no installation ID or batch", async () => {
  const app = await open(ENTRY, { ...SIZE, storage: { "fixture.failConsentWrite": "true" } });
  await app.waitFor(PROMPT);
  await app.press(PROMPT);
  await app.waitFor("text:Could not save the analytics preference");
  await app.setLifecycle("background");
  expect(batches(app)).toEqual([]);
  expect(app.storage()[INSTALL_ID]).toBe(undefined);
});

test("analytics batches only approved fields and discards queued screens on opt-out", async () => {
  const app = await open(ENTRY, { ...SIZE, platform: "macos" });
  await app.waitFor(PROMPT);
  await app.press(PROMPT);
  await app.waitUntil(() => app.accessibility(SETTING)?.checked === "true" && !!app.storage()[INSTALL_ID]);
  await app.press("role:button[Message]");
  await app.press("role:button[Calendar]");
  expect(batches(app)).toEqual([]);
  await app.setLifecycle("background");
  await app.waitUntil(() => batches(app).length === 1);

  const batch = JSON.parse(batches(app)[0]!);
  expect(batch.site).toBe("omamail");
  expect(batch.events.map((event: { url: string }) => event.url)).toEqual(["/mail", "/message", "/calendar"]);
  for (const event of batch.events) {
    expect(Object.keys(event).sort()).toEqual(["app_version", "name", "ts", "ua", "url", "user_id"]);
    expect(event.name).toBe("screen_view");
    expect(event.user_id).toBe(app.storage()[INSTALL_ID]);
    expect(event.ua.startsWith("Omamail/" + event.app_version)).toBe(true);
  }

  await app.setLifecycle("active");
  await app.press("role:button[Message]");
  await app.press(SETTING);
  await app.waitUntil(() => app.storage()[CONSENT_FILE] === "false");
  await app.setLifecycle("background");
  expect(batches(app).length).toBe(1);

  const relaunched = await open(ENTRY, { ...SIZE, storage: { [CONSENT_FILE]: app.storage()[CONSENT_FILE]!, [INSTALL_ID]: app.storage()[INSTALL_ID]! } });
  await relaunched.waitUntil(() => relaunched.accessibility(SETTING)?.disabled === false);
  expect(relaunched.accessibility(SETTING)?.checked).toBe("false");
  await relaunched.setLifecycle("background");
  expect(batches(relaunched)).toEqual([]);
});

test("analytics replaces a malformed installation ID and flushes on the 30 second timer", async () => {
  const app = await open(ENTRY, {
    ...SIZE,
    storage: { [CONSENT_FILE]: "true", [INSTALL_ID]: "jane@example.com" },
    clock: {},
  });
  await app.waitUntil(() => app.accessibility(SETTING)?.checked === "true" && app.storage()[INSTALL_ID] !== "jane@example.com");
  expect(app.shows(PROMPT)).toBe(false);
  await app.wait(28_000);
  expect(batches(app)).toEqual([]);
  await app.wait(2_000);
  await app.waitUntil(() => batches(app).length === 1, { timeout: 500 });
  const event = JSON.parse(batches(app)[0]!).events[0];
  expect(event.user_id).toBe(app.storage()[INSTALL_ID]);
  expect(event.user_id).toMatch(/^[0-9a-f-]{36}$/i);
});
