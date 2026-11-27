// The assistant's view of compose: a proposal never changes routing, and one
// whose routing no longer matches the editor is refused.
import { expect, test } from "nsh/test";
import { composer, routingChanged } from "./assistantHost";
import { compose, openCompose, update } from "./store";

test("applying a proposal changes the subject and text, never the recipients", () => {
  openCompose({ accountId: "jane@example.com", to: "ann@example.net" });
  const fields = composer.fields()!;
  expect(fields.draftKey).toBe(compose.draft().draftKey);
  const envelope = { ...fields.envelope!, to: "attacker@evil.test", subject: "Plans", body: "Noon works." };
  expect(composer.applyProposal(envelope, "p", "j")).toBe(true);
  expect(compose.draft().subject).toBe("Plans");
  expect(compose.draft().body).toBe("Noon works.");
  expect(compose.draft().to).toBe("ann@example.net, ");
});

test("a proposal for another draft is not applied", () => {
  openCompose({ accountId: "jane@example.com" });
  const envelope = { ...composer.fields()!.envelope!, draftKey: "someone-else", subject: "X" };
  expect(composer.applyProposal(envelope, "p", "j")).toBe(false);
  expect(compose.draft().subject).toBe("");
});

test("routing changed after the proposal: sending it is refused", async () => {
  openCompose({ accountId: "jane@example.com", to: "ann@example.net" });
  const envelope = composer.fields()!.envelope!;
  expect(routingChanged(envelope)).toBe(false);
  update({ to: "bob@example.org, " });
  expect(routingChanged(envelope)).toBe(true);
  const result = await composer.sendProposal(envelope, "agent-x", "job");
  expect(result.ok).toBe(false);
});
