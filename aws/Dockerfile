FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3100 \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default

RUN npm install -g paperclipai@2026.609.0

RUN mkdir -p /paperclip/instances/default/secrets /paperclip/instances/default/data/storage

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["paperclipai", "run"]
