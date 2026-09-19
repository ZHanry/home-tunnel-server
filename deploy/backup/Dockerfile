FROM restic/restic:0.19.1 AS restic
FROM node:24.19.0-alpine
COPY --from=restic /usr/bin/restic /usr/local/bin/restic
COPY runner.mjs /app/runner.mjs
RUN mkdir -p /work /status /restore && chmod 0700 /work /restore
WORKDIR /work
ENTRYPOINT ["node", "/app/runner.mjs"]
CMD ["backup"]
