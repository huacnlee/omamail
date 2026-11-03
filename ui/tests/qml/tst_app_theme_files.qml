import QtQuick 2.15
import QtTest 1.3
import Quickshell
import "../../theme"

// The theme choice as the window makes it: a stored setting, the catalog's
// answer for where that theme lives, and Paint opening the files there. Nothing
// here hands Paint a palette or asks it to reload; if a choice does not end
// with its file read, the window is drawn in no theme at all.
Item {
  id: scene
  width: 200
  height: 200

  QtObject {
    id: store
    property var files: ({})
    property var reads: []
    signal changed(string path)
    function read(path) {
      var key = String(path)
      reads = reads.concat([key])
      if (!Object.prototype.hasOwnProperty.call(files, key)) return ({ ok: false, text: "", error: "missing" })
      return ({ ok: true, text: String(files[key]), error: "" })
    }
    function watch(path, enabled) {}
  }

  QtObject {
    id: pluginHost
    property var capabilities: ({ appTheme: true })
    property var settings: ({ appTheme: "" })
    property var platform: null
    function persistSetting(key, value) {
      var next = ({})
      for (var name in settings) next[name] = settings[name]
      next[key] = value
      settings = next
    }
  }

  AppTheme { id: chooser; host: pluginHost }


  TestCase {
    name: "AppThemeFiles"
    when: windowShown

    function initTestCase() {
      store.files = ({
        "/themes/alpha/colors.toml": 'foreground = "#4c4f69"\nbackground = "#eff1f5"\naccent = "#8839ef"\n',
        "/themes/beta/colors.toml": 'foreground = "#cdd6f4"\nbackground = "#1e1e2e"\naccent = "#89b4fa"\n'
      })
      Quickshell.fileStore = store
      // What the catalog's `find` prints for these two themes.
      var found = chooser.catalog.parse("/themes/alpha/colors.toml\n/themes/beta/colors.toml\n")
      chooser.catalog.userThemes = found.user
      chooser.catalog.systemThemes = found.system
      compare(chooser.catalog.directoryFor("alpha"), "/themes/alpha")
    }

    function cleanupTestCase() {
      chooser.choose("")
      Quickshell.fileStore = null
    }

    function expectTheme(name, background) {
      tryVerify(function() { return Paint.active && String(Paint.background) === background }, 2000,
        name + " is drawn from its file (active: " + Paint.active + ", file: \""
        + Paint.colorsFile.path + "\", background: " + Paint.background + ")")
      compare(Paint.colorsFile.path, "/themes/" + name + "/colors.toml")
      compare(chooser.colorsPath, "/themes/" + name + "/colors.toml",
        "the calendar reads the theme the window is drawn in")
    }

    function expectFollowing() {
      tryVerify(function() { return !Paint.active }, 2000, "Follow Omarchy draws the desktop")
      compare(Paint.colorsFile.path, "")
      compare(Paint.shellFile.path, "")
    }

    // Follow, a theme, Follow, another theme, and straight across.
    function test_each_choice_ends_with_its_file_read() {
      chooser.choose("")
      expectFollowing()
      chooser.choose("alpha")
      expectTheme("alpha", "#eff1f5")
      chooser.choose("")
      expectFollowing()
      chooser.choose("beta")
      expectTheme("beta", "#1e1e2e")
      chooser.choose("alpha")
      expectTheme("alpha", "#eff1f5")
      chooser.choose("")
      expectFollowing()
    }
  }
}
