import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../theme"
import "../../kit" as Kit
import "../../components" as Components
import "../../bar" as Bar

// The window's own theme.
//
// The defect this test exists for is invisible in a stub that honours the
// colours it is handed: the real shell renders shell.toml with the desktop
// theme's hex baked into `[controls]`, so Style's helpers ignore their
// arguments and answer with the desktop's foreground. A window drawn in a light
// theme on a dark desktop then paints near-white text on a near-white surface.
//
// So the stub Style is told to behave the way the shell does, the desktop is a
// distinctly neutral palette (white on black), and the picked theme is a light
// one whose foreground is blue-grey. Every colour in it is therefore
// distinguishable from every colour blended out of the desktop's: the theme's
// are not neutral, the desktop's are.
Item {
  id: scene
  width: 720
  height: 1200

  readonly property string lightTheme: [
    'mode = "light"',
    'foreground = "#4c4f69"',
    'background = "#eff1f5"',
    'accent = "#8839ef"',
    'red = "#d20f39"',
    'muted = "#8c8fa1"',
    'selection = "#ccd0da"',
  ].join("\n")

  Component.onCompleted: {
    // The real shell's behaviour, off for every other test: the helpers below
    // answer with the desktop's foreground however they are called.
    Style.bakedStateColors = true
    Style.bakedForeground = Color.foreground
  }

  // Paint reads a theme through FileView. The test supplies the file's text and
  // runs the same parse → resolve → rebuild path the window runs when it opens
  // a theme, so everything below the file read is production code.
  function pickTheme(name) {
    Paint.available = true
    Paint.themeName = name
    Paint.themeDir = "/themes/" + name
    Paint.colorsText = scene.lightTheme
    Paint.shellText = ""
    Paint.rebuild()
  }

  function followOmarchy() {
    Paint.available = true
    Paint.themeName = ""
    Paint.themeDir = ""
    Paint.colorsText = ""
    Paint.shellText = ""
    Paint.rebuild()
  }

  // Every colour a visible item paints: its own fill and its border's.
  function paintedColours(item, found) {
    if (!item) return found
    if (item.visible === false || item.opacity <= 0.01) return found
    if (item.color !== undefined && item.color !== null && typeof item.color === "object") {
      found.push(item.color)
    }
    if (item.border && item.border.width > 0 && typeof item.border.color === "object") {
      found.push(item.border.color)
    }
    var kids = item.children || []
    for (var i = 0; i < kids.length; i++) paintedColours(kids[i], found)
    return found
  }

  // White and black are both neutral, so every alpha variant and every
  // darkening of the desktop's foreground or background is neutral too. The
  // picked theme states none: its roles are tinted greys, a purple accent and a
  // red urgent colour.
  function isDesktopNeutral(colour) {
    if (colour.a <= 0.02) return false
    return Math.abs(colour.r - colour.g) < 0.01 && Math.abs(colour.g - colour.b) < 0.01
  }

  function neutralColours(item) {
    var found = paintedColours(item, [])
    var out = []
    for (var i = 0; i < found.length; i++) {
      if (isDesktopNeutral(found[i])) out.push(String(found[i]))
    }
    return out
  }

  function paintColour(list, wanted) {
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]) === String(wanted)) return true
    }
    return false
  }

  // One window's worth of surfaces: App's semantic colours as a composed
  // panel, and every kit control Omamail uses, through the wrappers.
  Column {
    id: surface
    x: 8
    y: 8
    width: parent.width - 16
    spacing: 6

    Rectangle {
      objectName: "window-surface"
      width: surface.width
      height: 24
      color: Paint.background

      Text {
        objectName: "window-heading"
        text: "Inbox"
        color: Paint.foreground
        font.family: Style.font.family
      }
    }

    Rectangle {
      objectName: "card"
      width: surface.width
      height: 28
      radius: Style.cornerRadius
      color: Paint.normalFillFor(Paint.foreground, Paint.accent)
      border.width: Paint.normalBorderWidth
      border.color: Paint.normalBorderFor(Paint.foreground, Paint.accent)

      Text {
        text: "A card"
        color: Paint.foreground
        font.family: Style.font.family
      }
    }

    Kit.Button {
      objectName: "kit-button"
      text: "Archive"
      chosen: true
      foreground: Paint.foreground
      accent: Paint.accent
    }

    Kit.TextField {
      objectName: "kit-field"
      width: surface.width
      text: "hello"
      foreground: Paint.foreground
      accent: Paint.accent
    }

    Kit.ToggleSwitch {
      objectName: "kit-toggle"
      checked: true
      foreground: Paint.foreground
      accent: Paint.accent
    }

    Kit.Dropdown {
      objectName: "kit-dropdown"
      width: surface.width
      value: "one"
      options: [{ value: "one", label: "One" }, { value: "two", label: "Two" }]
      foreground: Paint.popupText
      background: Paint.popupBackground
      popupBorder: Paint.popupBorder
      accent: Paint.accent
      fontFamily: Style.font.family
    }

    Components.IconButton {
      objectName: "icon-button"
      iconName: "archive"
      tooltipText: "Archive"
    }

    Components.IconTextButton {
      objectName: "icon-text-button"
      iconName: "check"
      text: "Save"
    }

    Components.ReaderNotice {
      objectName: "reader-notice"
      textColor: Paint.foreground
      dimColor: Paint.muted
      accentColor: Paint.accent
      panelFontFamily: Style.font.family
      text: "Remote images are blocked."
    }
  }

  Components.MessageRow {
    id: messageRow
    objectName: "message-row"
    x: 8
    y: surface.y + surface.height + 8
    width: parent.width - 16
    summary: ({
      id: "1", subject: "Quarterly report", from: "Ada <ada@example.org>",
      snippet: "The numbers are attached.", time: "09:12", unread: true,
      starred: false, subjectDirection: "", sourceLabel: ""
    })
    textColor: Paint.foreground
    accentColor: Paint.accent
    dimColor: Paint.muted
    panelFontFamily: Style.font.family
  }

  // The bar's own preview keeps the desktop's palette; the window beside it does
  // not. It is given the desktop's colours, as BarWidget gives it.
  Bar.BarPreview {
    id: barPreview
    objectName: "bar-preview"
    x: 8
    y: messageRow.y + messageRow.height + 8
    width: 300
    messages: []
    events: []
    textColor: Color.popups.text
    backgroundColor: Color.popups.background
    accentColor: Color.accent
    dimColor: Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.62)
    panelFontFamily: Style.font.family
  }

  // The NumberField is asserted through the one part of it the wrapper owns —
  // its spin box's background — because the rest of a spin box is platform
  // chrome in any host.
  Kit.NumberField {
    id: numberField
    objectName: "kit-number"
    x: 8
    y: barPreview.y + barPreview.height + 8
    label: "Snooze (minutes)"
    value: 5
    foreground: Paint.foreground
    accent: Paint.accent
  }

  TestCase {
    name: "AppTheme"
    when: windowShown

    function init() {
      scene.followOmarchy()
    }

    // The core defect: a picked light theme on a dark desktop must not paint a
    // single desktop colour.
    function test_a_picked_theme_leaves_no_desktop_colour() {
      scene.pickTheme("fixture-light")
      verify(Paint.active, "the theme was read")
      verify(!Paint.following, "a theme is picked")

      var neutral = scene.neutralColours(surface)
      compare(neutral.length, 0, "the window paints only the theme's colours, not the desktop's: "
        + neutral.join(", "))
      var rowNeutral = scene.neutralColours(messageRow)
      compare(rowNeutral.length, 0, "a message row paints only the theme's colours: " + rowNeutral.join(", "))

      // And it is drawing with the picked palette, not with nothing at all.
      compare(String(Paint.foreground), "#4c4f69")
      compare(String(Paint.background), "#eff1f5")
      compare(String(Paint.accent), "#8839ef")
      // The kit's own helpers, which the shell's baked tokens broke, follow it.
      verify(!scene.isDesktopNeutral(Paint.hoverFillFor(Paint.foreground, Paint.accent)))
      verify(!scene.isDesktopNeutral(Paint.selectedStateColor(Paint.foreground, Paint.accent)))
      compare(String(Paint.selectedStateColor(Paint.foreground, Paint.accent)), "#4c4f69")
    }

    // Follow Omarchy is not merely "not themed": it is the desktop's window,
    // drawn from the same colours as before this feature existed.
    function test_follow_omarchy_draws_the_desktop_palette() {
      verify(!Paint.active, "nothing is picked")

      var painted = scene.paintedColours(surface, [])
      verify(painted.length > 0, "the tree paints something")
      verify(scene.paintColour(painted, Color.foreground),
        "a followed window paints the desktop's foreground")
      verify(scene.paintColour(painted, Qt.rgba(1, 1, 1, 1)) || scene.paintColour(painted, Qt.rgba(0, 0, 0, 1)),
        "and one of the desktop's own colours")
      // The helper delegation is exact, not approximate: these are the shell's
      // own answers, from the tokens the desktop baked.
      compare(String(Paint.hoverFillFor(Color.foreground, Color.accent)),
        String(Style.hoverFillFor(Color.foreground, Color.accent)))
      compare(String(Paint.normalBorderFor(Color.foreground, Color.accent)),
        String(Style.normalBorderFor(Color.foreground, Color.accent)))
      compare(String(Paint.popupBorder), String(Color.popups.border))
    }

    // Picking applies live and unpicking restores the original bindings — the
    // promise a dropdown that takes effect without a restart is making.
    function test_switching_back_and_forth_restores_the_bindings() {
      scene.followOmarchy()
      var desktopBorder = String(surface.children[1].border.color)
      var desktopAccent = String(Paint.accent)

      scene.pickTheme("fixture-light")
      verify(String(surface.children[1].border.color) !== desktopBorder,
        "the card's border followed the picked theme")

      scene.followOmarchy()
      compare(String(surface.children[1].border.color), desktopBorder,
        "following again restores the card's border")
      compare(String(Paint.accent), desktopAccent)
      compare(String(Paint.popupBorder), String(Color.popups.border))
    }

    // A settings file is not a trusted theme name. Anything unusable is Follow
    // Omarchy, never an error state and never a path.
    function test_an_invalid_stored_theme_falls_back() {
      Paint.available = true
      Paint.themeName = "../../etc/passwd"
      compare(Paint.selected, "", "a traversing name is not a theme")
      // Even if a directory was handed over with it, there is no theme to read.
      Paint.themeDir = "/themes/../../etc/passwd"
      Paint.colorsText = ""
      Paint.shellText = ""
      Paint.rebuild()
      verify(!Paint.active, "an unreadable theme is Follow Omarchy")
      compare(String(Paint.foreground), String(Color.foreground))

      Paint.themeName = ".hidden"
      compare(Paint.selected, "")
      Paint.themeName = "not installed"
      compare(Paint.selected, "")
    }

    // The picker: Follow Omarchy first, then every installed theme by the name
    // a person reads, with the user's copy of a name winning over the installed
    // one.
    function test_the_picker_lists_user_and_system_themes() {
      var catalog = Qt.createQmlObject('import "../../theme"; ThemeCatalog {}', scene)
      catalog.roots = ["/home/u/.config/omarchy/themes", "/usr/share/omarchy/themes"]
      var found = catalog.parse([
        "/usr/share/omarchy/themes/nord/colors.toml",
        "/usr/share/omarchy/themes/catppuccin-latte/colors.toml",
        "/home/u/.config/omarchy/themes/nord/colors.toml",
        "/usr/share/omarchy/themes/../nope/colors.toml",
      ].join("\n"))
      catalog.userThemes = found.user
      catalog.systemThemes = found.system

      compare(catalog.options[0].value, "", "Follow Omarchy is the first choice")
      compare(catalog.options[0].label, "Follow Omarchy")
      compare(catalog.options.length, 3, "one entry per name, plus the default")
      compare(catalog.options[1].label, "Catppuccin Latte")
      compare(catalog.options[2].label, "Nord")
      compare(catalog.directoryFor("nord"), "/home/u/.config/omarchy/themes/nord",
        "the user's copy of a name wins")
      compare(catalog.directoryFor("catppuccin-latte"), "/usr/share/omarchy/themes/catppuccin-latte")
      compare(catalog.directoryFor(""), "", "Follow Omarchy has no directory")
      compare(catalog.directoryFor(".."), "")
      catalog.destroy()
    }

    // The bar is the desktop's surface. Picking a theme for the window must not
    // reach it.
    function test_the_bar_keeps_the_desktop_palette() {
      var before = scene.paintedColours(barPreview, [])
      verify(before.length > 0, "the bar preview paints something")
      scene.pickTheme("fixture-light")
      var after = scene.paintedColours(barPreview, [])
      compare(after.length, before.length)
      for (var i = 0; i < before.length; i++) {
        compare(String(after[i]), String(before[i]), "bar colour " + i + " did not change")
      }
      verify(scene.paintColour(after, Color.popups.text), "the bar still paints the desktop's text colour")
    }

    // The one part of the spin box the wrapper replaces, and the only part of it
    // that came from the shell's baked tokens.
    function test_number_field_background_follows_the_theme() {
      scene.pickTheme("fixture-light")
      var background = numberField.field.background
      verify(background !== null && background !== undefined, "the spin box has a background")
      compare(String(background.color), String(Paint.normalFillFor(Paint.foreground, Paint.accent)))
      verify(!scene.isDesktopNeutral(background.border.color), "its border is the window's, not the desktop's")

      scene.followOmarchy()
      compare(String(numberField.field.background.color),
        String(Style.controlFill(false, false, Paint.foreground, Paint.accent)))
    }
  }
}
