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
