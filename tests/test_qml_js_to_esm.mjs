import assert from "node:assert/strict";

import { convertQmlLibrary } from "../scripts/qml-js-to-esm.mjs";

const source = `.pragma library

.import "Other.js" as Other

var VALUE = 3
var rows = [
  1,
  2
]

function doubled(value) {
  return Other.scale(value) * VALUE
}
`;

assert.equal(
  convertQmlLibrary(source),
  `// @ts-nocheck -- mechanically generated from the QML library during migration.

import * as Other from "./Other.js"

var VALUE = 3
var rows = [
  1,
  2
]

function doubled(value) {
  return Other.scale(value) * VALUE
}

export { VALUE, rows, doubled }
`,
);

assert.throws(
  () => convertQmlLibrary("function duplicate() {}\nvar duplicate = 1\n"),
  /duplicate top-level declaration/,
);

assert.equal(
  convertQmlLibrary(`.pragma library
// @ts-check

function identity(value) { return value }
`),
  `// @ts-check

/**
 * @param {any} value
 * @returns {any}
 */
function identity(value) { return value }

export { identity }
`,
  "explicitly checked source modules must not be generated with @ts-nocheck",
);

console.log("qml-js-to-esm tests passed");
