FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

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
