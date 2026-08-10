# syntax=docker/dockerfile:1.7

FROM node:22.23.2-bookworm-slim AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY services/platform-api/package.json services/platform-api/package.json
COPY services/platform-api/prisma services/platform-api/prisma
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build \
    && pnpm --filter @ai-training/platform-api --config.node-linker=hoisted deploy --prod --legacy /output/platform-api

FROM node:22.23.2-bookworm-slim AS runtime

ARG VERSION=0.9.8
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="AI 能力训战平台" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/kennyzhang666/ai_training_platform_core_network"

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHON=/usr/bin/python3 \
    PLATFORM_HOME=/opt/ai-training \
    PATH=/opt/code-agent/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git nginx openssh-client openssl \
      python3 python3-pip python3-venv tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 platform \
    && useradd --uid 10001 --gid 10001 --home-dir /opt/ai-training --shell /usr/sbin/nologin platform

WORKDIR /opt/ai-training

COPY --from=build --chown=10001:10001 /output/platform-api services/platform-api
COPY --from=build --chown=10001:10001 /workspace/apps/web/dist apps/web/dist
COPY --from=build --chown=10001:10001 /workspace/contracts contracts
COPY --from=build --chown=10001:10001 /workspace/docs docs
COPY --from=build --chown=10001:10001 /workspace/executors executors
COPY --from=build --chown=10001:10001 /workspace/grader grader
COPY --from=build --chown=10001:10001 /workspace/challenges challenges
COPY --from=build --chown=10001:10001 /workspace/sandbox sandbox
COPY --from=build --chown=10001:10001 /workspace/tools/engine-dev-kit/requirements.txt tools/engine-dev-kit/requirements.txt
COPY --from=build --chown=10001:10001 /workspace/scripts/evaluation-worker.mjs scripts/evaluation-worker.mjs
COPY --from=build --chown=10001:10001 /workspace/scripts/code-agent-executable.mjs scripts/code-agent-executable.mjs
COPY --from=build --chown=10001:10001 /workspace/scripts/code-agent-local-bridge.mjs scripts/code-agent-local-bridge.mjs
COPY --from=build --chown=10001:10001 /workspace/services/ldap3-gateway services/ldap3-gateway
COPY --from=build --chown=10001:10001 /workspace/deploy/docker deploy/docker
COPY --from=build --chown=10001:10001 /workspace/DEPLOYMENT.html DEPLOYMENT.html
COPY --from=build --chown=10001:10001 /workspace/package.json package.json

RUN set -eux; \
    mkdir -p /opt/ai-training/wheelhouse /tmp/python-requirements; \
    { \
      cat grader/requirements.txt; \
      cat services/ldap3-gateway/requirements.txt; \
      cat tools/engine-dev-kit/requirements.txt; \
      find challenges -type f -path '*/engine/requirements.txt' -exec cat {} \;; \
    } > /tmp/python-requirements/all.txt; \
    python3 -m pip download --disable-pip-version-check --only-binary=:all: \
      --dest /opt/ai-training/wheelhouse --requirement /tmp/python-requirements/all.txt; \
    python3 -m pip install --disable-pip-version-check --no-cache-dir --break-system-packages \
      --requirement grader/requirements.txt --requirement services/ldap3-gateway/requirements.txt; \
    rm -rf /tmp/python-requirements; \
    mkdir -p /var/lib/ai-training /tmp/nginx; \
    chown -R 10001:10001 /opt/ai-training /var/lib/ai-training /tmp/nginx; \
    chmod 0755 deploy/docker/entrypoint.sh

EXPOSE 3000 8080 8081
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/ai-training/deploy/docker/entrypoint.sh"]
CMD ["web"]
