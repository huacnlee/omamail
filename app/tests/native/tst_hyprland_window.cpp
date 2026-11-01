#include "hyprland_window.h"

#include <QTest>

class HyprlandWindowTest : public QObject {
    Q_OBJECT

private slots:
    void findsOnlyThisProcessParkedOnASpecialWorkspace();
    void dispatchesNameTheWindowAndTheWorkspace();
};

void HyprlandWindowTest::findsOnlyThisProcessParkedOnASpecialWorkspace()
{
    const QByteArray clients = R"([
      {"address":"0xaaa","pid":10,"workspace":{"id":3,"name":"3"}},
      {"address":"0xbbb","pid":20,"workspace":{"id":-98,"name":"special:minimized"}},
      {"address":"0xccc","pid":30,"workspace":{"id":2,"name":"2"}}
    ])";
    QCOMPARE(HyprlandWindow::parkedAddress(clients, 20), QStringLiteral("0xbbb"));
    QCOMPARE(HyprlandWindow::parkedAddress(clients, 10), QString());
    QCOMPARE(HyprlandWindow::parkedAddress(clients, 99), QString());
    QCOMPARE(HyprlandWindow::parkedAddress("not json", 20), QString());
    QCOMPARE(HyprlandWindow::parkedAddress(
                 R"([{"address":"0xddd","pid":5,"workspace":{"id":-99,"name":"special:omarchy-minimized"}}])", 5),
             QStringLiteral("0xddd"));
}

void HyprlandWindowTest::dispatchesNameTheWindowAndTheWorkspace()
{
    const QStringList lua = HyprlandWindow::luaDispatches(QStringLiteral("0xbbb"), 4);
    QCOMPARE(lua.size(), 2);
    QCOMPARE(lua.at(0), QStringLiteral("hl.dsp.window.move({ workspace = \"4\", window = \"address:0xbbb\" })"));
    QCOMPARE(lua.at(1), QStringLiteral("hl.dsp.focus({ window = \"address:0xbbb\" })"));
    QCOMPARE(HyprlandWindow::classicDispatches(QStringLiteral("0xbbb"), 4),
             QStringList({QStringLiteral("movetoworkspace 4,address:0xbbb"),
                          QStringLiteral("focuswindow address:0xbbb")}));
}

QTEST_GUILESS_MAIN(HyprlandWindowTest)
#include "tst_hyprland_window.moc"
