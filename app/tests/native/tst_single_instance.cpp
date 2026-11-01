#include "single_instance.h"

#include <QCoreApplication>
#include <QDeadlineTimer>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>
#include <QThread>
#include <QUuid>

#include <atomic>
#include <memory>

class SingleInstanceTest : public QObject {
    Q_OBJECT

private:
    QTemporaryDir m_locks;
    static QString uniqueName()
    {
        return QStringLiteral("omamail-test-") + QUuid::createUuid().toString(QUuid::Id128).left(12);
    }

    // A launch is another process, so it runs here on its own thread while
    // this one keeps the owner's event loop turning. On Windows the server
    // only opens its next pipe from that loop, so a launch made on the
    // owner's thread could never connect.
    template <typename Launch>
    static auto fromAnotherLaunch(Launch launch)
    {
        decltype(launch()) result{};
        std::unique_ptr<QThread> thread(QThread::create([&result, &launch] { result = launch(); }));
        thread->start();
        QDeadlineTimer deadline(10000);
        while (!thread->isFinished() && !deadline.hasExpired()) QTest::qWait(10);
        thread->wait();
        return result;
    }

private slots:
    void onlyOneLaunchOwnsTheSession();
    void aLaterLaunchForwardsAndLeavesTheSocket();
    void concurrentLaunchesStartOneInstance();
    void aSocketWithoutOwnerIsReplacedByTheOwner();
};

void SingleInstanceTest::onlyOneLaunchOwnsTheSession()
{
    const QString name = uniqueName();
    SingleInstance first(name, m_locks.path());
    SingleInstance second(name, m_locks.path());
    QVERIFY(first.acquire());
    QVERIFY(!second.acquire());
    QVERIFY(!second.listen());
}

void SingleInstanceTest::aLaterLaunchForwardsAndLeavesTheSocket()
{
    const QString name = uniqueName();
    SingleInstance owner(name, m_locks.path());
    QVERIFY(owner.acquire());
    QVERIFY(owner.listen());
    QSignalSpy opened(&owner, &SingleInstance::openRequested);

    for (int launch = 0; launch < 2; ++launch) {
        const QString dir = m_locks.path();
        const bool forwarded = fromAnotherLaunch([&name, &dir] {
            SingleInstance later(name, dir);
            return later.claimOrForward(QStringLiteral("{\"mailto\":\"mailto:a@example.com\"}"), 1000)
                       == SingleInstance::Launch::Forwarded
                && !later.isOwner();
        });
        QVERIFY(forwarded);
    }
    QTRY_COMPARE(opened.count(), 2);
    QCOMPARE(opened.at(0).at(0).toString(), QStringLiteral("{\"mailto\":\"mailto:a@example.com\"}"));
}

// The case behind the lock: both launches find nobody listening. Only one may
// start; the other waits for it to listen, hands over its payload and leaves,
// and the owner's socket is still there for the launch after.
void SingleInstanceTest::concurrentLaunchesStartOneInstance()
{
    const QString name = uniqueName();
    SingleInstance owner(name, m_locks.path());
    QCOMPARE(owner.claimOrForward(QStringLiteral("{}"), 0), SingleInstance::Launch::Owner);
    QSignalSpy opened(&owner, &SingleInstance::openRequested);

    std::atomic<int> result{-1};
    const QString dir = m_locks.path();
    std::unique_ptr<QThread> second(QThread::create([&result, name, dir] {
        SingleInstance late(name, dir);
        result = int(late.claimOrForward(QStringLiteral("{\"second\":true}"), 5000));
    }));
    second->start();
    // The owner is still loading its window: not listening yet.
    QTest::qWait(400);
    QCOMPARE(result.load(), -1);
    QVERIFY(owner.listen());
    QTRY_COMPARE_WITH_TIMEOUT(result.load(), int(SingleInstance::Launch::Forwarded), 5000);
    QVERIFY(second->wait(5000));
    QTRY_COMPARE(opened.count(), 1);
    QCOMPARE(opened.at(0).at(0).toString(), QStringLiteral("{\"second\":true}"));

    QVERIFY(fromAnotherLaunch([&name] { return SingleInstance::forward(name, QStringLiteral("{}")); }));
    QTRY_COMPARE(opened.count(), 2);
}

void SingleInstanceTest::aSocketWithoutOwnerIsReplacedByTheOwner()
{
#ifndef Q_OS_UNIX
    QSKIP("Only a Unix socket outlives its process as a file");
#endif
    const QString name = uniqueName();
    // A socket file nobody's lock vouches for, standing in for one a crash
    // left: the owner clears it and takes the name.
    QLocalServer leftover;
    QVERIFY(leftover.listen(name));
    SingleInstance owner(name, m_locks.path());
    QVERIFY(owner.acquire());
    QVERIFY(owner.listen());
    QSignalSpy opened(&owner, &SingleInstance::openRequested);
    QVERIFY(fromAnotherLaunch([&name] { return SingleInstance::forward(name, QStringLiteral("{}")); }));
    QTRY_COMPARE(opened.count(), 1);
}

QTEST_GUILESS_MAIN(SingleInstanceTest)
#include "tst_single_instance.moc"
