import { expect, test } from "nsh/test";
import { NATIVE_MEMBERS, assertGuarded, guardNative, openGuardedWith } from "./previewGuard";

test("every native member is stood in for, and unasked calls are recorded", () => {
  const guard = guardNative({ answers: { "Backend.request": () => ({ result: {} }) } });
  const native = guard.modules["omamail-native"] as Record<string, any>;
  for (const member of NATIVE_MEMBERS) expect(member in native).toBe(true);
  expect(native["Backend.os"]).toBe("macos");
  expect(native["Backend.launchMailto"]).toBe(null);
  expect((guardNative({ launchMailto: "mailto:a@example.com" }).modules["omamail-native"] as Record<string, any>)["Backend.launchMailto"]).toBe("mailto:a@example.com");
  expect(() => native["Backend.readConfig"]("credentials.json")).toThrow("preview_guard: Backend.readConfig");
  expect(() => native["Diagnostics.openAgent"]("r")).toThrow();
  native["Backend.request"]("system.info", {});
  expect(guard.calls).toEqual(["Backend.readConfig", "Diagnostics.openAgent"]);
  expect(guard.answered).toEqual(["Backend.request system.info"]);
  expect(() => guard.assertNoCalls()).toThrow();
});

function refusing(onScreenshot: () => Promise<unknown>) {
  const opened: { modules: boolean }[] = [];
  const opener = async (_entry: string, options: { modules?: unknown }) => {
    opened.push({ modules: options.modules !== undefined });
    if (options.modules !== undefined)
      throw Object.assign(new Error("modules: unsupported"), { code: "ERR_NSH_TEST_UNSUPPORTED" });
    return { screenshot: onScreenshot } as any;
  };
  return { opener, opened };
}

test("a refusal of stand-ins on a headless run fails closed", async () => {
  const { opener, opened } = refusing(() => Promise.reject(new Error("screenshots need a real platform")));
  let failure = "";
  try {
    await openGuardedWith(opener, "./App.tsx");
  } catch (error) {
    failure = String((error as Error).message);
  }
  expect(failure).toContain("preview_guard: the runtime refused native stand-ins on a headless run");
  expect(opened).toEqual([{ modules: true }, { modules: false }]);
});

test("a refusal on a real platform opens unguarded and says so", async () => {
  const { opener } = refusing(() => Promise.resolve(new Uint8Array()));
  const { guard } = await openGuardedWith(opener, "./App.tsx");
  expect(guard.guarded).toBe(false);
  assertGuarded(guard);
});

test("other open failures are not swallowed", async () => {
  const opener = async () => {
    throw Object.assign(new Error("boom"), { code: "ERR_OTHER" });
  };
  let failure = "";
  try {
    await openGuardedWith(opener as any, "./App.tsx");
  } catch (error) {
    failure = String((error as Error).message);
  }
  expect(failure).toBe("boom");
});

test("a guarded open checks calls, and no guard fails", async () => {
  const opener = async () => ({ screenshot: () => Promise.reject(new Error("headless")) }) as any;
  const { guard } = await openGuardedWith(opener, "./App.tsx");
  expect(guard.guarded).toBe(true);
  assertGuarded(guard);
  expect(() => (guard.modules["omamail-native"] as Record<string, any>)["Backend.shutdown"]()).toThrow();
  expect(() => assertGuarded(guard)).toThrow();
  expect(() => assertGuarded(null)).toThrow("preview_guard: no guard");
});
