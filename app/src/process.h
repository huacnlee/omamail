#pragma once

#include <QByteArray>
#include <QObject>
#include <QProcess>
#include <QTimer>
#include <QVariantList>
#include <QtQml/qqmlregistration.h>

class NativeProcess : public QObject {
    Q_OBJECT
    QML_ELEMENT

    Q_PROPERTY(QVariantList command READ command WRITE setCommand NOTIFY commandChanged)
    Q_PROPERTY(bool running READ running WRITE setRunning NOTIFY runningChanged)
    Q_PROPERTY(bool stdinEnabled READ stdinEnabled WRITE setStdinEnabled NOTIFY stdinEnabledChanged)
    Q_PROPERTY(QString stderrText READ stderrText NOTIFY stderrTextChanged)

public:
    explicit NativeProcess(QObject *parent = nullptr);
    ~NativeProcess() override;

    QVariantList command() const { return m_command; }
    void setCommand(const QVariantList &command);

    bool running() const { return m_running; }
    void setRunning(bool running);

    bool stdinEnabled() const { return m_stdinEnabled; }
    void setStdinEnabled(bool enabled);

    QString stderrText() const { return QString::fromUtf8(m_stderrText); }
    static constexpr qsizetype maximumStderrBytes() { return 64 * 1024; }

    Q_INVOKABLE void write(const QString &text);
    Q_INVOKABLE void closeWriteChannel();
    Q_INVOKABLE void terminate();

signals:
    void commandChanged();
    void runningChanged();
    void stdinEnabledChanged();
    void stderrTextChanged();
    void started();
    void exited(int exitCode);
    void stdoutLine(const QString &line);
    void stderrLine(const QString &line);
    void failed(const QString &error);

private:
    static constexpr qsizetype maximumLineBytes() { return 1024 * 1024; }
    void start();
    void stopTree();
    void killTree();
    void consume(QByteArray &pending, const QByteArray &data, bool standardError);
    void emitLine(QByteArray line, bool standardError);
    void finishPendingLines();
    void setRunningValue(bool running);
    void failStream(const QString &error);
#ifdef Q_OS_WIN
    bool prepareWindowsContainment();
    void clearWindowsStartup();
#endif

    QVariantList m_command;
    bool m_running = false;
    bool m_stdinEnabled = false;
    bool m_exitReported = false;
    bool m_streamFailed = false;
    QProcess m_process;
    QTimer m_forceKill;
    QByteArray m_stdoutPending;
    QByteArray m_stderrPending;
    QByteArray m_stderrText;
    qint64 m_processGroupId = 0;
#ifdef Q_OS_WIN
    void *m_job = nullptr;
    void *m_attributeList = nullptr;
    void *m_extendedStartupInfo = nullptr;
#endif
};
