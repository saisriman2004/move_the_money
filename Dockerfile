# One image for the API, the migration job and every worker; compose picks the command.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-alpine AS runtime
ENV NODE_ENV=production LOG_FILE=off
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# Never run as root inside the container.
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
