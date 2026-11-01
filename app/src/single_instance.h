#pragma once

#include <QLocalServer>
#include <QLockFile>
#include <QObject>
#include <QString>

// One Omamail per session. Closing the window only hides it, so the mail and
// calendar notifications keep coming; on a desktop with no Dock or tray to
// click, launching Omamail again is the way back. A later launch hands the
// running one what to open and leaves.
//
// Ownership is a lock file, taken before anything else starts: two launches
// at once can both find nobody listening, but only one gets the lock, and
// only the holder ever clears a socket a crash left behind. The other keeps
// knocking until the holder listens.
class SingleInstance : public QObject {
    Q_OBJECT

public:
    enum class Launch { Forwarded, Owner, Failed };

    // `lockDirectory` empty means the session's runtime directory.
    explicit SingleInstance(const QString &name, const QString &lockDirectory = QString(),
                            QObject *parent = nullptr);

    // Hand `payload` to the instance listening under `name`; true once it was
    // written to it.
    static bool forward(const QString &name, const QString &payload, int timeoutMs = 500);

    // Forward to a running instance, or become it. While another launch holds
    // the lock without listening yet, keep trying to forward for `waitMs`.
    Launch claimOrForward(const QString &payload, int waitMs = 10000);

    // Take the lock without waiting; false when another launch holds it.
    bool acquire();
    // Listen for later launches. Only the owner does, and only the owner
    // removes a stale socket of the same name first.
    bool listen();
    bool isOwner() const { return m_owner; }
    QString name() const { return m_name; }

signals:
    void openRequested(const QString &payload);

private:
    QString m_name;
    QLockFile m_lock;
    QLocalServer m_server;
    bool m_owner = false;
};
