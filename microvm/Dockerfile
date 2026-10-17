FROM ubuntu:24.04

# Runner MicroVM image. Zipped to S3 and built by CreateMicrovmImage, not pushed
# to ECR. arm64 only.

ARG RUNNER_VERSION=2.335.1
ARG RUNNER_ARCH=arm64
# Bumping the runner? Bump the hash too. Got it from:
#   curl -s https://api.github.com/repos/actions/runner/releases/tags/v2.335.1 \
#     | jq -r '.body' | grep -A1 'linux-arm64.tar.gz'
ARG RUNNER_SHA256=6d1e85bfd1a506a8b17c1f1b9b57dba458ffed90898799aaa9f599520b0d9207

# Node 24 LTS. Same deal, hash comes from:
#   curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt \
#     | grep "node-v${NODE_VERSION}-linux-arm64.tar.gz"
ARG NODE_VERSION=24.18.0
ARG NODE_SHA256=6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        unzip \
        tar \
    && rm -rf /var/lib/apt/lists/*

# Pinned tarball + checksum. Not piping somebody's setup script into bash as root.
RUN curl -fLo /tmp/node.tar.gz \
        "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.gz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.gz

RUN useradd --create-home --uid 1001 --shell /bin/bash runner

RUN mkdir -p /home/runner/actions-runner \
    && cd /home/runner/actions-runner \
    && curl -fLo runner.tar.gz \
        "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz" \
    && echo "${RUNNER_SHA256}  runner.tar.gz" | sha256sum -c - \
    && tar xzf runner.tar.gz \
    && rm runner.tar.gz \
    && ./bin/installdependencies.sh \
    && chown -R runner:runner /home/runner/actions-runner

# SDK baked in at build time. No npm install at boot, no registry in the hot path.
COPY package.json /home/runner/package.json
RUN cd /home/runner && npm install --omit=dev

COPY app.js /home/runner/app.js
COPY entrypoint.sh /home/runner/entrypoint.sh
RUN chmod +x /home/runner/entrypoint.sh \
    && chown -R runner:runner /home/runner

EXPOSE 9000 8080

USER runner
WORKDIR /home/runner

CMD ["node", "/home/runner/app.js"]
