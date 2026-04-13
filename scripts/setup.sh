#!/bin/bash

# ============================================
# AIDA — Премиальная доска объявлений
# Версия: 3.0 ULTRA
# Файл: scripts/setup.sh
# Описание: Скрипт первоначальной настройки окружения
# ============================================

set -e

# ============================================
# КОНФИГУРАЦИЯ
# ============================================

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ============================================
# ФУНКЦИИ
# ============================================

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# Проверка операционной системы
check_os() {
    log_step "Проверка операционной системы..."
    
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        log_info "ОС: Linux"
        return 0
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        log_info "ОС: macOS"
        return 0
    else
        log_error "Неподдерживаемая ОС: $OSTYPE"
        exit 1
    fi
}

# Установка зависимостей
install_dependencies() {
    log_step "Установка зависимостей..."
    
    if command -v apt-get &> /dev/null; then
        sudo apt-get update
        sudo apt-get install -y \
            curl \
            wget \
            git \
            postgresql-client \
            redis-tools \
            nginx \
            certbot \
            python3-certbot-nginx \
            ffmpeg \
            imagemagick
    elif command -v brew &> /dev/null; then
        brew update
        brew install \
            postgresql \
            redis \
            nginx \
            ffmpeg \
            imagemagick
    else
        log_warn "Не удалось определить пакетный менеджер"
    fi
    
    log_info "Зависимости установлены"
}

# Установка Node.js
install_nodejs() {
    log_step "Установка Node.js..."
    
    if ! command -v node &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
        log_info "Node.js установлен"
    else
        log_info "Node.js уже установлен: $(node --version)"
    fi
}

# Установка Docker
install_docker() {
    log_step "Установка Docker..."
    
    if ! command -v docker &> /dev/null; then
        curl -fsSL https://get.docker.com -o get-docker.sh
        sudo sh get-docker.sh
        sudo usermod -aG docker $USER
        log_info "Docker установлен"
    else
        log_info "Docker уже установлен: $(docker --version)"
    fi
    
    if ! command -v docker-compose &> /dev/null; then
        sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
        sudo chmod +x /usr/local/bin/docker-compose
        log_info "Docker Compose установлен"
    else
        log_info "Docker Compose уже установлен: $(docker-compose --version)"
    fi
}

# Создание .env файла
create_env_file() {
    log_step "Создание .env файла..."
    
    if [ ! -f ".env" ]; then
        cat > .env << EOF
# Node.js
NODE_ENV=development
PORT=3000

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=aida
DB_USER=aida
DB_PASSWORD=$(openssl rand -base64 32)

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=$(openssl rand -base64 32)

# JWT
JWT_SECRET=$(openssl rand -base64 64)
JWT_EXPIRES_IN=7d

# Client
CLIENT_URL=http://localhost:3000

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noreply@aida.ru

# OAuth (опционально)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
YANDEX_CLIENT_ID=
YANDEX_CLIENT_SECRET=
VK_CLIENT_ID=
VK_CLIENT_SECRET=
TELEGRAM_BOT_TOKEN=

# AI (опционально)
YANDEX_CLOUD_FOLDER_ID=
YANDEX_CLOUD_IAM_TOKEN=

# Monitoring
SENTRY_DSN=
EOF
        log_info ".env файл создан"
    else
        log_warn ".env файл уже существует"
    fi
}

# Создание SSL сертификатов (для разработки)
create_ssl_certs() {
    log_step "Создание SSL сертификатов для разработки..."
    
    mkdir -p nginx/ssl
    
    if [ ! -f "nginx/ssl/aida.ru.crt" ]; then
        openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
            -keyout nginx/ssl/aida.ru.key \
            -out nginx/ssl/aida.ru.crt \
            -subj "/C=RU/ST=Moscow/L=Moscow/O=AIDA/CN=localhost"
        log_info "SSL сертификаты созданы"
    else
        log_warn "SSL сертификаты уже существуют"
    fi
}

# Создание директорий
create_directories() {
    log_step "Создание директорий..."
    
    mkdir -p uploads
    mkdir -p uploads/listings
    mkdir -p uploads/avatars
    mkdir -p uploads/chats
    mkdir -p uploads/videos
    mkdir -p uploads/hls
    mkdir -p logs
    mkdir -p backups
    mkdir -p temp
    
    log_info "Директории созданы"
}

# Установка прав
set_permissions() {
    log_step "Установка прав..."
    
    chmod 755 uploads
    chmod 755 logs
    chmod 755 backups
    chmod 755 temp
    
    log_info "Права установлены"
}

# Инициализация базы данных
init_database() {
    log_step "Инициализация базы данных..."
    
    if command -v psql &> /dev/null; then
        sudo -u postgres psql -c "CREATE USER aida WITH PASSWORD 'aida123';" 2>/dev/null || true
        sudo -u postgres psql -c "CREATE DATABASE aida OWNER aida;" 2>/dev/null || true
        log_info "База данных инициализирована"
    else
        log_warn "psql не установлен, пропускаем инициализацию БД"
    fi
}

# Настройка Nginx
configure_nginx() {
    log_step "Настройка Nginx..."
    
    if [ -f "nginx/sites-available/aida.conf" ]; then
        sudo ln -sf "$(pwd)/nginx/sites-available/aida.conf" /etc/nginx/sites-enabled/
        sudo nginx -t && sudo systemctl reload nginx
        log_info "Nginx настроен"
    else
        log_warn "Файл конфигурации Nginx не найден"
    fi
}

# Установка Node.js зависимостей
install_node_deps() {
    log_step "Установка Node.js зависимостей..."
    
    npm install
    log_info "Node.js зависимости установлены"
}

# Запуск миграций
run_migrations() {
    log_step "Запуск миграций..."
    
    node scripts/migrate.js up
    log_info "Миграции выполнены"
}

# Запуск сидов
run_seeds() {
    log_step "Запуск сидов..."
    
    node scripts/seed.js
    log_info "Сиды выполнены"
}

# ============================================
# ОСНОВНАЯ ЛОГИКА
# ============================================

main() {
    log_info "========================================="
    log_info "Первоначальная настройка AIDA"
    log_info "========================================="
    
    check_os
    install_dependencies
    install_nodejs
    install_docker
    create_env_file
    create_ssl_certs
    create_directories
    set_permissions
    init_database
    install_node_deps
    configure_nginx
    run_migrations
    run_seeds
    
    log_info "========================================="
    log_info "Настройка завершена!"
    log_info "Запустите: npm run dev"
    log_info "========================================="
}

# ============================================
# ЗАПУСК
# ============================================

case "${1}" in
    --help|-h)
        echo "Usage: $0"
        echo "Initial setup of AIDA environment"
        exit 0
        ;;
    *)
        main "$@"
        ;;
esac