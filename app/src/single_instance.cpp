#include "single_instance.h"

#include <QDeadlineTimer>
#include <QDir>
#include <QLocalSocket>
#include <QStandardPaths>
#include <QThread>

namespace {
QString lockPath(const QString &name, QString directory)
{
    if (directory.isEmpty())
        directory = QStandardPaths::writableLocation(QStandardPaths::RuntimeLocation);
    if (directory.isEmpty())
        directory = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
    return QDir(directory).filePath(name + QStringLiteral(".lock"));
}
}

SingleInstance::SingleInstance(const QString &name, const QString &lockDirectory, QObject *parent)
    : QObject(parent)
    , m_name(name)
    , m_lock(lockPath(name, lockDirectory))
{
    // A lock is stale only when its process is gone, never because it is old:
    // a session can run for weeks.
    m_lock.setStaleLockTime(0);
    connect(&m_server, &QLocalServer::newConnection, this, [this] {
        while (QLocalSocket *peer = m_server.nextPendingConnection()) {
            connect(peer, &QLocalSocket::disconnected, peer, &QObject::deleteLater);
            connect(peer, &QLocalSocket::readyRead, this, [this, peer] {
                while (peer->canReadLine()) {
                    const QString payload = QString::fromUtf8(peer->readLine()).trimmed();
                    emit openRequested(payload.isEmpty() ? QStringLiteral("{}") : payload);
                }
            });
        }
    });
}

bool SingleInstance::forward(const QString &name, const QString &payload, int timeoutMs)
{
    QLocalSocket socket;
    socket.connectToServer(name);
    if (!socket.waitForConnected(timeoutMs)) return false;
    socket.write(payload.toUtf8() + "\n");
    if (!socket.waitForBytesWritten(timeoutMs)) return false;
    socket.disconnectFromServer();
    return true;
}

SingleInstance::Launch SingleInstance::claimOrForward(const QString &payload, int waitMs)
{
    if (forward(m_name, payload)) return Launch::Forwarded;
    if (acquire()) return Launch::Owner;
    // Another launch owns the session and is still starting: its socket comes
    // once its window is loaded.
    QDeadlineTimer deadline(waitMs);
    while (!deadline.hasExpired()) {
        if (forward(m_name, payload, 200)) return Launch::Forwarded;
        // The owner may have quit meanwhile, leaving the session to this one.
        if (acquire()) return Launch::Owner;
        QThread::msleep(100);
    }
    return Launch::Failed;
}

bool SingleInstance::acquire()
{
    if (!m_owner) m_owner = m_lock.tryLock(0);
    return m_owner;
}

bool SingleInstance::listen()
{
    if (!m_owner) return false;
    if (m_server.isListening()) return true;
    // Holding the lock, nobody else can be listening: a socket by this name
    // is what a crash left behind.
    QLocalServer::removeServer(m_name);
    return m_server.listen(m_name);
}
