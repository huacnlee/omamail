#!/usr/bin/env python3

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
IMPORTS = ROOT / "app" / "qml" / "imports"


EXPECTED_MODULES = {
    "Quickshell": {
        "singleton Quickshell 1.0 Quickshell.qml",
        "FloatingWindow 1.0 FloatingWindow.qml",
    },
    "Quickshell/Io": {
        "FileView 1.0 FileView.qml",
        "Process 1.0 Process.qml",
        "StdioCollector 1.0 StdioCollector.qml",
        "SplitParser 1.0 SplitParser.qml",
    },
    "qs/Commons": {
        "singleton Style 1.0 Style.qml",
        "singleton Color 1.0 Color.qml",
        "singleton Border 1.0 Border.qml",
    },
    "qs/Ui": {
        "TextField 1.0 TextField.qml",
        "Button 1.0 Button.qml",
        "BorderSurface 1.0 BorderSurface.qml",
        "NumberField 1.0 NumberField.qml",
        "PanelActionButton 1.0 PanelActionButton.qml",
        "PanelSeparator 1.0 PanelSeparator.qml",
        "PanelSectionHeader 1.0 PanelSectionHeader.qml",
        "PanelToolTip 1.0 PanelToolTip.qml",
        "ToggleSwitch 1.0 ToggleSwitch.qml",
        "Dropdown 1.0 Dropdown.qml",
        "BarWidget 1.0 BarWidget.qml",
        "BarIconButton 1.0 BarIconButton.qml",
        "KeyboardPanel 1.0 KeyboardPanel.qml",
    },
}

EXPECTED_MEMBERS = {
    "Quickshell/Quickshell.qml": {
        "nativeHost", "fileStore", "notificationActivated", "env",
        "execDetached", "showNotification",
    },
    "Quickshell/FloatingWindow.qml": {"minimumSize"},
    "Quickshell/Io/Process.qml": {
        "command", "running", "stdinEnabled", "jobMode", "stdout", "stderr",
        "written", "started", "exited", "write", "terminate",
    },
    "Quickshell/Io/FileView.qml": {
        "path", "watchChanges", "printErrors", "atomicWrites", "loaded",
        "fileChanged", "loadFailed", "reload", "text", "setText",
    },
    "Quickshell/Io/SplitParser.qml": {"splitMarker", "read"},
    "Quickshell/Io/StdioCollector.qml": {"waitForEnd", "text", "streamFinished"},
    "qs/Commons/Color.qml": {"foreground", "background", "accent", "urgent", "popups"},
    "qs/Commons/Style.qml": {
        "cornerRadius", "normalBorderWidth", "normalBorderColor",
        "selectedAccentFill", "font", "spacing", "spacingScale", "space",
        "hoverFillFor", "selectedFillFor", "selectedStateColor",
        "selectionFillFor", "pressedFillFor", "normalFillFor",
        "normalBorderFor", "hoverBorderFor", "mutedColorFor",
    },
    "qs/Commons/Border.qml": {"controlSpec", "flat"},
    "qs/Ui/TextField.qml": {"password", "foreground", "accent", "verticalPadding", "horizontalPadding"},
    "qs/Ui/Button.qml": {
        "text", "tooltipText", "foreground", "accent", "background", "bordered",
        "selected", "hasCursor", "leftAlign", "focusable", "fontFamily",
        "fontSize", "horizontalPadding", "verticalPadding", "clicked", "hovered",
    },
    "qs/Ui/NumberField.qml": {
        "label", "value", "from", "to", "stepSize", "foreground", "accent",
        "fontFamily", "fontSize", "fieldWidth", "modified",
    },
    "qs/Ui/ToggleSwitch.qml": {
        "checked", "busy", "foreground", "accent", "toggled",
    },
    "qs/Ui/Dropdown.qml": {
        "label", "value", "options", "foreground", "background", "popupBorder",
        "accent", "fontFamily", "rowHeight", "popupRowHeight", "showLabel",
        "hasCursor", "popupOpen", "changed", "hovered",
    },
    "qs/Ui/BorderSurface.qml": {"borderSpec"},
    "qs/Ui/PanelActionButton.qml": {
        "iconText", "tooltipText", "foreground", "hoverColor", "fontFamily",
        "fontSize", "focusable", "hasCursor", "bordered", "clicked", "hovered",
    },
    "qs/Ui/PanelSeparator.qml": {"foreground"},
    "qs/Ui/PanelSectionHeader.qml": {"foreground", "fontFamily"},
    "qs/Ui/PanelToolTip.qml": {"fontFamily"},
    "qs/Ui/BarWidget.qml": {"bar", "moduleName", "settings", "vertical", "barSize"},
    "qs/Ui/BarIconButton.qml": {
        "bar", "iconComponent", "tooltipText", "slotSize", "opticalSize", "active",
        "foreground", "pressed", "wheelMoved",
    },
    "qs/Ui/KeyboardPanel.qml": {
        "anchorItem", "owner", "bar", "open", "contentWidth", "contentHeight",
        "margin", "padding", "centerOnBar", "gap", "popoutSwitching",
        "popoutSwitchClosing", "focusPrimed", "focusTarget",
    },
}


class QmlInventoryTest(unittest.TestCase):
    def test_production_modules_export_the_shared_host_surface(self):
        for relative, expected in EXPECTED_MODULES.items():
            module = IMPORTS / relative
            qmldir = module / "qmldir"
            self.assertTrue(qmldir.is_file(), f"missing {qmldir.relative_to(ROOT)}")
            declarations = {
                line.strip()
                for line in qmldir.read_text().splitlines()
                if line.strip() and not line.startswith("module ")
            }
            self.assertEqual(expected, declarations, relative)
            for declaration in declarations:
                filename = declaration.rsplit(" ", 1)[1]
                self.assertTrue((module / filename).is_file(), f"missing {relative}/{filename}")

    def test_production_imports_do_not_reach_into_the_omarchy_shell(self):
        forbidden = re.compile(r"/usr/share/omarchy/shell|ui/tests/qml/imports")
        for path in IMPORTS.rglob("*.qml"):
            self.assertIsNone(forbidden.search(path.read_text()), str(path.relative_to(ROOT)))

    def test_production_types_keep_every_consumed_custom_member(self):
        declaration = re.compile(r"\b(?:property(?:\s+\w+)*|signal|function)\s+(\w+)")
        for relative, expected in EXPECTED_MEMBERS.items():
            source = (IMPORTS / relative).read_text()
            actual = set(declaration.findall(source))
            self.assertFalse(expected - actual, f"{relative}: missing {sorted(expected - actual)}")

    def test_standalone_palette_has_no_literal_ui_colors(self):
        literal = re.compile(r"#[0-9a-fA-F]{3,8}|\b(?:white|black|gray|grey|red|orange)\b")
        for relative in ("qs/Commons", "qs/Ui"):
            for path in (IMPORTS / relative).glob("*.qml"):
                source = "\n".join(
                    line.split("//", 1)[0] for line in path.read_text().splitlines()
                )
                self.assertIsNone(literal.search(source), str(path.relative_to(ROOT)))


if __name__ == "__main__":
    unittest.main()
