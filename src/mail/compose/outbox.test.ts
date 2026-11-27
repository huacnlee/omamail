import { expect, test } from "nsh/test";
import { normalizeDelay } from "./outbox";

test("the undo window is ten seconds by default and at most a minute", () => {
  expect(normalizeDelay(undefined)).toBe(10);
  expect(normalizeDelay(null)).toBe(10);
  expect(normalizeDelay("not a number")).toBe(10);
  expect(normalizeDelay(0)).toBe(0);
  expect(normalizeDelay(17.9)).toBe(17);
  expect(normalizeDelay(-4)).toBe(0);
  expect(normalizeDelay(90)).toBe(60);
});
