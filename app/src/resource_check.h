#pragma once

#include <QString>
#include <QStringList>

struct ResourcePaths {
    QString standaloneQml;
    QString sharedUi;
    QString platformPlugin;
    QString backend;
    QString manifest;
};

struct ResourceCheck {
    bool ok = false;
    QStringList errors;
};

ResourcePaths defaultResourcePaths(const QString &executablePath = {});
ResourceCheck checkResources(const ResourcePaths &paths);
bool runSmokeTest(const ResourcePaths &paths, const QString &readyFile,
                  QString *error = nullptr);
