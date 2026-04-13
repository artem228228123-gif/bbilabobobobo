#!/bin/bash

# ============================================
# AIDA — Премиальная доска объявлений
# Версия: 3.0 ULTRA
# Файл: scripts/backup.sh
# Описание: Скрипт резервного копирования базы данных и файлов
# ============================================

set -e

# ============================================
# КОНФИГУРАЦИЯ
# ============================================

# Директории
BACKUP_DIR="/var/backups/aida"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_NAME="aida_backup_${TIMESTAMP}"
TEMP_DIR="/tmp/${BACKUP_NAME}"

# База данных
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-aida}"
DB_USER="${DB_USER:-aida}"
DB_PASSWORD="${DB_PASSWORD:-}"

# Настройки
MAX_BACKUPS=30
UPLOADS_BACKUP=true
LOGS_BACKUP=true
S3_UPLOAD=false
S3_BUCKET="aida-backups"
S3_REGION="ru-msk"

# Цвета для вывода
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

check_dependencies() {
    log_step "Проверка зависимостей..."
    
    local deps=("pg_dump" "psql" "tar" "gzip")
    for dep in "${deps[@]}"; do
        if ! command -v $dep &> /dev/null; then
            log_error "$dep не установлен"
            exit 1
        fi
    done
    
    if [ "$S3_UPLOAD" = true ]; then
        if ! command -v aws &> /dev/null; then
            log_error "aws CLI не установлен"
            exit 1
        fi
    fi
    
    log_info "Все зависимости установлены"
}

create_directories() {
    log_step "Создание директорий..."
    
    mkdir -p "${BACKUP_DIR}"
    mkdir -p "${BACKUP_DIR}/database"
    mkdir -p "${BACKUP_DIR}/uploads"
    mkdir -p "${BACKUP_DIR}/logs"
    mkdir -p "${TEMP_DIR}"
    
    log_info "Директории созданы"
}

backup_database() {
    log_step "Резервное копирование базы данных..."
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    # Создание дампа базы данных
    pg_dump -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" \
        --format=custom \
        --compress=9 \
        --file="${TEMP_DIR}/database.dump" \
        --verbose 2>/dev/null
    
    # Создание SQL дампа для совместимости
    pg_dump -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" \
        --format=plain \
        --no-owner \
        --no-privileges \
        --file="${TEMP_DIR}/database.sql" \
        --verbose 2>/dev/null
    
    # Создание дампа схемы
    pg_dump -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" \
        --schema-only \
        --file="${TEMP_DIR}/schema.sql" \
        --verbose 2>/dev/null
    
    # Создание дампа данных (без схемы)
    pg_dump -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" \
        --data-only \
        --file="${TEMP_DIR}/data.sql" \
        --verbose 2>/dev/null
    
    unset PGPASSWORD
    
    # Получение размера дампа
    local size=$(du -sh "${TEMP_DIR}/database.dump" 2>/dev/null | cut -f1)
    log_info "Дамп базы данных создан (${size})"
}

backup_uploads() {
    if [ "$UPLOADS_BACKUP" = true ]; then
        log_step "Резервное копирование загруженных файлов..."
        
        local uploads_dir="./uploads"
        if [ -d "$uploads_dir" ]; then
            tar -czf "${TEMP_DIR}/uploads.tar.gz" -C "$(dirname "$uploads_dir")" "$(basename "$uploads_dir")" 2>/dev/null
            local size=$(du -sh "${TEMP_DIR}/uploads.tar.gz" 2>/dev/null | cut -f1)
            log_info "Загруженные файлы упакованы (${size})"
        else
            log_warn "Директория загрузок не найдена"
        fi
    fi
}

backup_logs() {
    if [ "$LOGS_BACKUP" = true ]; then
        log_step "Резервное копирование логов..."
        
        local logs_dir="./logs"
        if [ -d "$logs_dir" ]; then
            tar -czf "${TEMP_DIR}/logs.tar.gz" -C "$(dirname "$logs_dir")" "$(basename "$logs_dir")" 2>/dev/null
            local size=$(du -sh "${TEMP_DIR}/logs.tar.gz" 2>/dev/null | cut -f1)
            log_info "Логи упакованы (${size})"
        else
            log_warn "Директория логов не найдена"
        fi
    fi
}

create_manifest() {
    log_step "Создание манифеста..."
    
    cat > "${TEMP_DIR}/manifest.json" << EOF
{
    "backup_name": "${BACKUP_NAME}",
    "timestamp": "$(date -Iseconds)",
    "version": "3.0.0",
    "database": {
        "name": "${DB_NAME}",
        "host": "${DB_HOST}",
        "port": "${DB_PORT}"
    },
    "files": {
        "database_dump": "database.dump",
        "database_sql": "database.sql",
        "schema": "schema.sql",
        "data": "data.sql",
        "uploads": ${UPLOADS_BACKUP},
        "logs": ${LOGS_BACKUP}
    },
    "server": {
        "hostname": "$(hostname)",
        "os": "$(uname -a)"
    }
}
EOF
    
    log_info "Манифест создан"
}

create_archive() {
    log_step "Создание архива..."
    
    cd "${TEMP_DIR}"
    tar -czf "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" * 2>/dev/null
    cd - > /dev/null
    
    local size=$(du -sh "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" 2>/dev/null | cut -f1)
    log_info "Архив создан: ${BACKUP_NAME}.tar.gz (${size})"
}

upload_to_s3() {
    if [ "$S3_UPLOAD" = true ]; then
        log_step "Загрузка в S3..."
        
        aws s3 cp "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" \
            "s3://${S3_BUCKET}/database/${BACKUP_NAME}.tar.gz" \
            --region "${S3_REGION}" 2>/dev/null
        
        log_info "Архив загружен в S3"
    fi
}

cleanup_old_backups() {
    log_step "Очистка старых бэкапов (старше ${MAX_BACKUPS} дней)..."
    
    find "${BACKUP_DIR}" -name "aida_backup_*.tar.gz" -type f -mtime +${MAX_BACKUPS} -delete 2>/dev/null
    find "${BACKUP_DIR}/database" -name "*.dump" -type f -mtime +${MAX_BACKUPS} -delete 2>/dev/null
    find "${BACKUP_DIR}/database" -name "*.sql" -type f -mtime +${MAX_BACKUPS} -delete 2>/dev/null
    
    log_info "Очистка завершена"
}

cleanup_temp() {
    log_step "Очистка временных файлов..."
    rm -rf "${TEMP_DIR}"
    log_info "Временные файлы удалены"
}

send_notification() {
    local status=$1
    local message=$2
    
    if command -v curl &> /dev/null; then
        if [ -n "${TELEGRAM_BOT_TOKEN}" ] && [ -n "${TELEGRAM_CHAT_ID}" ]; then
            curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
                -d "chat_id=${TELEGRAM_CHAT_ID}" \
                -d "text=AIDA Backup: ${status}\n${message}\nTime: $(date)" \
                -d "parse_mode=HTML" > /dev/null 2>&1 || true
        fi
    fi
}

# ============================================
# ОСНОВНАЯ ЛОГИКА
# ============================================

main() {
    log_info "========================================="
    log_info "Запуск резервного копирования AIDA"
    log_info "========================================="
    
    local start_time=$(date +%s)
    
    # Выполнение бэкапа
    check_dependencies
    create_directories
    backup_database
    backup_uploads
    backup_logs
    create_manifest
    create_archive
    upload_to_s3
    cleanup_old_backups
    cleanup_temp
    
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    
    log_info "========================================="
    log_info "Резервное копирование завершено за ${duration} секунд"
    log_info "========================================="
    
    send_notification "SUCCESS" "Backup completed in ${duration}s"
}

# ============================================
# ЗАПУСК
# ============================================

if [ "${1}" = "--help" ] || [ "${1}" = "-h" ]; then
    echo "Usage: $0"
    echo "Options:"
    echo "  --help, -h    Show this help"
    exit 0
fi

main "$@"