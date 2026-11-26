//! Omamail's default look: NsVim's built-in dark and light palettes, drawn
//! through nsh-omarchy so every `om::*` component and `tokens::*` call uses
//! them. Chrome (sidebar, bars) sits on the darker `bg2`, the picked row on
//! `bg3`, and the single accent is NsVim's blue.

use nsh_omarchy::Theme;

/// NsVim dark: bg #0E1016, chrome #0A0C11, hover/picked #151925.
const DARK: &str = r##"
mode = "dark"
background = "#0E1016"
lighter_background = "#0A0C11"
dark_background = "#0A0C11"
foreground = "#D6DAE4"
bright_foreground = "#D6DAE4"
accent = "#6C9EFF"
selection = "#151925"
muted = "#232838"
red = "#F2777A"
yellow = "#E5C07B"
green = "#A7D46F"
magenta = "#C39BFF"
cyan = "#5ED3D3"
orange = "#FFA266"
blue = "#6C9EFF"
"##;

/// NsVim light: bg #FAFAF7, chrome #F0F0EB, hover/picked #ECEDF2.
const LIGHT: &str = r##"
mode = "light"
background = "#FAFAF7"
lighter_background = "#F0F0EB"
dark_background = "#F0F0EB"
foreground = "#1F2330"
bright_foreground = "#1F2330"
accent = "#2F5FD0"
selection = "#ECEDF2"
muted = "#D9DAE0"
red = "#B83A3E"
yellow = "#8A6200"
green = "#39761D"
magenta = "#7A3FC8"
cyan = "#0E7575"
orange = "#AB5019"
blue = "#2F5FD0"
"##;

/// The palette for a dark or light appearance.
pub fn palette(dark: bool) -> Theme {
    let (text, name) = if dark { (DARK, "NsVim dark") } else { (LIGHT, "NsVim light") };
    Theme::from_colors_toml(text, name).expect("built-in palette is valid")
}

#[cfg(test)]
mod tests {
    #[test]
    fn both_palettes_parse() {
        super::palette(true);
        super::palette(false);
    }
}
