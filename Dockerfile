# Production image for the API (dashboard included), the pg-boss worker and the migrate job.
# One image, three commands; docker-compose.prod.yml picks the command per service.
# Build from the repository root: docker build -t personal-api .

FROM node:24.21.0-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# Contracts and rules are consumed from dist, so the filter builds them before api and web.
RUN pnpm --filter "@personal-api/api..." --filter "@personal-api/web..." run --if-present build
# Production-only API package: node_modules without dev dependencies, workspace packages included.
RUN pnpm --filter @personal-api/api deploy --prod /out/api

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    WEB_DIST_DIR=/app/web/dist \
    EXPORT_DIR=/data/exports
WORKDIR /app/api
COPY --from=build /out/api/package.json ./
COPY --from=build /out/api/node_modules ./node_modules
COPY --from=build /out/api/dist ./dist
COPY --from=build /out/api/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist /app/web/dist
# Export files are written here; the API and the worker share the volume mounted at this path.
RUN mkdir -p /data/exports && chown node:node /data/exports
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
