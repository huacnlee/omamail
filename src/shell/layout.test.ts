import { expect, test } from "nsh/test";
import * as layout from "./layout";

const state = (patch: Partial<layout.BodyState>): layout.BodyState => ({
  mode: "wide", showPage: false, composing: false, calendarVisible: false, readerOpen: false, ...patch,
});

test("the mode follows the mail area's width", () => {
  expect(layout.modeFor(1280)).toBe("wide");
  expect(layout.modeFor(1000)).toBe("wide");
  expect(layout.modeFor(999)).toBe("medium");
  expect(layout.modeFor(760)).toBe("medium");
  expect(layout.modeFor(759)).toBe("compact");
  expect(layout.modeFor(1280, 400)).toBe("medium");
  expect(layout.modeFor(1100, 400)).toBe("compact");
});

test("pane widths clamp and default", () => {
  expect(layout.sidebarWidthFor(0, false)).toBe(184);
  expect(layout.sidebarWidthFor(50, false)).toBe(140);
  expect(layout.sidebarWidthFor(900, false)).toBe(360);
  expect(layout.sidebarWidthFor(200, true)).toBe(44);
  expect(layout.listWidthFor(0, 1000)).toBe(340);
  expect(layout.listWidthFor(0, 2000)).toBe(460);
  expect(layout.listWidthFor(50, 1000)).toBe(100);
  expect(layout.listWidthFor(950, 1000)).toBe(800);
});

test("the body and the sidebar", () => {
  expect(layout.bodyFor(state({}))).toBe("split");
  expect(layout.bodyFor(state({ mode: "compact" }))).toBe("list");
  expect(layout.bodyFor(state({ mode: "compact", readerOpen: true }))).toBe("reader");
  expect(layout.bodyFor(state({ showPage: true, composing: true }))).toBe("page");
  expect(layout.bodyFor(state({ composing: true }))).toBe("compose");
  expect(layout.bodyFor(state({ calendarVisible: true }))).toBe("calendar");
  expect(layout.sidebarVisible(state({}))).toBe(true);
  expect(layout.sidebarVisible(state({ calendarVisible: true }))).toBe(true);
  expect(layout.sidebarVisible(state({ mode: "compact" }))).toBe(false);
  expect(layout.sidebarVisible(state({ showPage: true }))).toBe(false);
  expect(layout.sidebarVisible(state({ composing: true }))).toBe(false);
});

test("the shortcut sheet's columns", () => {
  expect(layout.helpColumnCount(300)).toBe(1);
  expect(layout.helpColumnCount(720)).toBe(2);
  expect(layout.helpColumnCount(1100)).toBe(3);
  // At a larger base size the columns are wider, so fewer fit.
  expect(layout.helpColumnCount(1100, 16 / 14)).toBe(2);
  expect(layout.helpColumnCount(3000)).toBe(3);
});

test("the breakpoints and pane widths grow with Omarchy's base size", () => {
  const s16 = 16 / 14;
  const near = (a: number, b: number) => expect(Math.abs(a - b) < 0.01).toBe(true);
  expect(layout.modeFor(1100, 0)).toBe("wide");
  expect(layout.modeFor(1100, 0, s16)).toBe("medium");
  expect(layout.modeFor(800, 0, s16)).toBe("compact");
  near(layout.sidebarWidthFor(0, false, s16), 184 * s16);
  near(layout.sidebarWidthFor(0, true, s16), 44 * s16);
  near(layout.listWidthFor(0, 2000, s16), 460 * s16);
});
