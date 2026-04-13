#!/bin/bash

# ============================================
# AIDA — Премиальная доска объявлений
# Версия: 3.0 ULTRA
# Файл: scripts/deploy.sh
# Описание: Скрипт развертывания приложения
# ============================================

set -e

# ============================================
# КОНФИГУРАЦИЯ
# ============================================

# Режим (production, staging, development)
ENV="${ENV:-production}"

# Директории
APP_DIR="/var/www/aida"
BACKUP_DIR="/var/backups/aida"
LOG_DIR="/var/log/aida"

# Git
GIT_REPO="https://github.com/aida/aida.git"
GIT_BRANCH="${GIT_BRANCH:-main}"

# Docker
DOCKER_COMPOSE_FILE="docker/docker-compose.yml"

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

check_prerequisites() {
    log_step "Проверка предусловий..."
    
    # Проверка Docker
    if ! command -v docker &> /dev/null; then
        log_error "Docker не установлен"
        exit 1
    fi
    
    # Проверка Docker Compose
    if ! command -v docker-compose &> /dev/null; then
        log_error "Docker Compose не установлен"
        exit 1
    fi
    
    # Проверка Git
    if ! command -v git &> /dev/null; then
        log_error "Git не установлен"
        exit 1
    fi
    
    # Проверка переменных окружения
    if [ ! -f ".env.${ENV}" ]; then
        log_error "Файл .env.${ENV} не найден"
        exit 1
    fi
    
    log_info "Проверка пройдена"
}

create_directories() {
    log_step "Создание директорий..."
    
    mkdir -p "${APP_DIR}"
    mkdir -p "${BACKUP_DIR}"
    mkdir -p "${LOG_DIR}"
    mkdir -p "${APP_DIR}/uploads"
    mkdir -p "${APP_DIR}/logs"
    mkdir -p "${APP_DIR}/backups"
    
    log_info "Директории созданы"
}

backup_current() {
    log_step "Резервное копирование текущей версии..."
    
    if [ -d "${APP_DIR}/current" ]; then
        local backup_name="pre_deploy_$(date +%Y%m%d_%H%M%S)"
        cp -r "${APP_DIR}/current" "${BACKUP_DIR}/${backup_name}"
        log_info "Бэкап создан: ${backup_name}"
    else
        log_warn "Текущая версия не найдена"
    fi
}

clone_or_pull() {
    log_step "Получение кода..."
    
    if [ -d "${APP_DIR}/repo" ]; then
        cd "${APP_DIR}/repo"
        git fetch origin
        git checkout "${GIT_BRANCH}"
        git pull origin "${GIT_BRANCH}"
        log_info "Код обновлён из репозитория"
    else
        git clone "${GIT_REPO}" "${APP_DIR}/repo"
        cd "${APP_DIR}/repo"
        git checkout "${GIT_BRANCH}"
        log_info "Код склонирован из репозитория"
    fi
}

install_dependencies() {
    log_step "Установка зависимостей..."
    
    cd "${APP_DIR}/repo"
    
    # Копирование .env файла
    cp ".env.${ENV}" ".env"
    
    # Установка Node.js зависимостей
    docker run --rm \
        -v "${PWD}:/app" \
        -w /app \
        node:20-alpine \
        npm ci --only=production
    
    log_info "Зависимости установлены"
}

run_migrations() {
    log_step "Запуск миграций базы данных..."
    
    cd "${APP_DIR}/repo"
    
    docker-compose -f "${DOCKER_COMPOSE_FILE}" run --rm app npm run migrate
    
    log_info "Миграции выполнены"
}

run_seeds() {
    log_step "Запуск сидов (только для development)..."
    
    if [ "${ENV}" = "development" ]; then
        cd "${APP_DIR}/repo"
        docker-compose -f "${DOCKER_COMPOSE_FILE}" run --rm app npm run seed
        log_info "Сиды выполнены"
    else
        log_warn "Сиды пропущены (production окружение)"
    fi
}

build_frontend() {
    log_step "Сборка фронтенда..."
    
    cd "${APP_DIR}/repo"
    
    docker run --rm \
        -v "${PWD}:/app" \
        -w /app \
        node:20-alpine \
        npm run build
    
    log_info "Фронтенд собран"
}

stop_services() {
    log_step "Остановка сервисов..."
    
    cd "${APP_DIR}/repo"
    docker-compose -f "${DOCKER_COMPOSE_FILE}" down
    
    log_info "Сервисы остановлены"
}

start_services() {
    log_step "Запуск сервисов..."
    
    cd "${APP_DIR}/repo"
    docker-compose -f "${DOCKER_COMPOSE_FILE}" up -d
    
    log_info "Сервисы запущены"
}

health_check() {
    log_step "Проверка здоровья..."
    
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if curl -s -f "http://localhost:3000/health" > /dev/null 2>&1; then
            log_info "Сервис здоров!"
            return 0
        fi
        
        log_warn "Попытка ${attempt}/${max_attempts}..."
        sleep 2
        attempt=$((attempt + 1))
    done
    
    log_error "Сервис не ответил после ${max_attempts} попыток"
    exit 1
}

update_symlink() {
    log_step "Обновление символической ссылки..."
    
    rm -rf "${APP_DIR}/current"
    ln -s "${APP_DIR}/repo" "${APP_DIR}/current"
    
    log_info "Ссылка обновлена"
}

cleanup_old_backups() {
    log_step "Очистка старых бэкапов..."
    
    find "${BACKUP_DIR}" -name "pre_deploy_*" -type d -mtime +7 -exec rm -rf {} \;
    
    log_info "Очистка завершена"
}

send_notification() {
    local status=$1
    
    if command -v curl &> /dev/null; then
        if [ -n "${TELEGRAM_BOT_TOKEN}" ] && [ -n "${TELEGRAM_CHAT_ID}" ]; then
            local message="AIDA Deploy: ${status}\nEnvironment: ${ENV}\nBranch: ${GIT_BRANCH}\nTime: $(date)"
            curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
                -d "chat_id=${TELEGRAM_CHAT_ID}" \
                -d "text=${message}" \
                -d "parse_mode=HTML" > /dev/null
        fi
    fi
}

# ============================================
# ОСНОВНАЯ ЛОГИКА
# ============================================

main() {
    log_info "========================================="
    log_info "Начало развертывания AIDA"
    log_info "Окружение: ${ENV}"
    log_info "Ветка: ${GIT_BRANCH}"
    log_info "========================================="
    
    local start_time=$(date +%s)
    
    # Выполнение деплоя
    check_prerequisites
    create_directories
    backup_current
    clone_or_pull
    install_dependencies
    run_migrations
    run_seeds
    build_frontend
    stop_services
    start_services
    health_check
    update_symlink
    cleanup_old_backups
    
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    
    log_info "========================================="
    log_info "Развертывание завершено за ${duration} секунд"
    log_info "========================================="
    
    send_notification "SUCCESS"
}

# ============================================
# ЗАПУСК
# ============================================

case "${1}" in
    --help|-h)
        echo "Usage: $0 [OPTIONS]"
        echo "Options:"
        echo "  --help, -h    Show this help"
        echo "Environment variables:"
        echo "  ENV           Environment (production/staging/development)"
        echo "  GIT_BRANCH    Git branch to deploy"
        exit 0
        ;;
    *)
        main "$@"
        ;;
esac