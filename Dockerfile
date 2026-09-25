# syntax=docker/dockerfile:1.7

FROM node:25-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

FROM node:25-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}
RUN yarn build

FROM node:25-bookworm-slim AS runtime

# OCI metadata labels
LABEL org.opencontainers.image.title="Omada MCP Server"
LABEL org.opencontainers.image.description="Model Context Protocol server for TP-Link Omada controller APIs"
LABEL org.opencontainers.image.authors="Alex Gibson <alex@algib.com>"
LABEL org.opencontainers.image.url="https://github.com/realtydev/omada-mcp"
LABEL org.opencontainers.image.source="https://github.com/realtydev/omada-mcp"
LABEL org.opencontainers.image.documentation="https://github.com/realtydev/omada-mcp#readme"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn workspaces focus --production
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
