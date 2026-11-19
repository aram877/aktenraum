FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8

RUN apk add --no-cache \
    restic \
    postgresql-client \
    jq \
    tar \
    bash

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY verify-backup.sh /usr/local/bin/verify-backup.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh
COPY tar-data.sh /usr/local/bin/tar-data.sh
COPY backup-if-due.sh /usr/local/bin/backup-if-due.sh
COPY start.sh /usr/local/bin/start.sh
COPY crontab /etc/cron.d/aktenraum-backup

RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/verify-backup.sh /usr/local/bin/healthcheck.sh /usr/local/bin/tar-data.sh \
       /usr/local/bin/backup-if-due.sh /usr/local/bin/start.sh \
 && chmod 0644 /etc/cron.d/aktenraum-backup \
 && crontab /etc/cron.d/aktenraum-backup \
 && mkdir -p /status

CMD ["/usr/local/bin/start.sh"]
