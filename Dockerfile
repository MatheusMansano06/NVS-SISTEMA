# Imagem única: API + frontend estático. Railway detecta este arquivo automaticamente.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY database/package.json database/
RUN npm ci
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build -w @nvs/shared && npm run build -w @nvs/api && npm run build -w @nvs/web

FROM node:22-alpine
ENV NODE_ENV=production WEB_DIST_DIR=/app/apps/web/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY database/package.json database/
RUN npm ci --omit=dev -w @nvs/api -w @nvs/shared -w @nvs/database --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY database database
USER node
EXPOSE 3333
# migrations antes de subir (idempotentes); depois a API
CMD ["sh", "-c", "node database/migrate.mjs up && node apps/api/dist/main.js"]
