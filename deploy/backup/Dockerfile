FROM restic/restic:0.19.1 AS restic
FROM node:24.19.0-alpine
COPY --from=restic /usr/bin/restic /usr/local/bin/restic
COPY deploy/backup/runner.mjs /app/runner.mjs
COPY control-center/package.json /app/package.json
COPY control-center/migrations /app/migrations
RUN mkdir -p /work /status /restore && chmod 0700 /work /restore
WORKDIR /work
ENTRYPOINT ["node", "/app/runner.mjs"]
CMD ["backup"]
