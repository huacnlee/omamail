#include "hyprland_window.h"

#include <QTest>

class HyprlandWindowTest : public QObject {
    Q_OBJECT

private slots:
    void findsOnlyThisProcessParkedOnASpecialWorkspace();
    void dispatchesNameTheWindowAndTheWorkspace();
    void aParkedWindowComesBackByTheLuaDispatches();
    void aRejectedLuaDispatchFallsBackToTheClassicOnes();
    void aWindowOnARegularWorkspaceIsOnlyFocused();
    void noWindowDispatchesNothing();
    void aNamedWorkspaceGoesByItsName();
};

namespace {
// A Hyprland that answers `clients` and `activeworkspace`, and accepts only
// the dispatches `accepts` lets through. `dispatched` records what it was told.
struct FakeHyprland {
    QByteArray clients;
    std::function<bool(const QString &)> accepts;
    QStringList dispatched;
    QByteArray active = R"({"id":4,"name":"4"})";

    HyprlandWindow::Hyprctl hyprctl()
    {
        return [this](const QStringList &arguments, bool *ok) -> QByteArray {
            const QString verb = arguments.first();
            *ok = true;
            if (arguments == QStringList({QStringLiteral("clients"), QStringLiteral("-j")})) return clients;
            if (arguments == QStringList({QStringLiteral("activeworkspace"), QStringLiteral("-j")})) return active;
            if (verb != QStringLiteral("dispatch") || arguments.size() != 2) {
                *ok = false;
                return {};
            }
            dispatched << arguments.at(1);
            return accepts(arguments.at(1)) ? "ok\n" : "Invalid dispatcher\n";
        };
    }
};

const QByteArray parked = R"([{"address":"0xbbb","pid":20,"workspace":{"id":-98,"name":"special:minimized"}}])";
}

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
                 R"([{"address":"0xeee","pid":6,"workspace":{"id":-1337,"name":"work"}}])", 6),
             QString());
    QCOMPARE(HyprlandWindow::parkedAddress(
                 R"([{"address":"0xddd","pid":5,"workspace":{"id":-99,"name":"special:omarchy-minimized"}}])", 5),
             QStringLiteral("0xddd"));
}

void HyprlandWindowTest::dispatchesNameTheWindowAndTheWorkspace()
{
    const QStringList lua = HyprlandWindow::luaDispatches(QStringLiteral("0xbbb"), QStringLiteral("4"));
    QCOMPARE(lua.size(), 2);
    QCOMPARE(lua.at(0), QStringLiteral("hl.dsp.window.move({ workspace = \"4\", window = \"address:0xbbb\" })"));
    QCOMPARE(lua.at(1), QStringLiteral("hl.dsp.focus({ window = \"address:0xbbb\" })"));
    QCOMPARE(HyprlandWindow::classicDispatches(QStringLiteral("0xbbb"), QStringLiteral("4")),
             QStringList({QStringLiteral("movetoworkspace 4,address:0xbbb"),
                          QStringLiteral("focuswindow address:0xbbb")}));
}

void HyprlandWindowTest::aParkedWindowComesBackByTheLuaDispatches()
{
    FakeHyprland hyprland{parked, [](const QString &) { return true; }, {}};
    QVERIFY(HyprlandWindow::bringWindowBack(hyprland.hyprctl(), 20));
    QCOMPARE(hyprland.dispatched, HyprlandWindow::luaDispatches(QStringLiteral("0xbbb"), QStringLiteral("4")));
}

void HyprlandWindowTest::aRejectedLuaDispatchFallsBackToTheClassicOnes()
{
    FakeHyprland hyprland{parked, [](const QString &step) { return !step.startsWith(QStringLiteral("hl.")); }, {}};
    QVERIFY(HyprlandWindow::bringWindowBack(hyprland.hyprctl(), 20));
    const QStringList classic = HyprlandWindow::classicDispatches(QStringLiteral("0xbbb"), QStringLiteral("4"));
    QCOMPARE(hyprland.dispatched,
             QStringList({HyprlandWindow::luaDispatches(QStringLiteral("0xbbb"), QStringLiteral("4")).first()}) + classic);

    FakeHyprland deaf{parked, [](const QString &) { return false; }, {}};
    QVERIFY(!HyprlandWindow::bringWindowBack(deaf.hyprctl(), 20));
}

void HyprlandWindowTest::aWindowOnARegularWorkspaceIsOnlyFocused()
{
    // Numbered or named, the window stays where it is and the focus goes to it.
    for (const QByteArray &clients :
         {QByteArray(R"([{"address":"0xaaa","pid":20,"workspace":{"id":3,"name":"3"}}])"),
          QByteArray(R"([{"address":"0xaaa","pid":20,"workspace":{"id":-1337,"name":"work"}}])")}) {
        FakeHyprland hyprland{clients, [](const QString &) { return true; }, {}};
        QVERIFY(HyprlandWindow::bringWindowBack(hyprland.hyprctl(), 20));
        QCOMPARE(hyprland.dispatched, QStringList({HyprlandWindow::luaFocus(QStringLiteral("0xaaa"))}));
    }
    FakeHyprland classic{R"([{"address":"0xaaa","pid":20,"workspace":{"id":3,"name":"3"}}])",
                         [](const QString &step) { return !step.startsWith(QStringLiteral("hl.")); }, {}};
    QVERIFY(HyprlandWindow::bringWindowBack(classic.hyprctl(), 20));
    QCOMPARE(classic.dispatched.last(), QStringLiteral("focuswindow address:0xaaa"));
}

void HyprlandWindowTest::noWindowDispatchesNothing()
{
    for (const QByteArray &clients :
         {QByteArray("[]"), QByteArray(R"([{"address":"0xaaa","pid":99,"workspace":{"id":3,"name":"3"}}])")}) {
        FakeHyprland hyprland{clients, [](const QString &) { return true; }, {}};
        QVERIFY(!HyprlandWindow::bringWindowBack(hyprland.hyprctl(), 20));
        QVERIFY(hyprland.dispatched.isEmpty());
    }
}

void HyprlandWindowTest::aNamedWorkspaceGoesByItsName()
{
    FakeHyprland hyprland{parked, [](const QString &) { return true; }, {}, R"({"id":-1337,"name":"mail"})"};
    QVERIFY(HyprlandWindow::bringWindowBack(hyprland.hyprctl(), 20));
    QCOMPARE(hyprland.dispatched, HyprlandWindow::luaDispatches(QStringLiteral("0xbbb"), QStringLiteral("name:mail")));
}

QTEST_GUILESS_MAIN(HyprlandWindowTest)
#include "tst_hyprland_window.moc"
