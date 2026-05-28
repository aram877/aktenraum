FROM alpine:3.20

RUN apk add --no-cache \
    restic \
    postgresql-client \
    jq \
    bash

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY verify-backup.sh /usr/local/bin/verify-backup.sh
COPY crontab /etc/cron.d/aktenraum-backup

RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/verify-backup.sh \
 && chmod 0644 /etc/cron.d/aktenraum-backup \
 && crontab /etc/cron.d/aktenraum-backup

CMD ["crond", "-f", "-l", "2"]
