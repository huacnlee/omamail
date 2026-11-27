import { expect, test } from "nsh/test";
import { nextSelectable } from "./menuCursor";

test("the cursor skips what cannot be chosen and wraps", () => {
  const rows = [{}, { visible: false }, { enabled: false }, {}, {}];
  expect(nextSelectable(rows, -1, 1)).toBe(0);
  expect(nextSelectable(rows, -1, -1)).toBe(4);
  expect(nextSelectable(rows, 0, 1)).toBe(3);
  expect(nextSelectable(rows, 3, -1)).toBe(0);
  expect(nextSelectable(rows, 4, 1)).toBe(0);
  expect(nextSelectable(rows, 0, -1)).toBe(4);
  expect(nextSelectable([{ enabled: false }], -1, 1)).toBe(-1);
  expect(nextSelectable([], 0, 1)).toBe(-1);
});
