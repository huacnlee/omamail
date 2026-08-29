// @ts-check

export const SPLIT_MAIL_MIN_WIDTH = 720;

/** @param {number} width @param {boolean} [readerOpen] */
export function mailLayout(width, readerOpen = false) {
  if (width < SPLIT_MAIL_MIN_WIDTH) {
    return { mode: "single", showList: !readerOpen, showReader: readerOpen };
  }
  return { mode: "split", showList: true, showReader: true };
}
