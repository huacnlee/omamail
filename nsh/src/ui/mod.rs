//! Omamail's styled components. Screens build from these only; a look a
//! screen needs and this layer lacks becomes a variant here first.

mod badge;
mod button;
mod icon;
mod input;
mod list_row;
mod menu;
mod segmented;
mod sidebar_item;
pub mod theme;

pub use badge::badge;
pub use button::{ButtonSize, ButtonVariant, button, icon_button};
pub use icon::{Icon, icon};
pub use input::search_input;
pub use list_row::{ListRowProps, list_row};
pub use menu::{MenuEntry, menu};
pub use segmented::segmented;
pub use sidebar_item::sidebar_item;
