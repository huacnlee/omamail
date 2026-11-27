// Port of ui/tests/test_agent_options.js.
import { expect, test } from "nsh/test";
import { AGENTS, startOptions } from "./options";

const payload = { messageId: "synthetic", prompt: "Question" };

test("System default needs no provider and no API gate", () => {
  expect(startOptions(payload, "System default", "", 5)).toEqual({ params: { payload } });
});

test("a chosen agent and model pass through on API 6 and need it", () => {
  for (const [label, provider] of [["OpenCode", "opencode"], ["Codex", "codex"], ["Claude", "claude"]]) {
    expect(startOptions(payload, label, "test/model#variant", 6)).toEqual({ params: { payload, provider, model: "test/model#variant" } });
    expect(typeof startOptions(payload, label, "", 5).error).toBe("string");
  }
  expect(typeof startOptions(payload, "System default", "selected", 5).error).toBe("string");
});

test("a model that could be read as a flag or a command is refused", () => {
  for (const model of ["--auto", "a b", "a\nb", "a\u0000b", "$(touch /tmp/forbidden)", "x".repeat(201)]) {
    expect(typeof startOptions(payload, "OpenCode", model, 6).error).toBe("string");
  }
});

test("a follow-up keeps its parent's provider and model", () => {
  const parent = { parent: "11111111111111111111111111111111", prompt: "Follow-up" };
  for (const input of [parent, JSON.stringify(parent)]) {
    expect(startOptions(input, "Codex", "new-model", 5)).toEqual({ params: { payload: input } });
  }
});

test("the choices match the settings schema", () => {
  expect([...AGENTS]).toEqual(["System default", "OpenCode", "Codex", "Claude"]);
});
