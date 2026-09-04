import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// Wheel scrolling, against real scrollers.
//
// Every assertion here is paired with a bare scroller of the same shape and no
// handler, and asserts the two *differ*. Four of the first round of these
// passed with the component removed — they read `contentY` synchronously after
// `mouseWheel`, before a bare Flickable had advanced a frame, so "it stopped at
// the top" was true of nothing having happened yet. A control that has to move
// differently is the only way to tell the two apart.
Item {
  width: 500
  height: 1400

  // ------------------------------------------------------------- handled

  Flickable {
    id: view
    x: 0; y: 0; width: 400; height: 300
    contentWidth: width
    contentHeight: 5000
    boundsBehavior: Flickable.StopAtBounds

    Omamail.WheelScroller { view: view }
  }

  Flickable {
    id: margined
    x: 0; y: 350; width: 400; height: 300
    contentWidth: width
    contentHeight: 5000
    topMargin: 50
    bottomMargin: 70
    boundsBehavior: Flickable.StopAtBounds

    Omamail.WheelScroller { view: margined }
  }

  ListView {
    id: headed
    x: 0; y: 700; width: 400; height: 300
    model: 100
    boundsBehavior: Flickable.StopAtBounds
    header: Item { width: 400; height: 200 }
    delegate: Item { width: 400; height: 40 }

    Omamail.WheelScroller { view: headed }
  }

  // --------------------------------------------------- the same, unhandled

  Flickable {
    id: bare
    x: 0; y: 1050; width: 400; height: 300
    contentWidth: width
    contentHeight: 5000
    boundsBehavior: Flickable.StopAtBounds
  }

  TestCase {
    name: "WheelScroll"
    when: windowShown

    function init() {
      view.contentY = 0
      margined.contentY = -margined.topMargin
      headed.contentY = headed.originY
      bare.contentY = 0
    }

    // ------------------------------------------------------- the distance

    function test_one_notch_moves_three_lines_worth() {
      mouseWheel(view, 200, 150, 0, -120)
      compare(view.contentY, 120)
    }

    // The whole point. A high-resolution wheel reports one notch as many
    // fractions, and they have to add up to the same distance — which is
    // where a bare Flickable is eight times short.
    function test_a_finely_reporting_wheel_moves_the_same_distance() {
      for (var i = 0; i < 8; i++) mouseWheel(view, 200, 150, 0, -15)
      compare(view.contentY, 120, "eight fractions of a notch are still one notch")

      for (var j = 0; j < 8; j++) mouseWheel(bare, 200, 150, 0, -15)
      wait(400)
      verify(bare.contentY < 60,
        "the same turn on a bare Flickable moves a fraction of it, which is the fault")
    }

    function test_three_notches_move_three_notches() {
      mouseWheel(view, 200, 150, 0, -360)
      compare(view.contentY, 360)
    }

    // Uncapped: ten notches as one event and as ten events agree. A per-event
    // cap put the chunking dependence back at the coarse end.
    function test_a_free_spinning_wheel_is_not_capped() {
      mouseWheel(view, 200, 150, 0, -1200)
      compare(view.contentY, 1200)

      view.contentY = 0
      for (var i = 0; i < 10; i++) mouseWheel(view, 200, 150, 0, -120)
      compare(view.contentY, 1200, "however the ten notches arrive")
    }

    function test_it_scrolls_back_up() {
      view.contentY = 500
      mouseWheel(view, 200, 150, 0, 120)
      compare(view.contentY, 380)
    }

    // ------------------------------------------------------- the bounds

    // A margined view resting in its top margin, scrolled up. The old clamp
    // had a floor of 0, so this moved *down* to 0 in answer to a scroll up and
    // the margin could never be reached again.
    function test_a_scroll_up_in_the_top_margin_stays_there() {
      compare(margined.contentY, -50)
      mouseWheel(margined, 200, 150, 0, 120)
      compare(margined.contentY, -50, "up from the top is not down to zero")
    }

    function test_the_bottom_margin_is_reachable() {
      margined.contentY = 4700
      mouseWheel(margined, 200, 150, 0, -120)
      compare(margined.contentY, 4770,
        "contentHeight + bottomMargin - height, not contentHeight - height")
    }

    // A ListView with a header starts at a negative originY, where the old
    // clamp turned the first notch into a jump to 0 — the height of the header
    // rather than a notch — and then never let it back.
    function test_a_header_does_not_make_the_first_notch_a_jump() {
      compare(headed.originY, -200)
      compare(headed.contentY, -200)

      mouseWheel(headed, 200, 150, 0, -120)
      compare(headed.contentY, -80, "one notch, not two hundred pixels")

      mouseWheel(headed, 200, 150, 0, 120)
      compare(headed.contentY, -200, "and the header comes back")
    }

    function test_it_stops_at_the_bottom() {
      view.contentY = 4700
      mouseWheel(view, 200, 150, 0, -240)
      compare(view.contentY, 4700)
    }
  }
}
