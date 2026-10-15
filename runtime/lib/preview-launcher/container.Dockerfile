FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
	&& rm -rf /var/lib/apt/lists/*
RUN groupadd -r -g 999 geocluster \
	&& useradd -r -u 998 -g 999 -M gc-files \
	&& groupadd -r -g 997 gc-preview \
	&& useradd -r -u 997 -g 997 -M gc-preview \
	&& useradd -r -u 999 -g 999 -M geocluster
WORKDIR /opt/geocluster-runtime
COPY runtime/lib/file-segments-worker.js runtime/lib/file-segments.js runtime/lib/file-contract.js ./lib/
COPY runtime/lib/preview-launcher/ ./lib/preview-launcher/
COPY runtime/files-server.js ./files-server.js
RUN printf '{"type":"module"}\n' > package.json \
	&& node lib/preview-launcher/build.mjs \
	&& chown -R root:root /opt/geocluster-runtime \
	&& chmod -R go-w /opt/geocluster-runtime \
	&& chmod 4755 lib/preview-launcher/build/preview-launcher
ENV GC_PREVIEW_LAUNCHER_CONTAINER_TEST=1
CMD ["node", "--experimental-vm-modules", "--test", "lib/preview-launcher/launcher.test.mjs"]
