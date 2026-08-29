import assert from "node:assert/strict";

import { mailLayout } from "../app/ui/layout.js";

assert.deepEqual(mailLayout(719), {
  mode: "single",
  showList: true,
  showReader: false,
});
assert.deepEqual(mailLayout(720), {
  mode: "split",
  showList: true,
  showReader: true,
});
assert.deepEqual(mailLayout(1024), {
  mode: "split",
  showList: true,
  showReader: true,
});
assert.deepEqual(mailLayout(500, true), {
  mode: "single",
  showList: false,
  showReader: true,
});

console.log("mail UI layout tests passed");
