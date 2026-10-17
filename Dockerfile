# Build stage
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./dist/db/migrations
COPY stores-template.csv ./stores-template.csv
COPY return-schedule.json ./return-schedule.json
COPY public ./public

# Railway injects PORT; 3000 is only the local/default fallback.
EXPOSE 3000

# The app only reads from disk (exports are stored in PostgreSQL), so run as
# the unprivileged node user.
USER node

CMD ["node", "dist/index.js"]
