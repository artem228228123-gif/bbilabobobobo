# ============================================
# AIDA — Премиальная доска объявлений
# Версия: 3.0 ULTRA
# Файл: docker/Dockerfile
# Описание: Docker образ для приложения
# ============================================

# ============================================
# СТАДИЯ 1: БАЗОВЫЙ ОБРАЗ
# ============================================
FROM node:20-alpine AS base

# Установка системных зависимостей
RUN apk add --no-cache \
    curl \
    wget \
    git \
    ca-certificates \
    tzdata \
    ffmpeg \
    imagemagick \
    python3 \
    make \
    g++

# Установка времени
ENV TZ=Europe/Moscow
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Создание директории приложения
WORKDIR /app

# Копирование package.json для кеширования зависимостей
COPY package*.json ./

# ============================================
# СТАДИЯ 2: УСТАНОВКА ЗАВИСИМОСТЕЙ (DEV)
# ============================================
FROM base AS deps-dev
RUN npm ci --only=production=false
COPY . .

# ============================================
# СТАДИЯ 3: УСТАНОВКА ЗАВИСИМОСТЕЙ (PROD)
# ============================================
FROM base AS deps-prod
RUN npm ci --only=production
COPY . .

# ============================================
# СТАДИЯ 4: РАЗРАБОТКА
# ============================================
FROM base AS development
ENV NODE_ENV=development
WORKDIR /app
COPY --from=deps-dev /app/node_modules ./node_modules
COPY . .

# Установка nodemon для горячей перезагрузки
RUN npm install -g nodemon

# Открываем порт
EXPOSE 3000

# Запуск в режиме разработки
CMD ["npm", "run", "dev"]

# ============================================
# СТАДИЯ 5: СБОРКА ДЛЯ ПРОДАКШЕНА
# ============================================
FROM base AS builder
WORKDIR /app
COPY --from=deps-prod /app/node_modules ./node_modules
COPY . .

# Сборка фронтенда (если есть)
RUN npm run build || true

# ============================================
# СТАДИЯ 6: ПРОДАКШЕН
# ============================================
FROM base AS production
ENV NODE_ENV=production
WORKDIR /app

# Создание непривилегированного пользователя
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Копирование собранного приложения
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./
COPY --from=builder --chown=nodejs:nodejs /app/server ./server
COPY --from=builder --chown=nodejs:nodejs /app/config ./config
COPY --from=builder --chown=nodejs:nodejs /app/client ./client
COPY --from=builder --chown=nodejs:nodejs /app/database ./database
COPY --from=builder --chown=nodejs:nodejs /app/scripts ./scripts

# Создание необходимых директорий
RUN mkdir -p /app/uploads /app/logs /app/backups /app/temp && \
    chown -R nodejs:nodejs /app/uploads /app/logs /app/backups /app/temp

# Переключение на непривилегированного пользователя
USER nodejs

# Открываем порт
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Запуск приложения
CMD ["node", "server/server.js"]

# ============================================
# СТАДИЯ 7: МИГРАЦИИ БД
# ============================================
FROM base AS migrations
WORKDIR /app
COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=builder /app/database ./database
COPY --from=builder /app/scripts ./scripts

CMD ["npm", "run", "migrate"]

# ============================================
# СТАДИЯ 8: СИДЫ БД
# ============================================
FROM base AS seeds
WORKDIR /app
COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=builder /app/database ./database
COPY --from=builder /app/scripts ./scripts

CMD ["npm", "run", "seed"]

# ============================================
# СТАДИЯ 9: ТЕСТЫ
# ============================================
FROM base AS test
ENV NODE_ENV=test
WORKDIR /app
COPY --from=deps-dev /app/node_modules ./node_modules
COPY . .

CMD ["npm", "test"]