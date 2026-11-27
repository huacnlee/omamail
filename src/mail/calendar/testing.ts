// Node's `assert` as the ported Qt tests use it, on nsh/test's `expect`, so
// their bodies stay as they were written for the Qt client.
import { expect } from "nsh/test";

function plain(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function check(pass: boolean, message: unknown, detail: string): void {
  if (!pass) throw new Error((message ? String(message) + ": " : "") + detail);
}

function show(value: unknown): string {
  try { return JSON.stringify(value); } catch (e) { return String(value); }
}

export const assert = {
  ok(value: unknown, message?: unknown): void {
    check(!!value, message, "expected a truthy value, got " + show(value));
  },
  equal(actual: unknown, expected: unknown, message?: unknown): void {
    // eslint-disable-next-line eqeqeq
    check(actual == expected, message, show(actual) + " == " + show(expected));
  },
  strictEqual(actual: unknown, expected: unknown, message?: unknown): void {
    check(Object.is(actual, expected), message, show(actual) + " === " + show(expected));
  },
  notStrictEqual(actual: unknown, expected: unknown, message?: unknown): void {
    check(!Object.is(actual, expected), message, show(actual) + " !== " + show(expected));
  },
  deepStrictEqual(actual: unknown, expected: unknown, message?: unknown): void {
    if (message === undefined) { expect(actual).toEqual(expected); return; }
    check(show(plain(actual)) === show(plain(expected)), message, show(actual) + " deep equals " + show(expected));
  },
  match(actual: string, pattern: RegExp, message?: unknown): void {
    check(pattern.test(String(actual)), message, show(actual) + " matches " + String(pattern));
  },
  throws(fn: () => unknown, _expected?: unknown, message?: unknown): void {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    check(threw, message, "expected it to throw");
  },
};

export function deepEqual(actual: unknown, expected: unknown, message?: unknown): void {
  check(show(plain(actual)) === show(plain(expected)), message, show(actual) + " deep equals " + show(expected));
}
