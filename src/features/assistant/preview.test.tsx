// The dock as drawn: a conversation and a proposed draft, light and dark.
// On a real platform (`nsh test --target macos`) it saves screenshots to
// .nsh/shots/; headless it checks the same content.
import { expect, open, test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";

const PREVIEW = "./PreviewApp.tsx";

// Headless runs draw nothing: the content checks still run there.
async function shot(app: Awaited<ReturnType<typeof open>>, path: string) {
  try {
    await app.screenshot(path);
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
  }
}

test("the dock shows the chat and the proposal in Ink, Paper and Omarchy, at 14 and 16", async () => {
  const { app, guard } = await openGuarded(PREVIEW, { width: 1100, height: 760 });
  await app.waitFor("Send email");
  await app.waitFor("Subject: Re: Quarterly review");
  await app.waitFor("Proposed reply");
  expect(app.texts().join("\n").includes("Bob asks to move")).toBe(true);
  // The checkbox's box sits on the panel's content edge, with the subject.
  const subject = app.layout("id:agent-proposal-subject")!;
  const box = app.layout("id:agent-proposal-history-box")!;
  expect(box.x).toBe(subject.x);
  // The band under the header is the owner's first message, scrolled up
  // under it (the transcript opens at its end): its top is above the list's.
  const first = app.layout("id:agent-user-message");
  if (first) {
    expect(first.clipped).toBe(true);
    expect(first.y < app.layout("id:agent-transcript-scroll")!.y).toBe(true);
  }
  for (const size of [14, 16]) {
    await app.press("Size " + size);
    for (const theme of ["Ink", "Paper", "Omarchy"]) {
      await app.press(theme);
      await app.wait(150);
      await shot(app, `.nsh/shots/assistant-${theme.toLowerCase()}-${size}.png`);
    }
  }
  await app.press("Size 14");
  await app.press("Ink");
  await app.press("Edit recipients");
  await app.waitFor("Done editing recipients");
  expect(app.texts().join("\n").includes("The sender, recipients or quoted history changed")).toBe(false);
  await shot(app, ".nsh/shots/assistant-ink-recipients.png");
  // Nothing reached the backend, the config files or the system agent.
  assertGuarded(guard);
});
