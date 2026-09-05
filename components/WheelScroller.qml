import QtQuick
import "../account/Model.js" as Model

// Wheel scrolling for a Flickable, because the Flickable's own is wrong on a
// mouse that reports finely.
//
// A Flickable answers each wheel event with a flick it then decelerates, so
// the distance depends on how the turn was chopped up rather than on how far
// the wheel went: one notch as a single delta moves about 72 pixels, and the
// same notch reported as eight fractions by a high-resolution wheel moves
// about 9. `Model.wheelScrollTarget` reads the rotation instead, which is the
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

  // A mouse only, said out loud rather than left to the default.
  //
  // A touchpad reports `pixelDelta` and its own momentum, and a Flickable
  // tracks fingers with it properly. Driving one from a derived `angleDelta`
  // at a fixed distance per notch would replace a gesture that follows the
  // hand with a series of jumps, so where Qt can tell a touchpad apart this
  // stays out of the way and the native behaviour survives.
  acceptedDevices: PointerDevice.Mouse

  // Vertical only, which is also why there is no `angleDelta.y === 0` guard in
  // here: Qt filters a horizontal-only wheel before the signal fires, so such
  // a guard is unreachable and a test for it passes with this whole component
  // removed.
  orientation: Qt.Vertical

  onWheel: function(event) {
    if (!root.view) return
    root.view.contentY = Model.wheelScrollTarget(root.view.contentY,
      event.angleDelta.y, root.view.contentHeight, root.view.height,
      root.view.originY, root.view.topMargin, root.view.bottomMargin)
    // Not dead despite `blocking` defaulting true, which stops the Flickable
    // starting a flick from *this* event: a flick already in flight from a
    // drag goes on decelerating from where it was and fights every turn
    // after this one.
    root.view.cancelFlick()
  }
}
