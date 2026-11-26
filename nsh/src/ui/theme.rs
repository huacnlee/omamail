//! Theme and motion tokens. Colors are the theme's semantic roles;
//! Omamail's own roles fall back to a standard one, never to a literal.

use std::time::Duration;

use nsh_base::theme;
use nsh_core::prelude::*;

/// The unread marker: the theme's `unread` token, else `primary`.
pub fn unread() -> AdaptiveColor {
    theme().color("unread").unwrap_or(theme().primary)
}

/// Row heights, in points.
pub const SIDEBAR_ROW: f32 = 30.0;
pub const CONTROL_HEIGHT: f32 = 28.0;
pub const MESSAGE_ROW: f32 = 72.0;

/// Column widths, in points.
pub const SIDEBAR_WIDTH: f32 = 220.0;
pub const LIST_WIDTH: f32 = 340.0;
pub const READER_MAX_WIDTH: f32 = 720.0;

/// Motion tokens (DESIGN.md, "Motion").
pub mod motion {
    use super::Duration;

    /// Hover washes and pressed states.
    pub const FAST: Duration = Duration::from_millis(120);
    /// Selection moving between rows, the reader's content fading in.
    pub const STANDARD: Duration = Duration::from_millis(200);
    /// Opacity of a pressed control.
    pub const PRESSED_OPACITY: f32 = 0.72;
}

/// The radius of controls: the theme's.
pub fn radius() -> Points {
    theme().radius
}
