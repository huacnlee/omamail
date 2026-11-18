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

    Omamail.WheelScroller { id: viewScroller; view: view }
  }

  Flickable {
    id: margined
    x: 0; y: 350; width: 400; height: 300
    contentWidth: width
    contentHeight: 5000
    topMargin: 50
    bottomMargin: 70
    boundsBehavior: Flickable.StopAtBounds

    Omamail.WheelScroller { id: marginedScroller; view: margined }
  }

  ListView {
    id: headed
    x: 0; y: 700; width: 400; height: 300
    model: 100
    boundsBehavior: Flickable.StopAtBounds
    header: Item { width: 400; height: 200 }
    delegate: Item { width: 400; height: 40 }

    Omamail.WheelScroller { id: headedScroller; view: headed }
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
      viewScroller.stop()
      marginedScroller.stop()
      headedScroller.stop()
      view.contentY = 0
      margined.contentY = -margined.topMargin
      headed.contentY = headed.originY
      bare.contentY = 0
    }

    // ------------------------------------------------------- the distance

    function test_one_notch_moves_three_lines_worth() {
      mouseWheel(view, 200, 150, 0, -120)
      tryCompare(view, "contentY", 240)
    }

    // The whole point. A high-resolution wheel reports one notch as many
    // fractions, and they have to add up to the same distance — which is
    // where a bare Flickable is eight times short.
    function test_a_finely_reporting_wheel_moves_the_same_distance() {
      for (var i = 0; i < 8; i++) mouseWheel(view, 200, 150, 0, -15)
      tryCompare(view, "contentY", 240, 2000, "eight fractions of a notch are still one notch")

      for (var j = 0; j < 8; j++) mouseWheel(bare, 200, 150, 0, -15)
      wait(400)
      verify(bare.contentY < 60,
        "the same turn on a bare Flickable moves a fraction of it, which is the fault")
    }

    function test_three_notches_move_three_notches() {
      mouseWheel(view, 200, 150, 0, -360)
      tryCompare(view, "contentY", 720)
    }

    // Uncapped: ten notches as one event and as ten events agree. A per-event
    // cap put the chunking dependence back at the coarse end.
    function test_a_free_spinning_wheel_is_not_capped() {
      mouseWheel(view, 200, 150, 0, -1200)
      tryCompare(view, "contentY", 2400)

      view.contentY = 0
      for (var i = 0; i < 10; i++) mouseWheel(view, 200, 150, 0, -120)
      tryCompare(view, "contentY", 2400, 2000, "however the ten notches arrive")
    }

    function test_it_scrolls_back_up() {
      view.contentY = 500
      mouseWheel(view, 200, 150, 0, 120)
      tryCompare(view, "contentY", 260)
    }

    // ------------------------------------------------------- the bounds

    // A margined view resting in its top margin, scrolled up. The old clamp
    // had a floor of 0, so this moved *down* to 0 in answer to a scroll up and
    // the margin could never be reached again.
    function test_a_scroll_up_in_the_top_margin_stays_there() {
      tryCompare(margined, "contentY", -50)
      mouseWheel(margined, 200, 150, 0, 120)
      tryCompare(margined, "contentY", -50, 2000, "up from the top is not down to zero")
    }

    function test_the_bottom_margin_is_reachable() {
      margined.contentY = 4700
      mouseWheel(margined, 200, 150, 0, -120)
      tryCompare(margined, "contentY", 4770, 2000, "contentHeight + bottomMargin - height, not contentHeight - height")
    }

    // A ListView with a header starts at a negative originY, where the old
    // clamp turned the first notch into a jump to 0 — the height of the header
    // rather than a notch — and then never let it back.
    function test_a_header_does_not_make_the_first_notch_a_jump() {
      compare(headed.originY, -200)
      tryCompare(headed, "contentY", -200)

      mouseWheel(headed, 200, 150, 0, -120)
      tryCompare(headed, "contentY", 40, 2000, "one notch, not two hundred pixels")

      mouseWheel(headed, 200, 150, 0, 120)
      tryCompare(headed, "contentY", -200, 2000, "and the header comes back")
    }

    function test_it_stops_at_the_bottom() {
      view.contentY = 4700
      mouseWheel(view, 200, 150, 0, -240)
      tryCompare(view, "contentY", 4700)
    }

    // ------------------------------------------------------- smoothness

    // A notch glides: it has not arrived on the event, and it does arrive.
    function test_a_notch_glides_rather_than_jumps() {
      mouseWheel(view, 200, 150, 0, -120)
      verify(view.contentY < 240, "not there on the same frame")
      tryCompare(view, "contentY", 240)
      verify(!viewScroller.animating, "and stops once it lands")
    }

    // A touchpad moves with the fingers, on the same event.
    function test_fingers_move_the_content_at_once() {
      viewScroller.take(-30, Qt.ScrollBegin)
      viewScroller.take(-30, Qt.ScrollUpdate)
      compare(view.contentY, 60)
      viewScroller.take(0, Qt.ScrollEnd)
    }

    // Lifting mid-swipe coasts on, and the coast ends by itself.
    function test_a_swipe_coasts_after_the_fingers_lift() {
      viewScroller.take(-40, Qt.ScrollBegin)
      for (var i = 0; i < 5; i++) { wait(8); viewScroller.take(-40, Qt.ScrollUpdate) }
      var lifted = view.contentY
      viewScroller.take(0, Qt.ScrollEnd)
      verify(viewScroller.animating, "momentum started")
      tryVerify(function() { return !viewScroller.animating }, 5000)
      verify(view.contentY > lifted + 100, "and carried the content on: " + (view.contentY - lifted))
    }

    // Fingers back on the pad catch it.
    function test_touching_again_stops_the_coast() {
      viewScroller.take(-40, Qt.ScrollBegin)
      for (var i = 0; i < 5; i++) { wait(8); viewScroller.take(-40, Qt.ScrollUpdate) }
      viewScroller.take(0, Qt.ScrollEnd)
      wait(30)
      verify(viewScroller.animating, "still coasting when the fingers come back")
      viewScroller.take(0, Qt.ScrollBegin)
      verify(!viewScroller.animating)
      var caught = view.contentY
      wait(100)
      compare(view.contentY, caught)
    }

    // Holding still before lifting is not a flick.
    function test_a_paused_lift_does_not_coast() {
      viewScroller.take(-40, Qt.ScrollBegin)
      viewScroller.take(-40, Qt.ScrollUpdate)
      wait(200)
      viewScroller.take(0, Qt.ScrollEnd)
      verify(!viewScroller.animating)
    }

    // One small nudge and a lift is not a flick.
    function test_a_single_nudge_does_not_coast() {
      viewScroller.take(-4, Qt.ScrollBegin)
      viewScroller.take(0, Qt.ScrollEnd)
      verify(!viewScroller.animating)
      compare(view.contentY, 4)
    }

    // A platform's own momentum events are followed, with no coast added.
    function test_platform_momentum_is_followed_not_doubled() {
      viewScroller.take(-40, Qt.ScrollBegin)
      for (var i = 0; i < 5; i++) { wait(8); viewScroller.take(-40, Qt.ScrollUpdate) }
      viewScroller.take(0, Qt.ScrollEnd)
      var lifted = view.contentY
      for (var j = 0; j < 20; j++) viewScroller.take(-20, Qt.ScrollMomentum)
      verify(!viewScroller.animating, "the platform's momentum replaces ours")
      compare(view.contentY, lifted + 400)
    }

    // The content shrinking under a glide ends it at the new bottom.
    function test_a_glide_ends_when_the_content_shrinks_under_it() {
      view.contentY = 4000
      mouseWheel(view, 200, 150, 0, -360)
      view.contentHeight = 4400
      tryVerify(function() { return !viewScroller.animating }, 2000)
      compare(view.contentY, 4100)
      view.contentHeight = 5000
    }

    // Something else moving the view wins over a glide.
    function test_a_scripted_scroll_cancels_the_glide() {
      mouseWheel(view, 200, 150, 0, -1200)
      view.contentY = 10
      wait(100)
      compare(view.contentY, 10)
    }
  }
}
