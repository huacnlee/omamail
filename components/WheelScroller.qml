import QtQuick
import "../account/Model.js" as Model

// Wheel scrolling for a Flickable, because the Flickable's own is wrong on a
// mouse that reports finely.
//
// A Flickable answers each wheel event with a flick it then decelerates, so
// the distance depends on how the turn was chopped up rather than on how far
// the wheel went: one notch as a single delta moves about 43 pixels, and the
// same notch reported as eight fractions by a high-resolution wheel moves
// about 6. `Model.wheelScrollTarget` reads the rotation instead, which is the
// part that does not change.
//
// A handler rather than an Item wrapping one. A Flickable reparents its
// visual children into its content, so an Item dropped inside would be a
// zero-sized thing scrolling along with the list and its handler would never
// see a wheel event. A handler is not reparented: it attaches to the
// Flickable, which is exactly what has to be got in front of.
WheelHandler {
  id: root

  required property Flickable view

  // Vertical only. A horizontal wheel and a touchpad's side-scroll both report
  // `y === 0`, and reading either as a scroll down is how a sideways gesture
  // ends up moving the list.
  onWheel: function(event) {
    if (!root.view || event.angleDelta.y === 0) return
    root.view.contentY = Model.wheelScrollTarget(root.view.contentY,
      event.angleDelta.y, root.view.contentHeight, root.view.height)
    // A flick still in flight would go on decelerating from where it started
    // and fight every turn after this one.
    root.view.cancelFlick()
  }
}
