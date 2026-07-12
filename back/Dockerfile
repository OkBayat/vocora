FROM node:22-alpine AS dependencies

WORKDIR /app/back

COPY back/package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node back ./back
COPY --chown=node:node ui ./ui
COPY --from=dependencies /app/back/node_modules ./back/node_modules

WORKDIR /app/back
USER node

EXPOSE 3000

CMD ["npm", "start"]
