# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV DB_PATH=file:/app/data/todo_bot.db

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Папка для сохранения базы данных SQLite
RUN mkdir -p /app/data

VOLUME ["/app/data"]

CMD ["node", "dist/bot.js"]
