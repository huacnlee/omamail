// Node's `assert`, as the ported omarchy/ui/tests cases call it, over
// nsh/test's `expect`. The messages the originals pass are kept as the
// reason a check failed.
import { expect } from "nsh/test";

function plain(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function explain(message: unknown, check: () => void) {
  try {
    check();
  } catch (error) {
    if (message === undefined) throw error;
    throw new Error(String(message) + ": " + String((error as Error)?.message ?? error));
  }
}

export const assert = {
  strictEqual(actual: unknown, expected: unknown, message?: unknown) {
    explain(message, () => expect(actual).toBe(expected));
  },
  equal(actual: unknown, expected: unknown, message?: unknown) {
    // eslint-disable-next-line eqeqeq
    explain(message, () => expect(actual == expected).toBe(true));
  },
  notStrictEqual(actual: unknown, expected: unknown, message?: unknown) {
    explain(message, () => expect(actual !== expected).toBe(true));
  },
  deepStrictEqual(actual: unknown, expected: unknown, message?: unknown) {
    explain(message, () => expect(plain(actual)).toEqual(plain(expected)));
  },
  ok(value: unknown, message?: unknown) {
    explain(message, () => expect(!!value).toBe(true));
  },
  match(value: string, pattern: RegExp, message?: unknown) {
    explain(message, () => expect(value).toMatch(pattern));
  },
  doesNotMatch(value: string, pattern: RegExp, message?: unknown) {
    explain(message, () => expect(pattern.test(value)).toBe(false));
  },
  throws(run: () => unknown, message?: unknown) {
    explain(message, () => expect(run).toThrow());
  },
};

export const deepEqual = assert.deepStrictEqual;
