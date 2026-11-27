import { expect, test } from "nsh/test";
import { BODY_SIZE, bodyFontSize, readingMeasure } from "./Body";

test("the body's type follows Omarchy's base size and the zoom together", () => {
  expect(bodyFontSize(1)).toBe(BODY_SIZE);
  // Message text is 15 on 24 at base 14.
  expect(BODY_SIZE).toBe(15);
  expect(Math.round(BODY_SIZE * 1.6)).toBe(24);
  // A base already scaled (16), at 1x and 1.2x
  expect(bodyFontSize(1, 16)).toBe(16);
  expect(bodyFontSize(1.2, 16)).toBe(19);
  expect(bodyFontSize(0.1, 16)).toBe(7);
  // The reading column widens with the type.
  expect(readingMeasure(bodyFontSize(1, 16))).toBeGreaterThan(readingMeasure(bodyFontSize(1)));
});
