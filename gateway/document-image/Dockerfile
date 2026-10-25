# Dedicated pinned official Node 22 Debian base. Build separately;
# never enable document claims until the image digest and smoke test pass.
FROM docker.io/library/node@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
RUN apt-get update && apt-get install -y --no-install-recommends pandoc libreoffice-writer fonts-noto-cjk fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY document-converter.mjs /opt/honmaru/document-converter.mjs
USER 65534:65534
WORKDIR /tmp
# The document job broker supplies input and collects the output artifact.
# No server or general-purpose host execution is exposed by this image.
