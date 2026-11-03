import QtQuick
import Quickshell
import "Themes.js" as Themes

// The window's own theme choice.
//
// Everything the rest of the window asks about it lives here, so the window's
// service does not carry it: the catalog the settings row lists, the directory
// Paint reads, and the palette file the parts that read colours from a file
// use. A theme name is untrusted — it comes from a settings file, and only a
// plain path segment that names an installed theme is anything but Follow
// Omarchy.
Item {
  id: root

  // Nothing is drawn here: the object exists to hold the window's theme choice.
  visible: false

  // The window's service: where the stored setting, the desktop's palette file
  // and the capability to pick a theme at all come from. Only the Omarchy
  // plugin has an Omarchy theme to offer; the standalone host has its own
  // appearance setting and its own palettes.
  property var host: null

  readonly property bool enabled: host !== null && host.capabilities.appTheme === true
  readonly property var settings: host !== null ? host.settings : null
  readonly property string selected: Themes.normalizeName(settings ? settings.appTheme : null)

  // The palette file this host would use with no theme picked. A host that
  // names one is obeyed, and an empty name is an answer: the standalone host
  // says "" because it has no desktop palette to read. Only a host that names
  // nothing gets the desktop's current theme.
  readonly property string desktopColorsPath: host !== null && host.platform
    && host.platform.calendarPalettePath !== undefined
    ? String(host.platform.calendarPalettePath || "")
    : Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"

  // Every installed Omarchy theme, with the user's copy of a name first. Only a
  // host that can pick a theme reads the directories: the scan is a process,
  // and the standalone window never asks for one.
  // Declared as a property, because a plain object has no default property to
  // hold a child.
  readonly property ThemeCatalog catalog: ThemeCatalog {
    objectName: "theme-catalog"
  }
  readonly property var options: catalog.options
  readonly property string directory: root.enabled ? catalog.directoryFor(root.selected) : ""

  // Where the window draws from, for the parts of the app that read a palette
  // out of a file rather than out of Paint.
  readonly property string colorsPath: Paint.active && Paint.themeDir !== ""
    ? Paint.themeDir + "/colors.toml"
    : root.desktopColorsPath

  function refresh() {
    if (root.enabled) catalog.refresh()
  }

  // What a stored setting is allowed to become: a name that is installed or
  // Follow Omarchy, never an error state.
  function choose(value) {
    if (root.host !== null) root.host.persistSetting("appTheme", Themes.normalizeName(value))
  }

  onEnabledChanged: root.refresh()
  onSelectedChanged: if (root.enabled && root.selected !== Themes.FOLLOW) root.refresh()
  // A theme picked before this window opened needs its directory resolved
  // before the first paint; settings that arrive later go through storedValue.
  Component.onCompleted: Qt.callLater(root.refresh)

  Binding {
    target: Paint
    property: "available"
    value: root.enabled
    restoreMode: Binding.RestoreNone
  }
  Binding {
    target: Paint
    property: "themeName"
    value: root.selected
    restoreMode: Binding.RestoreNone
  }
  Binding {
    target: Paint
    property: "themeDir"
    value: root.directory
    restoreMode: Binding.RestoreNone
  }
}
