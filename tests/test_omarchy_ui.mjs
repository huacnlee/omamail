import assert from "node:assert/strict";

import {
  omarchyBaseColors,
  omarchyStatusColors,
  omarchyTheme,
} from "../app/lib/omarchy-ui/theme.js";

const source = `
mode = "light"
background = "#f8f7f2"
foreground = "#242424"
accent = "#3465a4"
selection = "#d9e4f2"
lighter_background = "#ffffff"
dark_foreground = "#666666"
light_foreground = "#eeeeee"
bright_foreground = "#ffffff"
red = "#a40000"
green = "#4e9a06"
yellow = "#c4a000"
blue = "#3465a4"
magenta = "#75507b"
cyan = "#06989a"
`;

const fallback = {
  appearance: "dark",
  colors: {
    background: "fallback-background",
    foreground: "fallback-foreground",
    destructive: "fallback-destructive",
  },
  spacing: { md: 12 },
  radius: { md: 8 },
};

assert.deepEqual(omarchyBaseColors(source), [
  "#a40000",
  "#4e9a06",
  "#c4a000",
  "#3465a4",
  "#75507b",
  "#06989a",
]);
assert.deepEqual(omarchyStatusColors(source), {
  danger: "#a40000",
  success: "#4e9a06",
  warning: "#c4a000",
  info: "#06989a",
});

const theme = omarchyTheme(source, fallback);
assert.equal(theme.appearance, "light");
assert.equal(theme.tokens.colors.background, "#f8f7f2");
assert.equal(theme.tokens.colors.foreground, "#242424");
assert.equal(theme.tokens.colors.primary, "#3465a4");
assert.equal(theme.tokens.colors.muted_foreground, "#666666");
assert.equal(theme.tokens.colors.destructive, "#a40000");
assert.deepEqual(theme.tokens.spacing, fallback.spacing);
assert.deepEqual(theme.tokens.radius, fallback.radius);

assert.equal(omarchyTheme("red = '#a40000'", fallback), null);

console.log("omarchy-ui theme tests passed");
