#include "app_icon.h"

#include <QFile>
#include <QImage>
#include <QPixmap>
#include <QtEndian>

QIcon iconFromIcns(const QByteArray &icns)
{
    QIcon icon;
    if (icns.size() < 8 || !icns.startsWith("icns")) return icon;
    const int total = qMin<qint64>(icns.size(), qFromBigEndian<quint32>(icns.constData() + 4));
    for (int offset = 8; offset + 8 <= total;) {
        const int size = qFromBigEndian<quint32>(icns.constData() + offset + 4);
        if (size < 8 || offset + size > total) break;
        const QByteArray payload = icns.mid(offset + 8, size - 8);
        if (payload.startsWith("\x89PNG")) {
            const QImage image = QImage::fromData(payload, "PNG");
            if (!image.isNull()) icon.addPixmap(QPixmap::fromImage(image));
        }
        offset += size;
    }
    return icon;
}

QIcon iconFromIcnsFile(const QString &path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return {};
    return iconFromIcns(file.readAll());
}
