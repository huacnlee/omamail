#include "process.h"

#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QSignalSpy>
#include <QTest>

#include <cerrno>
#include <csignal>
#ifdef Q_OS_WIN
#define NOMINMAX
#include <windows.h>
#endif

class ProcessTest : public QObject {
    Q_OBJECT

private:
    static QVariantList command(const QString &mode,
                                const QVariantList &arguments = {})
    {
        QVariantList result{QStringLiteral(PYTHON_EXECUTABLE),
                            QStringLiteral(RPC_BACKEND_FIXTURE), mode};
        result.append(arguments);
        return result;
    }

private slots:
    void exactArgumentsAndStdin();
    void incrementalUtf8Lines();
    void stderrIsBounded();
    void reportsGracefulAndCrashExits();
    void stoppingKillsTheProcessTree();
    void stoppedProcessTimerCannotKillRapidRestart();
    void restartRequestDuringShutdownKeepsForceKillDeadline();
    void oversizedRecordFailsWithoutEmittingTruncatedFrames();
};

void ProcessTest::exactArgumentsAndStdin()
{
    NativeProcess process;
    process.setCommand(command(QStringLiteral("probe"),
        {QStringLiteral("space here"), QStringLiteral("$(not-a-shell)"),
         QString::fromUtf8("東京")}));
    process.setStdinEnabled(true);
    QSignalSpy lines(&process, &NativeProcess::stdoutLine);
    QSignalSpy exited(&process, &NativeProcess::exited);
    connect(&process, &NativeProcess::started, &process, [&process] {
        process.write(QString::fromUtf8("raw €\nwithout-added-newline"));
        process.closeWriteChannel();
    });

    process.setRunning(true);
    QVERIFY(exited.wait(5000));
    QCOMPARE(exited.takeFirst().at(0).toInt(), 0);
    QCOMPARE(lines.size(), 1);
    const auto result = QJsonDocument::fromJson(lines.at(0).at(0).toString().toUtf8()).object();
    QCOMPARE(result.value(QStringLiteral("argv")).toArray().toVariantList(),
             QVariantList({QStringLiteral("space here"), QStringLiteral("$(not-a-shell)"),
                           QString::fromUtf8("東京")}));
    QCOMPARE(result.value(QStringLiteral("stdin")).toString(),
             QStringLiteral("72617720e282ac0a776974686f75742d61646465642d6e65776c696e65"));
}

void ProcessTest::incrementalUtf8Lines()
{
    NativeProcess process;
    process.setCommand(command(QStringLiteral("utf8")));
    QSignalSpy lines(&process, &NativeProcess::stdoutLine);
    QSignalSpy exited(&process, &NativeProcess::exited);

    process.setRunning(true);
    QVERIFY(exited.wait(5000));
    QCOMPARE(lines.size(), 2);
    QCOMPARE(lines.at(0).at(0).toString(), QString::fromUtf8("first €"));
    QCOMPARE(lines.at(1).at(0).toString(), QString::fromUtf8("second U0001f642"));
}

void ProcessTest::stderrIsBounded()
{
    NativeProcess process;
    process.setCommand(command(QStringLiteral("stderr")));
    QSignalSpy exited(&process, &NativeProcess::exited);

    process.setRunning(true);
    QVERIFY(exited.wait(5000));
    QVERIFY(process.stderrText().toUtf8().size() <= NativeProcess::maximumStderrBytes());
    QCOMPARE(process.stderrText().toUtf8().size(), NativeProcess::maximumStderrBytes());
}

void ProcessTest::reportsGracefulAndCrashExits()
{
    NativeProcess graceful;
    graceful.setCommand(command(QStringLiteral("exit"), {7}));
    QSignalSpy gracefulExit(&graceful, &NativeProcess::exited);
    graceful.setRunning(true);
    QVERIFY(gracefulExit.wait(5000));
    QCOMPARE(gracefulExit.takeFirst().at(0).toInt(), 7);
    QVERIFY(!graceful.running());

    NativeProcess crash;
    crash.setCommand(command(QStringLiteral("crash")));
    QSignalSpy crashExit(&crash, &NativeProcess::exited);
    crash.setRunning(true);
    QVERIFY(crashExit.wait(5000));
    QVERIFY(crashExit.takeFirst().at(0).toInt() != 0);
    QVERIFY(!crash.running());
}

void ProcessTest::stoppingKillsTheProcessTree()
{
    NativeProcess process;
    process.setCommand(command(QStringLiteral("tree")));
    QSignalSpy lines(&process, &NativeProcess::stdoutLine);
    QSignalSpy exited(&process, &NativeProcess::exited);
    process.setRunning(true);
    QTRY_COMPARE_WITH_TIMEOUT(lines.size(), 1, 5000);
    const qint64 descendant = lines.at(0).at(0).toString().toLongLong();
    QVERIFY(descendant > 1);

#ifdef Q_OS_WIN
    HANDLE child = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(descendant));
    QVERIFY(child != nullptr);
#endif
    process.setRunning(false);
    QVERIFY(exited.wait(5000));
#ifdef Q_OS_WIN
    QCOMPARE(WaitForSingleObject(child, 5000), DWORD(WAIT_OBJECT_0));
    CloseHandle(child);
#else
    QTRY_VERIFY_WITH_TIMEOUT(::kill(static_cast<pid_t>(descendant), 0) == -1
                             && errno == ESRCH, 5000);
#endif
}

void ProcessTest::restartRequestDuringShutdownKeepsForceKillDeadline()
{
    NativeProcess process;
    process.setCommand(command(QStringLiteral("resistant")));
    QSignalSpy lines(&process, &NativeProcess::stdoutLine);
    QSignalSpy exited(&process, &NativeProcess::exited);
    QSignalSpy failures(&process, &NativeProcess::failed);
    process.setRunning(true);
    QTRY_COMPARE_WITH_TIMEOUT(lines.size(), 1, 5000);

    process.setRunning(false);
    process.setRunning(true);
    QVERIFY(exited.wait(3000));
    QVERIFY(exited.last().at(0).toInt() != 0);
    QCOMPARE(failures.size(), 1);
    QVERIFY(failures.first().at(0).toString().contains(QStringLiteral("stopping")));

    process.setCommand(command(QStringLiteral("wait")));
    process.setRunning(true);
    QVERIFY(exited.wait(5000));
    QCOMPARE(exited.last().at(0).toInt(), 0);
}

void ProcessTest::stoppedProcessTimerCannotKillRapidRestart()
{
    NativeProcess process;
    process.setCommand(command(QStringLiteral("ready")));
    QSignalSpy lines(&process, &NativeProcess::stdoutLine);
    QSignalSpy exited(&process, &NativeProcess::exited);
    process.setRunning(true);
    QTRY_COMPARE_WITH_TIMEOUT(lines.size(), 1, 5000);
    process.setRunning(false);
    QVERIFY(exited.wait(5000));

    process.setCommand(command(QStringLiteral("wait")));
    process.setRunning(true);
    QVERIFY(exited.wait(5000));
    QCOMPARE(exited.last().at(0).toInt(), 0);
}

void ProcessTest::oversizedRecordFailsWithoutEmittingTruncatedFrames()
{
    NativeProcess process;
    process.setCommand(command(QStringLiteral("oversize")));
    QSignalSpy lines(&process, &NativeProcess::stdoutLine);
    QSignalSpy failures(&process, &NativeProcess::failed);
    QSignalSpy exited(&process, &NativeProcess::exited);
    process.setRunning(true);
    QVERIFY(exited.wait(5000));
    QCOMPARE(lines.size(), 0);
    QCOMPARE(failures.size(), 1);
    QVERIFY(failures.first().at(0).toString().contains(QStringLiteral("too large")));
}

QTEST_MAIN(ProcessTest)
#include "tst_process.moc"
