import qs.Commons
import qs.Commons as Commons
import qs.Ui as ShellUi
import "../theme"

// The shell's PanelToolTip, drawn in the window's own theme.
//
// A tooltip paints itself from a background colour, a text colour and a border
// colour, all of which the kit already exposes. They are simply passed on here.
// With Follow Omarchy they are the values the control defaults to, so the kit's
// own surface spec still applies and the tooltip is the shell's tooltip.
ShellUi.PanelToolTip {
  panelForeground: Paint.active ? Paint.tooltipText : Commons.Color.tooltip.text
  panelBackground: Paint.active ? Paint.tooltipBackground : Commons.Color.tooltip.background
  panelBorder: Paint.active ? Paint.tooltipBorder : Commons.Color.tooltip.border
}
