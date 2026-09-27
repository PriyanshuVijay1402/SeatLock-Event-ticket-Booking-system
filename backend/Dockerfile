# One image, two roles: the same build runs as the API (`node dist/server.js`)
# or as the queue worker (`node dist/worker.js`) — see docker-compose.yml.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY db ./db
EXPOSE 4000
CMD ["node", "dist/server.js"]
