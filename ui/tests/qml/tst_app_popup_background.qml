import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail

// The window's menus and dialogs draw inside the app window, where the
// compositor cannot blur what is behind them. A theme whose popup color is
// see-through for shell flyouts must still give them a solid background, or
// the mail list shows through the menu text.
Item {
  width: 900
  height: 600

  QtObject {
    id: fakeShell
    function hide(_id) {}
  }

  Omamail.Service {
    id: mailService
    shell: fakeShell
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }

  Omamail.App {
    id: app
    service: mailService
    shell: fakeShell
  }

  TestCase {
    name: "AppPopupBackground"
    when: windowShown

    function test_a_see_through_theme_popup_color_draws_solid_in_the_window() {
      compare(app.popupBackground.a, 1, "in-window popups are opaque")
      fuzzyCompare(app.popupBackground.r, 0.11, 0.005, "the theme's hue is kept")
      fuzzyCompare(app.popupBackground.b, 0.12, 0.005, "the theme's hue is kept")
    }
  }
}
