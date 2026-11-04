import QtQuick
import QtTest
import "../../components" as Components

Item {
  width: 180
  height: 140
  Components.OmamailLogo {
    id: logo
    anchors.centerIn: parent
    foreground: Qt.rgba(0.6, 0.6, 0.6, 1)
    accent: Qt.rgba(0.9, 0.25, 0.25, 1)
  }
  TestCase {
    name: "OmamailLogo"
    when: windowShown
    function test_animation_starts_and_resets_when_hidden() {
      logo.enter()
      compare(logo.entrance, 0)
      compare(logo.progress, 0)
      tryCompare(logo, "entrance", 1, 1200)
      tryVerify(function() { return logo.progress > 0 }, 2000)
      logo.visible = false
      compare(logo.progress, 0)
      compare(logo.entrance, 0)
      logo.visible = true
      tryCompare(logo, "entrance", 1, 1200)
    }
  }
}
