import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// Wheel scrolling, against a real Flickable.
//
// The numbers here are the fault: a Flickable answers each wheel event with
// its own flick, so the same turn of the same wheel moves a seventh as far
// when a high-resolution mouse reports it as eight small deltas instead of
// one. Asserting the two are equal is asserting the bug is gone.
Item {
  width: 400
  height: 800

  Flickable {
    id: view
    // Not filling the parent: the second Flickable below has to sit clear of
    // this one, or it covers it and takes the wheel events aimed at it.
    x: 0
    y: 0
    width: 400
    height: 300
    contentWidth: width
    contentHeight: 5000
    boundsBehavior: Flickable.StopAtBounds

    Omamail.WheelScroller { view: view }
  }

  Flickable {
    id: shortView
    x: 0
    y: 400
    width: 400
    height: 300
    contentWidth: width
    contentHeight: 100
    boundsBehavior: Flickable.StopAtBounds

    Omamail.WheelScroller { view: shortView }
  }

  TestCase {
    name: "WheelScroll"
    when: windowShown

    function init() {
      view.contentY = 0
      shortView.contentY = 0
    }

    function test_one_notch_moves_three_lines_worth() {
      mouseWheel(view, 200, 150, 0, -120)
      compare(view.contentY, 120,
        "a notch is 15 degrees, and 8 pixels a degree is what a GTK app moves")
    }

    // The whole point. A high-resolution wheel reports one notch as many
    // fractions of a degree, and they have to add up to the same distance.
    function test_a_finely_reporting_wheel_moves_the_same_distance() {
      for (var i = 0; i < 8; i++) mouseWheel(view, 200, 150, 0, -15)
      compare(view.contentY, 120,
        "eight fractions of a notch are still one notch")
    }

    function test_three_notches_move_three_notches() {
      mouseWheel(view, 200, 150, 0, -360)
      compare(view.contentY, 360)
    }

    function test_it_scrolls_back_up() {
      view.contentY = 500
      mouseWheel(view, 200, 150, 0, 120)
      compare(view.contentY, 380)
    }

    function test_it_stops_at_the_top() {
      mouseWheel(view, 200, 150, 0, 240)
      compare(view.contentY, 0, "there is nothing above the first row")
    }

    function test_it_stops_at_the_bottom() {
      view.contentY = 4700
      mouseWheel(view, 200, 150, 0, -240)
      compare(view.contentY, 4700, "4700 is the last position a 300-tall view can reach")
    }

    // A list shorter than its own viewport has nowhere to go, and a negative
    // limit would let it drift above its first row.
    function test_content_shorter_than_the_view_does_not_move() {
      mouseWheel(shortView, 200, 150, 0, -240)
      compare(shortView.contentY, 0)
      mouseWheel(shortView, 200, 150, 0, 240)
      compare(shortView.contentY, 0)
    }

    // A sideways gesture reports y === 0, and reading it as a scroll down is
    // how a horizontal wheel ends up moving the list.
    function test_a_sideways_wheel_is_not_a_scroll() {
      mouseWheel(view, 200, 150, -120, 0)
      compare(view.contentY, 0)
    }
  }
}
