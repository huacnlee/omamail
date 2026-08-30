// @ts-check

export const MAIL_RAIL_WIDTH = 64;
export const MAIL_LIST_WIDTH = 650;
export const MAIL_READER_MIN_WIDTH = 480;
// gpui-shell reports viewport widths in device-independent window units. At
// the common 1.6 Omarchy display scale, 720 units is roughly the 1150 logical
// pixels required by the rail, list, and a readable reader.
export const SPLIT_MAIL_MIN_WIDTH =
  MAIL_RAIL_WIDTH + MAIL_LIST_WIDTH + MAIL_READER_MIN_WIDTH;

/** @param {number} width @param {boolean} [readerOpen] */
export function mailLayout(width, readerOpen = false) {
  if (width < SPLIT_MAIL_MIN_WIDTH) {
    return {
      mode: "single",
      showRail: !readerOpen,
      showList: !readerOpen,
      showReader: readerOpen,
      railWidth: MAIL_RAIL_WIDTH,
      listWidth: MAIL_LIST_WIDTH,
      readerFlexible: true,
    };
  }
  return {
    mode: "split",
    showRail: true,
    showList: true,
    showReader: true,
    railWidth: MAIL_RAIL_WIDTH,
    listWidth: MAIL_LIST_WIDTH,
    readerFlexible: true,
  };
}
