#include "process.h"

#ifdef Q_OS_UNIX
#include <csignal>
#include <unistd.h>
#endif

#ifdef Q_OS_WIN
#define NOMINMAX
#include <windows.h>
#endif

NativeProcess::NativeProcess(QObject *parent)
    : QObject(parent)
{
    m_process.setProcessChannelMode(QProcess::SeparateChannels);
#ifdef Q_OS_UNIX
    m_process.setChildProcessModifier([] {
        ::setpgid(0, 0);
    });
#endif
    m_forceKill.setSingleShot(true);
    m_forceKill.setInterval(500);
    connect(&m_forceKill, &QTimer::timeout, this, &NativeProcess::killTree);
    connect(&m_process, &QProcess::started, this, [this] {
        m_processGroupId = m_process.processId();
#ifdef Q_OS_WIN
        clearWindowsStartup();
#endif
        if (!m_stdinEnabled) m_process.closeWriteChannel();
        emit started();
    });
    connect(&m_process, &QProcess::readyReadStandardOutput, this, [this] {
        consume(m_stdoutPending, m_process.readAllStandardOutput(), false);
    });
    connect(&m_process, &QProcess::readyReadStandardError, this, [this] {
        const QByteArray bytes = m_process.readAllStandardError();
        m_stderrText.append(bytes);
        if (m_stderrText.size() > maximumStderrBytes())
            m_stderrText.remove(0, m_stderrText.size() - maximumStderrBytes());
        emit stderrTextChanged();
        consume(m_stderrPending, bytes, true);
    });
    connect(&m_process, &QProcess::errorOccurred, this, [this](QProcess::ProcessError error) {
        if (error != QProcess::FailedToStart || m_exitReported) return;
#ifdef Q_OS_WIN
        clearWindowsStartup();
        killTree();
#endif
        m_forceKill.stop();
        m_exitReported = true;
        setRunningValue(false);
        emit exited(-1);
    });
    connect(&m_process, qOverload<int, QProcess::ExitStatus>(&QProcess::finished),
            this, [this](int exitCode, QProcess::ExitStatus status) {
        m_forceKill.stop();
        if (!m_streamFailed) finishPendingLines();
        killTree();
        setRunningValue(false);
        if (m_exitReported) return;
        m_exitReported = true;
        if (status == QProcess::CrashExit && exitCode == 0) exitCode = -1;
        emit exited(exitCode);
    });
}

NativeProcess::~NativeProcess()
{
    if (m_process.state() != QProcess::NotRunning || m_processGroupId != 0) {
        killTree();
        if (m_process.state() != QProcess::NotRunning) m_process.waitForFinished(1000);
    }
#ifdef Q_OS_WIN
    clearWindowsStartup();
    if (m_job) CloseHandle(static_cast<HANDLE>(m_job));
#endif
}

void NativeProcess::setCommand(const QVariantList &command)
{
    if (m_command == command) return;
    m_command = command;
    emit commandChanged();
}

void NativeProcess::setStdinEnabled(bool enabled)
{
    if (m_stdinEnabled == enabled) return;
    m_stdinEnabled = enabled;
    emit stdinEnabledChanged();
}

void NativeProcess::setRunningValue(bool running)
{
    if (m_running == running) return;
    m_running = running;
    emit runningChanged();
}

void NativeProcess::setRunning(bool running)
{
    if (running == m_running) return;
    if (running) {
        setRunningValue(true);
        start();
    } else {
        setRunningValue(false);
        stopTree();
    }
}

void NativeProcess::start()
{
    if (m_process.state() != QProcess::NotRunning) {
        setRunningValue(false);
        emit failed(QStringLiteral("Process is still stopping"));
        return;
    }
    m_forceKill.stop();
    m_exitReported = false;
    m_streamFailed = false;
    if (m_command.isEmpty()) {
        setRunningValue(false);
        m_exitReported = true;
        emit exited(-1);
        return;
    }
    QString program = m_command.first().toString();
    if (program.isEmpty()) {
        setRunningValue(false);
        m_exitReported = true;
        emit exited(-1);
        return;
    }
    QStringList arguments;
    arguments.reserve(m_command.size() - 1);
    for (qsizetype i = 1; i < m_command.size(); ++i)
        arguments.append(m_command.at(i).toString());

    m_processGroupId = 0;
    m_stdoutPending.clear();
    m_stderrPending.clear();
    if (!m_stderrText.isEmpty()) {
        m_stderrText.clear();
        emit stderrTextChanged();
    }
    m_process.setProgram(program);
    m_process.setArguments(arguments);
    m_process.setInputChannelMode(QProcess::ManagedInputChannel);
#ifdef Q_OS_WIN
    if (!prepareWindowsContainment()) {
        setRunningValue(false);
        m_exitReported = true;
        emit failed(QStringLiteral("Could not establish process-tree containment"));
        emit exited(-1);
        return;
    }
#endif
    m_process.start();
}

void NativeProcess::write(const QString &text)
{
    if (!m_stdinEnabled || m_process.state() == QProcess::NotRunning) return;
    m_process.write(text.toUtf8());
}

void NativeProcess::closeWriteChannel()
{
    if (m_stdinEnabled) m_process.closeWriteChannel();
}

void NativeProcess::terminate()
{
    setRunning(false);
}

void NativeProcess::stopTree()
{
    if (m_process.state() == QProcess::NotRunning && m_processGroupId == 0) return;
#ifdef Q_OS_UNIX
    if (m_processGroupId > 0)
        ::kill(-static_cast<pid_t>(m_processGroupId), SIGTERM);
    else
        m_process.terminate();
#else
    m_process.terminate();
#endif
    m_forceKill.start();
}

void NativeProcess::killTree()
{
#ifdef Q_OS_UNIX
    if (m_processGroupId > 0)
        ::kill(-static_cast<pid_t>(m_processGroupId), SIGKILL);
    else if (m_process.state() != QProcess::NotRunning)
        m_process.kill();
#elif defined(Q_OS_WIN)
    if (m_job) {
        TerminateJobObject(static_cast<HANDLE>(m_job), 1);
        CloseHandle(static_cast<HANDLE>(m_job));
        m_job = nullptr;
    } else if (m_process.state() != QProcess::NotRunning)
        m_process.kill();
#else
    if (m_process.state() != QProcess::NotRunning) m_process.kill();
#endif
    m_processGroupId = 0;
}

void NativeProcess::consume(QByteArray &pending, const QByteArray &data,
                            bool standardError)
{
    if (m_streamFailed) return;
    qsizetype offset = 0;
    while (offset < data.size()) {
        const qsizetype newline = data.indexOf('\n', offset);
        const qsizetype end = newline < 0 ? data.size() : newline;
        const qsizetype length = end - offset;
        if (pending.size() + length >= maximumLineBytes()) {
            failStream(standardError ? QStringLiteral("stderr record is too large")
                                     : QStringLiteral("stdout record is too large"));
            return;
        }
        pending.append(data.constData() + offset, length);
        if (newline < 0) return;
        emitLine(pending, standardError);
        pending.clear();
        offset = newline + 1;
    }
}

void NativeProcess::emitLine(QByteArray line, bool standardError)
{
    if (line.endsWith('\r')) line.chop(1);
    const QString decoded = QString::fromUtf8(line);
    if (standardError) emit stderrLine(decoded);
    else emit stdoutLine(decoded);
}

void NativeProcess::finishPendingLines()
{
    if (!m_stdoutPending.isEmpty()) {
        emitLine(m_stdoutPending, false);
        m_stdoutPending.clear();
    }
    if (!m_stderrPending.isEmpty()) {
        emitLine(m_stderrPending, true);
        m_stderrPending.clear();
    }
}

void NativeProcess::failStream(const QString &error)
{
    if (m_streamFailed) return;
    m_streamFailed = true;
    m_stdoutPending.clear();
    m_stderrPending.clear();
    emit failed(error);
    setRunning(false);
}

#ifdef Q_OS_WIN
bool NativeProcess::prepareWindowsContainment()
{
    clearWindowsStartup();
    if (m_job) {
        CloseHandle(static_cast<HANDLE>(m_job));
        m_job = nullptr;
    }
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) return false;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits))) {
        CloseHandle(job);
        return false;
    }
    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
    auto *attributes = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
        HeapAlloc(GetProcessHeap(), 0, bytes));
    auto *startup = new STARTUPINFOEXW{};
    m_job = job;
    if (!attributes || !startup
        || !InitializeProcThreadAttributeList(attributes, 1, 0, &bytes)
        || !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                      &m_job, sizeof(HANDLE), nullptr, nullptr)) {
        if (attributes) HeapFree(GetProcessHeap(), 0, attributes);
        delete startup;
        CloseHandle(job);
        m_job = nullptr;
        return false;
    }
    startup->lpAttributeList = attributes;
    m_attributeList = attributes;
    m_extendedStartupInfo = startup;
    m_process.setCreateProcessArgumentsModifier([this](QProcess::CreateProcessArguments *args) {
        auto *extended = static_cast<STARTUPINFOEXW *>(m_extendedStartupInfo);
        extended->StartupInfo = *reinterpret_cast<STARTUPINFOW *>(args->startupInfo);
        extended->StartupInfo.cb = sizeof(STARTUPINFOEXW);
        args->startupInfo = reinterpret_cast<Q_STARTUPINFO *>(&extended->StartupInfo);
        args->flags |= EXTENDED_STARTUPINFO_PRESENT;
    });
    return true;
}

void NativeProcess::clearWindowsStartup()
{
    if (m_attributeList) {
        DeleteProcThreadAttributeList(
            static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(m_attributeList));
        HeapFree(GetProcessHeap(), 0, m_attributeList);
        m_attributeList = nullptr;
    }
    delete static_cast<STARTUPINFOEXW *>(m_extendedStartupInfo);
    m_extendedStartupInfo = nullptr;
    m_process.setCreateProcessArgumentsModifier({});
}
#endif
