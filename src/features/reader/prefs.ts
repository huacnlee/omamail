// The reader's window preferences: which of the three bodies is on screen,
// how far the body is zoomed, and the standing "always show images" answer.
// One owner: src/app/prefs.ts keeps them in window.json under the Qt client's
// keys (Service.qml `bodyMode`, `bodyZoom`, `alwaysShowImages`) and is the only
// writer of that file. This is the reader's view of those three.
import { prefs } from "../../app/prefs";
import type { BodyMode } from "../../mail/message/html";

export const readerPrefs = {
  /** Reads window.json now (every getter also reads it on first use). */
  load: (): void => prefs.load(),
  bodyMode: (): BodyMode => prefs.bodyMode(),
  zoom: (): number => prefs.bodyZoom(),
  alwaysShowImages: (): boolean => prefs.alwaysShowImages(),
  setBodyMode: (mode: BodyMode): void => prefs.setBodyMode(mode),
  /** One zoom step in or out (e.g. 0.1 or -0.1). */
  zoomBy: (step: number): void => prefs.zoomBy(step),
  resetZoom: (): void => prefs.resetZoom(),
  setAlwaysShowImages: (value: boolean): void => prefs.setAlwaysShowImages(value),
};
