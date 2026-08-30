// @ts-check

// The icon set as SVG assets, translated from the Canvas drawing in
// `components/ActionIcon.qml`. The QML draws every glyph on a 16-unit grid with
// moveTo/lineTo/arc/rect/bezierCurveTo; gpui has no canvas, so the same
// coordinates are written out as path data and the viewBox carries the grid.
//
// The generated files are committed rather than built at start-up: gpui reads
// assets from the application directory on disk, so a file that is not there is
// an icon that does not draw. That directory is `app/`, the one holding
// `gpui-shell.json` — `AppAssets` is rooted there and `application_dir` finds
// it — so the files go to `app/assets/icons` beside the provider artwork, and
// a caller names one `assets/icons/<name>.svg`.
//
// Run: node scripts/build-icons.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TAU = Math.PI * 2;

/** Where the files go, from the repository root. */
export const ICON_DIRECTORY = "app/assets/icons";

/**
 * Four decimals is finer than a sixteenth of a pixel at any size these draw at.
 * The `-0` is what a point on a circle rounds to when a cosine lands just below
 * zero, and `"-0"` in path data is a coordinate no reader should have to think
 * about.
 * @param {number} value
 */
function coordinate(value) {
  const rounded = Math.round(value * 1e4) / 1e4;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** @param {number} cx @param {number} cy @param {number} r @param {number} angle */
function onCircle(cx, cy, r, angle) {
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

/**
 * The subset of the canvas 2D path API `ActionIcon` uses, recording SVG path
 * data instead of pixels. Coordinates stay in the QML's 16-unit grid: the
 * viewBox does the scaling the QML did with `s = width / 16`.
 */
export class IconPath {
  constructor() {
    /** @type {string[]} */
    this.commands = [];
    /** @type {[number, number] | null} */
    this.current = null;
    /** @type {[number, number] | null} */
    this.subpathStart = null;
  }

  /** @param {number} x @param {number} y */
  moveTo(x, y) {
    this.commands.push(`M${coordinate(x)} ${coordinate(y)}`);
    this.current = [x, y];
    this.subpathStart = [x, y];
    return this;
  }

  /** @param {number} x @param {number} y */
  lineTo(x, y) {
    if (!this.current) return this.moveTo(x, y);
    this.commands.push(`L${coordinate(x)} ${coordinate(y)}`);
    this.current = [x, y];
    return this;
  }

  /**
   * @param {number} x1 @param {number} y1
   * @param {number} x2 @param {number} y2
   * @param {number} x @param {number} y
   */
  bezierCurveTo(x1, y1, x2, y2, x, y) {
    if (!this.current) this.moveTo(x1, y1);
    this.commands.push(
      `C${coordinate(x1)} ${coordinate(y1)} ${coordinate(x2)} ${coordinate(y2)} ${coordinate(x)} ${coordinate(y)}`,
    );
    this.current = [x, y];
    return this;
  }

  /**
   * A closed rectangle of its own, then a fresh subpath starting at its origin
   * — which is what canvas leaves behind, and why every `rect` in the QML is
   * followed by a `move` rather than a `line`.
   * @param {number} x @param {number} y @param {number} width @param {number} height
   */
  rect(x, y, width, height) {
    this.commands.push(
      `M${coordinate(x)} ${coordinate(y)}`,
      `H${coordinate(x + width)}`,
      `V${coordinate(y + height)}`,
      `H${coordinate(x)}`,
      "Z",
    );
    this.current = [x, y];
    this.subpathStart = [x, y];
    return this;
  }

  closePath() {
    if (!this.subpathStart) return this;
    this.commands.push("Z");
    this.current = [this.subpathStart[0], this.subpathStart[1]];
    return this;
  }

  /**
   * Canvas `arc`, as SVG elliptical arcs. Every part of this is a way to get
   * the geometry wrong, and each was checked against Qt's own canvas rather
   * than reasoned about: five probe arcs drawn by `QtQuick.Canvas` offscreen
   * and compared, pixel for pixel, with what this emits.
   *
   * **The span.** The arc turns from `start` towards `end` in the named
   * direction through however much of the circle that takes, so a clockwise arc
   * from 0 to -π/2 is three quarters and not a quarter. A difference of a whole
   * turn or more is the whole circle in the direction asked for — which is how
   * `arc(cx, cy, r, 0, Math.PI * 2)` closes, and Qt takes the size of that
   * difference rather than its sign, so a backwards whole turn closes too.
   *
   * **The direction.** SVG's sweep flag counts angles the way canvas does, so a
   * positive span is 1 and a negative one 0 — both of them clockwise *on
   * screen*, because y grows downwards in this coordinate system.
   *
   * **The first point.** An arc joins whatever the subpath already had with a
   * straight line to the arc's own start, so it emits `L` and not `M` unless
   * nothing is open. Every arc in the QML is preceded by a `move` to that point
   * for exactly this reason: the line it emits has nowhere to go, and is left
   * out of the path data when it would draw nothing. Three of them do move —
   * `pin` and `attachment` by a rounding's worth, `people`'s second shoulder by
   * two and a half units — and those keep the joining line, because Qt draws
   * it.
   *
   * **The whole circle.** One SVG arc cannot draw it — the two endpoints would
   * coincide and nothing would be drawn — so a span is cut into pieces of at
   * most half a turn. That also settles the large-arc flag at 0 for every
   * piece.
   *
   * @param {number} cx @param {number} cy @param {number} r
   * @param {number} start @param {number} end @param {boolean} [anticlockwise]
   */
  arc(cx, cy, r, start, end, anticlockwise = false) {
    const [startX, startY] = onCircle(cx, cy, r, start);
    const away = this.current
      ? Math.hypot(startX - this.current[0], startY - this.current[1])
      : Infinity;
    if (!this.current) this.moveTo(startX, startY);
    else if (away > 1e-6) this.lineTo(startX, startY);

    const direction = anticlockwise ? -1 : 1;
    const requested = anticlockwise ? start - end : end - start;
    const span =
      Math.abs(end - start) >= TAU
        ? direction * TAU
        : direction * (((requested % TAU) + TAU) % TAU);
    if (span === 0) return this;

    const sweepFlag = span > 0 ? 1 : 0;
    const steps = Math.ceil(Math.abs(span) / Math.PI);
    for (let step = 1; step <= steps; step += 1) {
      const angle = start + (span * step) / steps;
      const [x, y] = onCircle(cx, cy, r, angle);
      this.commands.push(
        `A${coordinate(r)} ${coordinate(r)} 0 0 ${sweepFlag} ${coordinate(x)} ${coordinate(y)}`,
      );
      this.current = [x, y];
    }
    return this;
  }

  toString() {
    return this.commands.join("");
  }
}

/** @param {(path: IconPath) => void} draw */
function pathData(draw) {
  const path = new IconPath();
  draw(path);
  return path.toString();
}

/**
 * Every glyph, transcribed from `ActionIcon.qml` branch for branch. The
 * comments there explain why a glyph looks the way it does and are not
 * repeated; what is repeated is the coordinates, which are the design sheet's.
 *
 * @type {Record<string, (path: IconPath) => void>}
 */
export const drawings = {
  reply(path) {
    path.moveTo(6, 3.5).lineTo(2, 7.5).lineTo(6, 11.5);
    path.moveTo(2, 7.5).lineTo(9, 7.5);
    path.arc(9, 12, 4.5, -Math.PI / 2, 0);
    path.lineTo(13.5, 13);
  },
  replyAll(path) {
    path.moveTo(6, 3.5).lineTo(2, 7.5).lineTo(6, 11.5);
    path.moveTo(9.5, 3.5).lineTo(5.5, 7.5).lineTo(9.5, 11.5);
    path.moveTo(5.5, 7.5).lineTo(10.5, 7.5);
    path.arc(10.5, 12, 4.5, -Math.PI / 2, 0);
    path.lineTo(15, 13);
  },
  // The one glyph that is not a transcription. The QML asks for
  // `arc(7, 12, 4.5, Math.PI, Math.PI + Math.PI / 2, true)`, but its local
  // `arc` helper takes five parameters, so the `true` never reaches the
  // context: the tail is drawn forwards from (2.5, 12) to (7, 7.5) with a
  // chord across it in both directions. At 16px the 1.4 stroke covers that
  // lens and it passes for the quarter circle it was meant to be; at any
  // larger size it is a blob. Written here as the anticlockwise quarter the
  // QML asked for, which is also `reply` mirrored, as this glyph is.
  forward(path) {
    path.moveTo(10, 3.5).lineTo(14, 7.5).lineTo(10, 11.5);
    path.moveTo(14, 7.5).lineTo(7, 7.5);
    path.arc(7, 12, 4.5, Math.PI + Math.PI / 2, Math.PI, true);
    path.lineTo(2.5, 13);
  },
  archive(path) {
    path.rect(1.5, 2.5, 13, 3.2);
    path
      .moveTo(2.8, 5.7)
      .lineTo(2.8, 13.5)
      .lineTo(13.2, 13.5)
      .lineTo(13.2, 5.7);
    path.moveTo(6.4, 8.8).lineTo(9.6, 8.8);
  },
  trash(path) {
    path.moveTo(2.5, 4).lineTo(13.5, 4);
    path.moveTo(6, 4).lineTo(6, 2.5).lineTo(10, 2.5).lineTo(10, 4);
    path.moveTo(4, 4).lineTo(4.7, 13.5).lineTo(11.3, 13.5).lineTo(12, 4);
  },
  spam(path) {
    path.moveTo(8, 1.5).lineTo(14, 4.5).lineTo(14, 8.5);
    path.arc(8, 8.5, 6, 0, Math.PI / 2);
    path.moveTo(2, 8.5).lineTo(2, 4.5).lineTo(8, 1.5);
    path.moveTo(8, 5).lineTo(8, 8.5);
    path.moveTo(8, 10.8).lineTo(8, 11);
  },
  unread(path) {
    path.rect(1, 3.5, 14, 9);
    path.moveTo(1, 3.5).lineTo(8, 8.5).lineTo(15, 3.5);
  },
  star(path) {
    path.moveTo(8, 1.8).lineTo(9.9, 5.7).lineTo(14.2, 6.3).lineTo(11.1, 9.3);
    path.lineTo(11.8, 13.6).lineTo(8, 11.6).lineTo(4.2, 13.6).lineTo(4.9, 9.3);
    path.lineTo(1.8, 6.3).lineTo(6.1, 5.7).closePath();
  },
  browser(path) {
    path.moveTo(9, 2).lineTo(14, 2).lineTo(14, 7);
    path.moveTo(14, 2).lineTo(7.5, 8.5);
    path
      .moveTo(12, 9.5)
      .lineTo(12, 13.5)
      .lineTo(2, 13.5)
      .lineTo(2, 3.5)
      .lineTo(6, 3.5);
  },
  refresh(path) {
    path.moveTo(13.2, 8);
    path.arc(8, 8, 5.2, 0, Math.PI * 1.5);
    path.moveTo(6.5, 1.6).lineTo(8.9, 2.8).lineTo(6.5, 4.0);
  },
  send(path) {
    path.moveTo(14.5, 1.5).lineTo(7, 9);
    path
      .moveTo(14.5, 1.5)
      .lineTo(10, 14.5)
      .lineTo(7, 9)
      .lineTo(1.5, 6)
      .closePath();
  },
  undo(path) {
    path.moveTo(5.5, 3).lineTo(1.8, 6.8).lineTo(5.5, 10.5);
    path.moveTo(1.8, 6.8).lineTo(9, 6.8);
    path.arc(9, 11.2, 4.4, -Math.PI / 2, 0);
  },
  menu(path) {
    path.moveTo(2.5, 4.5).lineTo(13.5, 4.5);
    path.moveTo(2.5, 8).lineTo(13.5, 8);
    path.moveTo(2.5, 11.5).lineTo(13.5, 11.5);
  },
  plus(path) {
    path.moveTo(8, 3.5).lineTo(8, 12.5);
    path.moveTo(3.5, 8).lineTo(12.5, 8);
  },
  close(path) {
    path.moveTo(3.5, 3.5).lineTo(12.5, 12.5);
    path.moveTo(12.5, 3.5).lineTo(3.5, 12.5);
  },
  back(path) {
    path.moveTo(9, 3).lineTo(4, 8).lineTo(9, 13);
    path.moveTo(4, 8).lineTo(14, 8);
  },
  chevronLeft(path) {
    path.moveTo(10.5, 3).lineTo(5.5, 8).lineTo(10.5, 13);
  },
  chevronRight(path) {
    path.moveTo(5.5, 3).lineTo(10.5, 8).lineTo(5.5, 13);
  },
  chevronDown(path) {
    path.moveTo(3, 5.5).lineTo(8, 10.5).lineTo(13, 5.5);
  },
  eye(path) {
    path.moveTo(1.5, 8);
    path.bezierCurveTo(4, 3.5, 12, 3.5, 14.5, 8);
    path.bezierCurveTo(12, 12.5, 4, 12.5, 1.5, 8);
    path.moveTo(10.2, 8);
    path.arc(8, 8, 2.2, 0, Math.PI * 2);
  },
  eyeOff(path) {
    drawings.eye(path);
    path.moveTo(3, 13.2).lineTo(13, 2.8);
  },
  inbox(path) {
    path
      .moveTo(1.5, 9.5)
      .lineTo(4.5, 9.5)
      .lineTo(6, 11.5)
      .lineTo(10, 11.5)
      .lineTo(11.5, 9.5)
      .lineTo(14.5, 9.5);
    path
      .moveTo(1.5, 9.5)
      .lineTo(3.5, 3)
      .lineTo(12.5, 3)
      .lineTo(14.5, 9.5)
      .lineTo(14.5, 13.5)
      .lineTo(1.5, 13.5)
      .closePath();
  },
  compose(path) {
    path
      .moveTo(2.5, 13.5)
      .lineTo(3.4, 10.4)
      .lineTo(11.2, 2.6)
      .lineTo(13.4, 4.8)
      .lineTo(5.6, 12.6)
      .closePath();
    path.moveTo(9.6, 4.2).lineTo(11.8, 6.4);
  },
  label(path) {
    path
      .moveTo(1.5, 1.5)
      .lineTo(7.6, 1.5)
      .lineTo(14.5, 8.4)
      .lineTo(8.4, 14.5)
      .lineTo(1.5, 7.6)
      .closePath();
    path.moveTo(5.7, 4.5);
    path.arc(4.5, 4.5, 1.2, 0, Math.PI * 2);
  },
  gmail(path) {
    drawings["gmail-envelope"](path);
    drawings["gmail-mark"](path);
  },
  "gmail-envelope"(path) {
    path.rect(1, 3, 14, 10);
  },
  "gmail-mark"(path) {
    path
      .moveTo(3.6, 13)
      .lineTo(3.6, 5.6)
      .lineTo(8, 9.3)
      .lineTo(12.4, 5.6)
      .lineTo(12.4, 13);
  },
  mail(path) {
    drawings.gmail(path);
  },
  sidebar(path) {
    path.rect(1.5, 2.5, 13, 11);
    path.moveTo(6, 2.5).lineTo(6, 13.5);
  },
  check(path) {
    path.moveTo(2.5, 8.5).lineTo(6.5, 12.5).lineTo(13.5, 4);
  },
  attachment(path) {
    path.moveTo(13, 7).lineTo(7.5, 12.5);
    path.arc(5, 10, 3.5, Math.PI / 4, Math.PI * 1.25);
    path.moveTo(8, 2).lineTo(11.5, 5.5);
  },
  calendar(path) {
    path.rect(1.5, 3, 13, 11.5);
    path.moveTo(1.5, 7).lineTo(14.5, 7);
    path.moveTo(5, 1.5).lineTo(5, 4.5);
    path.moveTo(11, 1.5).lineTo(11, 4.5);
  },
  video(path) {
    path.rect(1.5, 4, 9, 8);
    path.moveTo(10.5, 7.2).lineTo(14.5, 4.8).lineTo(14.5, 11.2).closePath();
  },
  pin(path) {
    path.moveTo(5.45, 8.55);
    path.arc(8, 6, 3.6, Math.PI * 0.75, Math.PI * 2.25);
    path.lineTo(8, 13.8).closePath();
    path.moveTo(9.3, 6);
    path.arc(8, 6, 1.3, 0, Math.PI * 2);
  },
  people(path) {
    path.moveTo(8.4, 5.2);
    path.arc(6, 5.2, 2.4, 0, Math.PI * 2);
    path.moveTo(1.8, 13);
    path.arc(6, 13, 4.2, Math.PI, Math.PI * 2);
    path.moveTo(13.4, 5.8);
    path.arc(11.5, 5.8, 1.9, 0, Math.PI * 2);
    path.moveTo(12.4, 13);
    path.arc(11.5, 12.8, 3.4, Math.PI * 1.75, Math.PI * 2);
  },
};

/**
 * The names `ActionIcon.qml` answers to, in its own order. The three extra
 * files — `star-filled`, `gmail-envelope`, `gmail-mark` — are variants rather
 * than icons and are listed separately, because a caller asks for `star` and
 * says it is filled.
 */
export const iconNames = [
  "reply",
  "replyAll",
  "forward",
  "archive",
  "trash",
  "spam",
  "unread",
  "star",
  "browser",
  "refresh",
  "send",
  "undo",
  "menu",
  "plus",
  "close",
  "back",
  "chevronLeft",
  "chevronRight",
  "chevronDown",
  "eye",
  "eyeOff",
  "inbox",
  "compose",
  "label",
  "gmail",
  "mail",
  "sidebar",
  "check",
  "attachment",
  "calendar",
  "video",
  "pin",
  "people",
];

/** The variants that get a file of their own: filled, or a second colour. */
export const variantNames = ["star-filled", "gmail-envelope", "gmail-mark"];

/**
 * The stroke weight is the QML's `strokeScale`, unscaled: the QML multiplied it
 * by `s` because it drew in pixels, and the viewBox does that here.
 * @param {string} data @param {boolean} filled
 */
export function svgDocument(data, filled) {
  const fill = filled ? "currentColor" : "none";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="${fill}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="${data}"/></svg>\n`;
}

/** Every file to write, as name → document. */
export function documents() {
  /** @type {Record<string, string>} */
  const files = {};
  for (const name of [...iconNames, ...variantNames]) {
    const draw = drawings[name === "star-filled" ? "star" : name];
    if (!draw) throw new Error(`no drawing for icon "${name}"`);
    files[name] = svgDocument(pathData(draw), name === "star-filled");
  }
  return files;
}

function build() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const directory = join(root, ICON_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const files = documents();
  for (const [name, document] of Object.entries(files)) {
    writeFileSync(join(directory, `${name}.svg`), document);
  }
  console.log(`wrote ${Object.keys(files).length} icons to ${ICON_DIRECTORY}`);
}

if (import.meta.main) build();
