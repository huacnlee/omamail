import { expect, test } from "nsh/test";
import * as diagnostics from "./diagnostics";

test("only the known vocabulary survives", () => {
  expect(diagnostics.clean({ provider: "google", operation: "create", reason: "invalid", httpStatus: 400, field: "start", extra: "x" }))
    .toEqual({ provider: "google", operation: "create", reason: "invalid", httpStatus: 400, field: "start" });
  expect(diagnostics.clean({ provider: "evil<script>", httpStatus: 99.5 })).toEqual({});
  expect(diagnostics.clean(null)).toEqual({});
  expect(diagnostics.summary({ provider: "google", operation: "create", stage: "response", httpStatus: 400, reason: "invalid", field: "start" }))
    .toBe("Google · create · response · HTTP 400 · invalid · start");
  expect(diagnostics.summary({ provider: "microsoft", stage: "request" })).toBe("Microsoft");
});

test("errors are kept short, deduplicated and bounded", () => {
  diagnostics.clearErrors();
  diagnostics.record("mail.list", { code: -32000, message: "boom" }, 1000);
  diagnostics.record("mail.list", { code: -32000, message: "boom" }, 2000);
  expect(diagnostics.recentErrors().length).toBe(1);
  diagnostics.record("mail.list", { code: -32000, message: "boom" }, 20000);
  expect(diagnostics.recentErrors().length).toBe(2);
  diagnostics.record("mail.get", { code: 1, message: "x".repeat(200) }, 30000);
  expect(diagnostics.recentErrors()[2].error.message).toBe("unknown_error");
  diagnostics.record("calendar.request", { code: 2, message: "bad", data: { provider: "google", secret: "s" } }, 40000);
  expect(diagnostics.recentErrors()[3].error.data).toEqual({ provider: "google" });
  for (let i = 0; i < 40; i++) diagnostics.record("m" + i, { code: i, message: "e" }, 50000 + i);
  expect(diagnostics.recentErrors().length).toBe(32);
});
