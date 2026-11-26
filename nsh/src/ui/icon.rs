//! Line icons drawn with `currentColor`, so they follow the text color.

use nsh_core::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Icon {
    Inbox,
    Unread,
    Star,
    Send,
    Draft,
    Archive,
    Spam,
    Trash,
    Search,
    More,
    Refresh,
}

impl Icon {
    fn paths(self) -> &'static str {
        match self {
            Icon::Inbox => r#"<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6H3v-6z"/>"#,
            Icon::Unread => {
                r#"<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>"#
            }
            Icon::Star => {
                r#"<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>"#
            }
            Icon::Send => r#"<path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4z"/>"#,
            Icon::Draft => r#"<path d="M4 20h4L19 9l-4-4L4 16z"/>"#,
            Icon::Archive => {
                r#"<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>"#
            }
            Icon::Spam => r#"<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16v.5"/>"#,
            Icon::Trash => r#"<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>"#,
            Icon::Search => r#"<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>"#,
            Icon::More => {
                r#"<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>"#
            }
            Icon::Refresh => r#"<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>"#,
        }
    }

    fn markup(self) -> String {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">{}</svg>"#,
            self.paths()
        )
    }
}

/// `which` at `size` points, in the surrounding text color.
pub fn icon(which: Icon, size: f32) -> impl IntoElement {
    svg(ImageSrc::svg_markup(&which.markup()))
        .size(px(size))
        .flex_shrink_0()
}
