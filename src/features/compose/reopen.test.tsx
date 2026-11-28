// A saved draft reopened by its id alone is read from its mailbox. Saving
// replaces the saved copy only once the composer holds all of it: a save made
// while the draft or its files are still being read, or after the user typed
// over the wait, makes a new draft. Synthetic mailbox only.
import { expect, test, type App } from "nsh/test";
import { openGuarded } from "../../testing/previewGuard";

async function start() {
  const { app } = await openGuarded("./fixtures/ReopenApp.tsx", { width: 1100, height: 800, platform: "linux" });
  await app.waitFor("id:probe");
  await app.press("id:load-accounts");
  return app;
}

function probe(app: App): string {
  return app.texts().find((t) => t.startsWith("saved=")) ?? "";
}

/** Back → Save draft; the draft id the provider save carried. */
async function save(app: App): Promise<string> {
  await app.press("id:compose-back");
  await app.press("id:compose-exit-save");
  await app.waitUntil(() => !probe(app).startsWith("saved=[none]"));
  return probe(app).replace(/^saved=\[([^\]]*)\].*$/, "$1");
}

test("read untouched, saving it replaces the copy it came from", async () => {
  const app = await start();
  await app.press("id:reopen");
  await app.waitUntil(() => app.value("id:compose-body") === "Saved body");
  await app.type("id:compose-body", " and more");
  expect(await save(app)).toBe("7:Drafts");
});

test("text typed while the draft is read stays, and saving it leaves the saved copy", async () => {
  const app = await start();
  await app.press("id:hold-read");
  await app.press("id:reopen");
  await app.type("id:compose-body", "New words");
  await app.press("id:release-read");
  await app.waitUntil(() => app.value("id:compose-subject") === "Saved subject");
  expect(app.value("id:compose-body")).toBe("New words");
  expect(await save(app)).toBe("");
});

test("saving before the draft is read leaves the saved copy", async () => {
  const app = await start();
  await app.press("id:hold-read");
  await app.press("id:reopen");
  await app.type("id:compose-subject", "Changed");
  expect(await save(app)).toBe("");
});

test("saving before the draft's files arrive leaves the saved copy with them", async () => {
  const app = await start();
  await app.press("id:with-file");
  await app.press("id:reopen");
  await app.waitUntil(() => probe(app).includes("loading=true"));
  await app.type("id:compose-body", " and more");
  expect(await save(app)).toBe("");
});

test("a draft whose file could not be read does not replace the saved copy that has it", async () => {
  const app = await start();
  await app.press("id:with-file");
  await app.press("id:reopen");
  await app.waitUntil(() => probe(app).includes("loading=true"));
  await app.press("id:fail-file");
  await app.waitUntil(() => probe(app).includes("loading=false"));
  await app.type("id:compose-body", " and more");
  expect(await save(app)).toBe("");
});

test("a recovery record written while the draft's files load carries no link to the saved copy", async () => {
  const app = await start();
  await app.press("id:with-file");
  await app.press("id:reopen");
  await app.waitUntil(() => probe(app).includes("loading=true"));
  await app.type("id:compose-body", " and more");
  await app.waitUntil(() => probe(app).includes("typed=true"));
  expect(probe(app)).toContain("recovered=[]");
});

test("Retry after a draft's file failed reads it again, and the draft can be sent and saved in place", async () => {
  const app = await start();
  await app.press("id:with-file");
  await app.press("id:reopen");
  await app.waitUntil(() => probe(app).includes("loading=true"));
  await app.press("id:fail-file");
  await app.waitFor("text:Retry");
  expect(probe(app)).toContain("send=false");
  await app.press("text:Retry");
  await app.waitUntil(() => probe(app).includes("loading=true"));
  await app.press("id:release-file");
  await app.waitUntil(() => probe(app).includes("loading=false send=true"));
  await app.type("id:compose-body", " and more");
  expect(await save(app)).toBe("7:Drafts");
});

test("a draft moved to another mailbox while its files load is not linked to the first mailbox's copy", async () => {
  const app = await start();
  await app.press("id:with-file");
  await app.press("id:reopen");
  await app.waitUntil(() => probe(app).includes("loading=true"));
  await app.press("id:from-jane");
  await app.press("id:release-file");
  await app.waitUntil(() => probe(app).includes("loading=false"));
  await app.type("id:compose-body", " and more");
  expect(await save(app)).toBe("");
});

test("a file attached while the draft's files load is kept beside them", async () => {
  const app = await start();
  await app.press("id:with-file");
  await app.press("id:reopen");
  await app.waitUntil(() => probe(app).includes("loading=true"));
  await app.press("id:attach-note");
  await app.press("id:release-file");
  await app.waitUntil(() => probe(app).includes("loading=false"));
  expect(probe(app)).toContain("files=plan.pdf,notes.txt");
});
