FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/geocluster-runtime
COPY runtime/package.json runtime/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY runtime/lib/file-contract.js runtime/lib/workbook-reader.js runtime/lib/workbook-reader-worker.cjs ./lib/
COPY runtime/lib/reader-jail.h runtime/lib/reader-seccomp.h ./lib/
COPY runtime/lib/reader-jails/build.mjs ./lib/reader-jails/
COPY runtime/lib/workbook-launcher/ ./lib/workbook-launcher/
COPY runtime/test/workbook-fixtures.mjs runtime/test/workbook-reader.test.mjs ./test/
RUN node lib/workbook-launcher/build.mjs --targetdir=/opt/geocluster-runtime --node=/usr/local/bin/node --worker=/opt/geocluster-runtime/lib/workbook-reader-worker.cjs \
    && chown -R root:root /opt/geocluster-runtime && chmod -R go-w /opt/geocluster-runtime \
    && chmod 4755 /opt/geocluster-runtime/workbook-launcher \
    && node lib/reader-jails/build.mjs --workbook-only \
    && groupadd -g 999 gc-service && useradd -u 998 -g 999 -M gc-service \
    && groupadd -g 997 gc-worker && useradd -u 997 -g 997 -M gc-worker
USER 998:999
ENV WORKBOOK_INSTALLED_LAUNCHER=/opt/geocluster-runtime/workbook-launcher
CMD ["node", "--test", "--test-reporter=spec", "lib/workbook-launcher/launcher.test.mjs", "test/workbook-reader.test.mjs"]
