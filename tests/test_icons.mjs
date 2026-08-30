import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ICON_DIRECTORY,
  IconPath,
  documents,
  iconNames as generatedNames,
  variantNames,
} from "../scripts/build-icons.mjs";
import { icon, iconAsset, iconNames } from "../app/ui/icons.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// gpui roots its assets at `app/`, the directory holding `gpui-shell.json`, so
// the files live there and a caller's `assets/icons/<name>.svg` finds them.
const directory = join(root, ICON_DIRECTORY);
const read = (/** @type {string} */ name) =>
  readFileSync(join(directory, `${name}.svg`), "utf8");

// The QML is the source the set is ported from, so it decides what the set is.
// Everything else — the generator's list, the module's list, the files on disk
// — is held to it, and adding a glyph to `ActionIcon` fails here until it has
// been drawn in all three.
const qml = readFileSync(join(root, "components", "ActionIcon.qml"), "utf8");
const drawn = [
  ...new Set(
    [...qml.matchAll(/root\.name === "([A-Za-z]+)"/g)].map((match) => match[1]),
  ),
];
assert.equal(drawn.length, 33);
assert.deepEqual([...drawn].sort(), [...iconNames].sort());
assert.deepEqual([...drawn].sort(), [...generatedNames].sort());

// A name a caller can ask for is a file that is there, and the working tree
// holds what the generator would write now: an edit to the drawing that was
// never built is an icon nobody would see change.
const files = documents();
for (const name of [...iconNames, ...variantNames]) {
  assert.equal(
    read(name),
    files[name],
    `${name}.svg is not what the generator writes`,
  );
}
assert.deepEqual(
  readdirSync(directory).sort(),
  [...iconNames, ...variantNames].map((name) => `${name}.svg`).sort(),
);

// The theme paints these, so no file may name a colour of its own, and the
// stroke has to be the one weight the whole set is drawn at.
for (const name of [...iconNames, ...variantNames]) {
  const source = read(name);
  assert.match(source, /viewBox="0 0 16 16"/, name);
  assert.match(source, /stroke="currentColor"/, name);
  assert.match(source, /stroke-width="1\.4"/, name);
  assert.match(source, /stroke-linecap="round"/, name);
  assert.match(source, /stroke-linejoin="round"/, name);
  assert.match(source, /^<svg [^>]*><path d="[^"]+"\/><\/svg>\n$/, name);
  assert.doesNotMatch(
    source,
    /#[0-9A-Fa-f]{3}/,
    `${name} names a literal colour`,
  );
}
assert.match(read("star"), /fill="none"/);
assert.match(read("star-filled"), /fill="currentColor"/);
// The two halves of the Gmail mark are separate files because gpui paints an
// SVG in one colour; together they are the whole glyph.
assert.equal(
  read("gmail").match(/d="([^"]+)"/)?.[1],
  `${read("gmail-envelope").match(/d="([^"]+)"/)?.[1]}${read("gmail-mark").match(/d="([^"]+)"/)?.[1]}`,
);

// The arc conversion, which is the part of the translation with anything to
// get wrong. A quarter, a whole circle and an anticlockwise quarter, each
// checked as a string and as the geometry the string describes.
const path = (/** @type {(p: IconPath) => void} */ draw) => {
  const built = new IconPath();
  draw(built);
  return String(built);
};

// Quarter, clockwise: reply's tail. One segment, sweep flag 1, ending a
// quarter turn on from (9, 7.5) — at the angle 0 point of its circle.
assert.equal(
  path((p) => p.arc(9, 12, 4.5, -Math.PI / 2, 0)),
  "M9 7.5A4.5 4.5 0 0 1 13.5 12",
);

// A whole circle cannot be one SVG arc, so it is two half turns that end where
// the first began: eye's pupil.
assert.equal(
  path((p) => p.arc(8, 8, 2.2, 0, Math.PI * 2)),
  "M10.2 8A2.2 2.2 0 0 1 5.8 8A2.2 2.2 0 0 1 10.2 8",
);

// Anticlockwise, which is sweep flag 0 and the same two points the other way
// round: forward's tail, the mirror of reply's.
assert.equal(
  path((p) => p.arc(7, 12, 4.5, Math.PI * 1.5, Math.PI, true)),
  "M7 7.5A4.5 4.5 0 0 0 2.5 12",
);

// The turn is however much of the circle it takes to reach the end angle in
// the direction asked for, not the difference between the two angles: this is
// three quarters clockwise, and reading it as a quarter is the mistake the
// case exists to catch.
// (Two segments of 135°, because a turn is split evenly into pieces of at most
// half a circle rather than into half turns and a remainder.)
assert.equal(
  path((p) => p.arc(8, 8, 5, 0, -Math.PI / 2)),
  "M13 8A5 5 0 0 1 4.4645 11.5355A5 5 0 0 1 8 3",
);

// An arc starts wherever its own start angle is, joined to whatever the subpath
// had — a line when that is somewhere else, nothing when it is already there.
assert.equal(
  path((p) => p.moveTo(0, 0).arc(8, 8, 4, 0, Math.PI)),
  "M0 0L12 8A4 4 0 0 1 4 8",
);
assert.equal(
  path((p) => p.moveTo(12, 8).arc(8, 8, 4, 0, Math.PI)),
  "M12 8A4 4 0 0 1 4 8",
);

// Three glyphs end to end, hand-derived from the QML's coordinates: a 270°
// arrow ring, two whole circles beside a half turn, and a pair of cubics
// around a full circle.
assert.equal(
  read("refresh").match(/d="([^"]+)"/)?.[1],
  "M13.2 8A5.2 5.2 0 0 1 4.323 11.677A5.2 5.2 0 0 1 8 2.8M6.5 1.6L8.9 2.8L6.5 4",
);
assert.equal(
  read("people").match(/d="([^"]+)"/)?.[1],
  "M8.4 5.2A2.4 2.4 0 0 1 3.6 5.2A2.4 2.4 0 0 1 8.4 5.2" +
    "M1.8 13A4.2 4.2 0 0 1 10.2 13" +
    "M13.4 5.8A1.9 1.9 0 0 1 9.6 5.8A1.9 1.9 0 0 1 13.4 5.8" +
    "M12.4 13L13.9042 10.3958A3.4 3.4 0 0 1 14.9 12.8",
);
assert.equal(
  read("eye").match(/d="([^"]+)"/)?.[1],
  "M1.5 8C4 3.5 12 3.5 14.5 8C12 12.5 4 12.5 1.5 8" +
    "M10.2 8A2.2 2.2 0 0 1 5.8 8A2.2 2.2 0 0 1 10.2 8",
);

// A rectangle is a closed subpath of its own, and the fresh subpath canvas
// leaves at its origin is why every rect in the QML is followed by a move.
assert.equal(
  path((p) => p.rect(1, 3, 14, 10)),
  "M1 3H15V13H1Z",
);

// What a caller gets: an asset string gpui resolves against the application
// directory, with the variants that are a second file chosen here rather than
// spelled out at the call site.
assert.equal(iconAsset("replyAll"), "assets/icons/replyAll.svg");
assert.equal(iconAsset("star"), "assets/icons/star.svg");
assert.equal(
  iconAsset("star", { filled: true }),
  "assets/icons/star-filled.svg",
);
assert.equal(iconAsset("check", { filled: true }), "assets/icons/check.svg");
for (const name of iconNames) {
  assert.equal(iconAsset(name), `assets/icons/${name}.svg`);
}

// The branded Gmail mark is the one glyph that is two elements, because two
// colours are two files.
const cx = { theme: () => ({ colors: { primary: "#ff0000" } }) };
assert.equal(icon("check", cx).childNodes.length, 0);
assert.equal(icon("gmail", cx, { size: 24 }).childNodes.length, 0);
assert.equal(icon("gmail", cx, { mark: true }).childNodes.length, 2);

console.log("icons passed");
