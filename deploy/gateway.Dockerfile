FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/rgregg/dashboard-screen-viewer"
LABEL org.opencontainers.image.description="Dashboard Screen Viewer gateway: the only component with storage access"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
USER node
EXPOSE 8080
CMD ["node", "dist/src/gateway-main.js"]
