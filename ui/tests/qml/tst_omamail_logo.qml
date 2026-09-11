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
    function test_enter_once_then_trace_and_pause() {
      logo.enter()
      compare(logo.entrance, 0)
      compare(logo.progress, 0)
      tryCompare(logo, "entrance", 1, 1200)
      compare(logo.progress, 0)
      wait(300)
      compare(logo.progress, 0, "pause before the first stroke")
      tryVerify(function() { return logo.progress > 0 }, 500)
      wait(150)
      verify(logo.progress < 0.20, "first vertical stroke must remain visible in progress")
      tryCompare(logo, "progress", 1, 1600)
      wait(2300)
      compare(logo.progress, 1, "completed stroke stays visible during the 2.5 second pause")
      tryVerify(function() { return logo.progress < 1 }, 700)
      compare(logo.entrance, 1, "drawing loop must not repeat the entrance")
      logo.visible = false
      wait(50)
      compare(logo.progress, 0)
      compare(logo.entrance, 0)
      logo.visible = true
      tryCompare(logo, "entrance", 1, 1200)
    }
    function test_trace_starts_at_bottom_left_and_keeps_the_original_shape() {
      compare(logo.tracePoints(0), [[20, 43]])
      compare(logo.tracePoints(0.5), [[20, 43], [20, 24], [32, 37]])
      compare(logo.tracePoints(1), [[20, 43], [20, 24], [32, 37], [44, 24], [44, 43]])
    }
  }
}
