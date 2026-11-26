//! Omamail's few layout constants. Every component, color and size comes
//! from `nsh-omarchy` (`om::*`, `tokens::*`), so the app looks like the rest
//! of Omarchy and NsVim; the colors are NsVim's palettes (`crate::theme`).

/// A message row: sender line, subject line, snippet line.
pub const MESSAGE_ROW: f32 = 60.0;
/// The message list's width when the window opens.
pub const LIST_WIDTH: f32 = 360.0;
/// The reader's text column.
pub const READER_MAX_WIDTH: f32 = 720.0;
/// The bar over each column, as tall as the title bar.
pub const BAR_HEIGHT: f32 = 36.0;
