pragma Singleton
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import "Themes.js" as Themes

// One colour authority for the mail window.
//
// The shell's own `Commons.Color` is shared with the bar beside the window, so
// it can never be the place a per-app theme is applied. Neither can the shell's
// state helpers: Omarchy renders shell.toml with the desktop theme's hex baked
// into `[controls]`, so `Style.hoverFillFor(fg, accent)` ignores the colours it
// is given and returns the desktop's. Every colour the window paints therefore
// comes from here instead, and here is exactly two behaviours:
//
//   Follow Omarchy — every colour and every helper delegates to
//   `Commons.Color`, `Style` and `Border` with the same arguments. Not
//   "similar": the same call, so the window is pixel-identical to the build
//   before this existed.
//
//   A picked theme — the same helpers, resolved against that theme's own
//   palette. Alphas, border widths, spacing, fonts and corner radius still come
//   from the live `Style`: they are the user's shell-wide values, they are
//   identical across the stock themes, and a window that changed them would
//   stop matching the bar and the rest of the desktop.
//
// Surfaces that are deliberately not the window's — the bar envelope, its
// unread popup, desktop notifications — are named at the bottom and never
// change with the picked theme.

QtObject {
  id: root

  // Whether a per-app theme can apply at all. Only the Omarchy plugin has an
  // Omarchy theme to pick from; the standalone host has its own appearance
  // setting and its own palettes.
  property bool available: false

  // The picked theme's directory name. "" is Follow Omarchy, and anything a
  // settings file could not name is normalised to "": an invalid answer is the
  // default, never an error state.
  property string themeName: ""
  // Where that theme lives, resolved by ThemeCatalog — the one place that
  // reads a theme directory listing. Untrusted like the name: this singleton
  // re-validates by reading the file and falling back if it is not a theme.
  property string themeDir: ""

  // The resolved theme (palette, popup and tooltip surfaces, control tokens),
  // or null while following Omarchy or while a picked theme is unreadable.
  property var theme: null

  readonly property string selected: Themes.normalizeName(themeName)
  readonly property bool following: selected === Themes.FOLLOW
  readonly property bool active: available && theme !== null && themeDir !== ""

  property string colorsText: ""
  property string shellText: ""

  // Every input is read from its own plain property here, never from
  // `selected`: the change handlers below can run before that derived binding
  // has caught up, and a reload that saw the old name would settle on a valid
  // theme without ever opening its files. Read this way, whichever input
  // arrives last reloads with all of them.
  function reload() {
    root.theme = null
    root.colorsText = ""
    root.shellText = ""
    if (root.available && Themes.normalizeName(root.themeName) !== Themes.FOLLOW
        && root.themeDir !== "") {
      // The theme was just cleared, so the files are read again even when the
      // path is the one already open: the name and the directory can arrive
      // in either order, and the second to arrive must not leave the window
      // with no theme because the path it computes did not change.
      var colorsPath = root.themeDir + "/colors.toml"
      var shellPath = root.themeDir + "/shell.toml"
      if (colorsFile.path === colorsPath) colorsFile.reload()
      else colorsFile.path = colorsPath
      if (shellFile.path === shellPath) shellFile.reload()
      else shellFile.path = shellPath
    } else {
      colorsFile.path = ""
      shellFile.path = ""
    }
  }

  function rebuild() {
    var palette = Themes.parseColors(root.colorsText)
    root.theme = palette === null ? null : Themes.resolveTheme(palette, root.shellText)
  }

  onAvailableChanged: reload()
  onThemeNameChanged: reload()
  onThemeDirChanged: reload()

  // The picked theme's own files, watched, so editing a theme while the window
  // stands recolours it the way the shell would.
  property FileView colorsFile: FileView {
    id: colorsFile
    watchChanges: true
    printErrors: false
    onLoaded: {
      root.colorsText = text()
      root.rebuild()
    }
    onLoadFailed: {
      root.colorsText = ""
      root.rebuild()
    }
    onFileChanged: reload()
  }

  property FileView shellFile: FileView {
    id: shellFile
    watchChanges: true
    printErrors: false
    onLoaded: {
      root.shellText = text()
      root.rebuild()
    }
    // A theme that ships no shell.toml is a theme with the template's defaults,
    // not a broken theme.
    onLoadFailed: {
      root.shellText = ""
      root.rebuild()
    }
    onFileChanged: reload()
  }

  // --------------------------------------------------------------- palette
  //
  // The window's semantic colours. Every one of them is a role App.qml passes
  // down as a required property, or the bar's own colour when following.

  readonly property color foreground: active ? theme.palette.foreground : Commons.Color.foreground
  readonly property color background: active ? theme.palette.background : Commons.Color.background
  readonly property color accent: active ? theme.palette.accent : Commons.Color.accent
  readonly property color urgent: active ? theme.palette.urgent : Commons.Color.urgent
  readonly property color muted: active ? theme.palette.muted : desktopMuted
  readonly property color selectionColor: active ? theme.palette.selection : desktopMuted

  readonly property color popupBackground: active
    ? Qt.alpha(theme.popups.background, theme.popups.backgroundAlpha) : Commons.Color.popups.background
  readonly property color popupBorder: active
    ? Qt.alpha(theme.popups.border, theme.popups.borderAlpha) : Commons.Color.popups.border
  readonly property color popupText: active ? theme.popups.text : Commons.Color.popups.text

  readonly property color tooltipBackground: active
    ? Qt.alpha(theme.tooltip.background, theme.tooltip.backgroundAlpha) : Commons.Color.tooltip.background
  readonly property color tooltipBorder: active ? theme.tooltip.border : Commons.Color.tooltip.border
  readonly property color tooltipText: active ? theme.tooltip.text : Commons.Color.tooltip.text

  // Not every host's Color has a muted role; the shell's does.
  readonly property color desktopMuted: Commons.Color.muted !== undefined
    ? Commons.Color.muted : Commons.Color.foreground

  // -------------------------------------------------------------- surfaces
  //
  // Colours that are not the window's own. The bar envelope, its popup and the
  // desktop's notifications belong to the desktop theme however the window is
  // drawn, so they are named here once rather than reached for from
  // Commons.Color at each use.

  readonly property color desktopForeground: Commons.Color.foreground
  readonly property color desktopBackground: Commons.Color.background
  readonly property color desktopAccent: Commons.Color.accent
  readonly property color barForeground: Commons.Color.foreground
  readonly property color barPopupBackground: Commons.Color.popups.background
  readonly property color barPopupText: Commons.Color.popups.text
  readonly property color notificationForeground: Commons.Color.foreground
  readonly property color notificationAccent: Commons.Color.accent

  // ------------------------------------------------------- state colours
  //
  // The same vocabulary the shell's Style uses: normal, hover-cursor, focus,
  // selected, pressed, selection. A role token is resolved with the colours the
  // caller passed — that is what makes a control follow the surface it is drawn
  // on — while a hex a theme pinned is used as written.

  function paletteFor(foreground, accent, urgent) {
    return {
      foreground: foreground || root.foreground,
      accent: accent || root.accent,
      urgent: urgent || root.urgent,
      background: root.background,
      muted: root.muted,
      selection: root.selectionColor,
    }
  }

  function stateColor(token, foreground, accent, urgent, fallback) {
    if (!active) return fallback || foreground || root.foreground
    var colour = Themes.resolveToken(token, paletteFor(foreground, accent, urgent))
    return colour !== "" ? colour : (fallback || foreground || root.foreground)
  }

  function normalStateColor(foreground, accent, urgent) {
    return active ? stateColor(theme.controls.normal.color, foreground, accent, urgent, root.foreground)
      : Style.normalStateColor(foreground, accent, urgent)
  }
  function hoverStateColor(foreground, accent, urgent) {
    return active ? stateColor(theme.controls.hover.color, foreground, accent, urgent, root.foreground)
      : Style.hoverStateColor(foreground, accent, urgent)
  }
  function focusStateColor(foreground, accent, urgent) {
    return active ? stateColor(theme.controls.focus.color, foreground, accent, urgent, root.foreground)
      : Style.focusStateColor(foreground, accent, urgent)
  }
  function selectedStateColor(foreground, accent, urgent) {
    return active ? stateColor(theme.controls.selected.color, foreground, accent, urgent, root.foreground)
      : Style.selectedStateColor(foreground, accent, urgent)
  }
  function pressedStateColor(foreground, accent, urgent) {
    return active ? stateColor(theme.controls.pressed.color, foreground, accent, urgent, root.foreground)
      : Style.pressedStateColor(foreground, accent, urgent)
  }
  function selectionStateColor(foreground, accent, urgent) {
    return active ? stateColor(theme.controls.selection.color, foreground, accent, urgent, root.foreground)
      : Style.selectionStateColor(foreground, accent, urgent)
  }

  function normalFillFor(foreground, accent, urgent) {
    return active ? Qt.alpha(normalStateColor(foreground, accent, urgent), Style.normalFillAlpha)
      : Style.normalFillFor(foreground, accent, urgent)
  }
  function hoverFillFor(foreground, accent, urgent) {
    return active ? Qt.alpha(hoverStateColor(foreground, accent, urgent), Style.hoverFillAlpha)
      : Style.hoverFillFor(foreground, accent, urgent)
  }
  function selectedFillFor(foreground, accent, urgent) {
    return active ? Qt.alpha(selectedStateColor(foreground, accent, urgent), Style.selectedFillAlpha)
      : Style.selectedFillFor(foreground, accent, urgent)
  }
  function pressedFillFor(foreground, accent, urgent) {
    return active ? Qt.alpha(pressedStateColor(foreground, accent, urgent), Style.pressedFillAlpha)
      : Style.pressedFillFor(foreground, accent, urgent)
  }
  function focusFillFor(foreground, accent, urgent) {
    return active ? Qt.alpha(focusStateColor(foreground, accent, urgent), Style.focusFillAlpha)
      : Style.focusFillFor(foreground, accent, urgent)
  }
  function selectionFillFor(foreground, accent, urgent) {
    return active ? Qt.alpha(selectionStateColor(foreground, accent, urgent), Style.selectionFillAlpha)
      : Style.selectionFillFor(foreground, accent, urgent)
  }

  function normalBorderFor(foreground, accent, urgent) {
    return active ? Qt.alpha(normalStateColor(foreground, accent, urgent), Style.normalBorderAlpha)
      : Style.normalBorderFor(foreground, accent, urgent)
  }
  function hoverBorderFor(foreground, accent, urgent) {
    return active ? Qt.alpha(hoverStateColor(foreground, accent, urgent), Style.hoverBorderAlpha)
      : Style.hoverBorderFor(foreground, accent, urgent)
  }
  function selectedBorderFor(foreground, accent, urgent) {
    return active ? Qt.alpha(selectedStateColor(foreground, accent, urgent), Style.selectedBorderAlpha)
      : Style.selectedBorderFor(foreground, accent, urgent)
  }
  function focusBorderFor(foreground, accent, urgent) {
    return active ? Qt.alpha(focusStateColor(foreground, accent, urgent), Style.focusBorderAlpha)
      : Style.focusBorderFor(foreground, accent, urgent)
  }

  readonly property color normalFill: normalFillFor(foreground, accent, urgent)
  readonly property color hoverFill: hoverFillFor(foreground, accent, urgent)
  readonly property color selectedFill: selectedFillFor(foreground, accent, urgent)
  readonly property color pressedFill: pressedFillFor(foreground, accent, urgent)
  readonly property color selectionFill: selectionFillFor(foreground, accent, urgent)
  readonly property color normalBorderColor: normalBorderFor(foreground, accent, urgent)
  readonly property color hoverBorderColor: hoverBorderFor(foreground, accent, urgent)
  readonly property color selectedBorderColor: selectedBorderFor(foreground, accent, urgent)
  readonly property color focusBorderColor: focusBorderFor(foreground, accent, urgent)
  // The shell's own selectedAccentFill, spelled out: it is the accent at the
  // selected fill's alpha, and there is no per-theme colour of its own to use.
  readonly property color selectedAccentFill: Qt.alpha(active ? accent : Commons.Color.accent,
    Style.selectedFillAlpha)

  // Composite helpers for the focus > hover > normal ladder every form control
  // paints, so a caller cannot pick a state the theme does not have.
  function controlFill(focused, hot, foreground, accent) {
    if (active) {
      if (focused) return focusFillFor(foreground, accent)
      if (hot) return hoverFillFor(foreground, accent)
      return normalFillFor(foreground, accent)
    }
    return Style.controlFill(focused, hot, foreground, accent)
  }

  function controlBorder(focused, hot, foreground, accent) {
    if (active) {
      if (focused) return focusBorderFor(foreground, accent)
      if (hot) return hoverBorderFor(foreground, accent)
      return normalBorderFor(foreground, accent)
    }
    return Style.controlBorder(focused, hot, foreground, accent)
  }

  function controlBorderWidth(focused, hot) {
    return active ? (focused ? focusBorderWidth : (hot ? hoverBorderWidth : normalBorderWidth))
      : Style.controlBorderWidth(focused, hot)
  }

  readonly property int normalBorderWidth: Style.normalBorderWidth
  readonly property int hoverBorderWidth: Style.hoverBorderWidth
  readonly property int selectedBorderWidth: Style.selectedBorderWidth
  readonly property int focusBorderWidth: Style.focusBorderWidth

  // A border spec in the shape `Border.controlSpec` returns, which is what a
  // BorderSurface renders. The geometry and the state's live border alpha come
  // from the shell's own spec — they are the user's shell-wide values — and
  // only the colour itself is the theme's.
  function controlSpec(state, foreground, accent, urgent) {
    if (!active) return Border.controlSpec(state, foreground, accent, urgent)
    var name = state === "hover" || state === "hot" ? "hover" : String(state || "normal")
    var tokens = theme.controls[name] !== undefined ? theme.controls[name] : theme.controls.normal
    var colour = stateColor(tokens.border || tokens.color, foreground, accent, urgent, root.foreground)
    var alpha = name === "focus" ? Style.focusBorderAlpha
      : name === "hover" ? Style.hoverBorderAlpha
      : name === "selected" ? Style.selectedBorderAlpha
      : Style.normalBorderAlpha
    var shell = Border.controlSpec(state, foreground, accent, urgent)
    return {
      color: Qt.alpha(colour, alpha),
      widths: shell.widths,
      gradient: { colors: [], angle: 0, enabled: false },
    }
  }

  function controlHasWidth(state) {
    return active ? controlBorderWidth(state === "focus", state === "hover" || state === "hot") > 0
      : Border.controlHasWidth(state)
  }
}
