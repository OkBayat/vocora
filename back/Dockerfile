FROM node:22-bookworm-slim AS npm-base
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

FROM npm-base AS backend-dependencies
WORKDIR /app/back
COPY back/package*.json ./
RUN npm ci --omit=dev

FROM npm-base AS ui-build
WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/angular.json ui/tsconfig*.json ./
COPY ui/src ./src
COPY ui/assets ./assets
COPY ui/fonts ./fonts
COPY ui/data ./data
COPY ui/tools ./tools
RUN npm run build:production

FROM node:22-bookworm-slim AS runtime
ARG VOCORA_SOURCE_HASH=manual
ARG VOCORA_WRITING_TOKENIZER=0
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node back ./back
COPY --from=ui-build --chown=node:node /app/ui/dist/browser ./ui
COPY --from=backend-dependencies /app/back/node_modules ./back/node_modules
RUN if [ "$VOCORA_WRITING_TOKENIZER" = "1" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends python3 python3-venv python3-dev build-essential cmake ninja-build libgomp1 && \
      python3 /app/back/scripts/provision-writing-feedback-tokenizer.py --venv /opt/writing-feedback && \
      rm -rf /var/lib/apt/lists/*; \
    elif [ "$VOCORA_WRITING_TOKENIZER" != "0" ]; then \
      echo "VOCORA_WRITING_TOKENIZER must be 0 or 1." >&2; exit 2; \
    fi
RUN mkdir -p /app/back/data/tts-cache && chown node:node /app/back/data/tts-cache
LABEL ir.vocora.source-hash="${VOCORA_SOURCE_HASH}"
WORKDIR /app/back
USER node
EXPOSE 3000
CMD ["npm", "start"]
