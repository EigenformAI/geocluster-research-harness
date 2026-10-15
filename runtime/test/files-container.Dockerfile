FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ripgrep \
	&& rm -rf /var/lib/apt/lists/*
RUN groupadd -r -g 999 geocluster && useradd -r -u 999 -g 999 -M geocluster \
	&& useradd -r -u 998 -g 999 -M gc-files \
	&& groupadd -r -g 997 gc-preview && useradd -r -u 997 -g 997 -M gc-preview
WORKDIR /opt/geocluster-runtime
COPY runtime/package.json runtime/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY runtime/lib ./lib
COPY runtime/files-server.js runtime/gate.cjs ./
COPY runtime/test ./test
RUN npm run build:native \
	&& chown -R root:root /opt/geocluster-runtime && chmod -R go-w /opt/geocluster-runtime \
	&& chmod 4755 lib/preview-launcher/build/preview-launcher \
	&& mkdir /workspace && chmod 755 /workspace
ENV FILES_CONTAINER_TEST=1
CMD ["node", "--test", "test/files-container.test.mjs"]
