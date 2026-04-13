#!/bin/bash

# ============================================
# AIDA — Премиальная доска объявлений
# Версия: 3.0 ULTRA
# Файл: scripts/optimize.sh
# Описание: Скрипт оптимизации базы данных и системы
# ============================================

set -e

# ============================================
# КОНФИГУРАЦИЯ
# ============================================

# База данных
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-aida}"
DB_USER="${DB_USER:-aida}"
DB_PASSWORD="${DB_PASSWORD:-}"

# Redis
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"

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

optimize_database() {
    log_step "Оптимизация базы данных..."
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    # Анализ таблиц для обновления статистики
    log_info "Анализ таблиц..."
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "ANALYZE;"
    
    # Очистка dead строк
    log_info "Очистка dead строк..."
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "VACUUM ANALYZE;"
    
    # Перестройка индексов
    log_info "Перестройка индексов..."
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "REINDEX DATABASE ${DB_NAME};"
    
    # Обновление статистики
    log_info "Обновление статистики оптимизатора..."
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "ANALYZE VERBOSE;"
    
    # Очистка старых партиций
    log_info "Очистка старых партиций..."
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "
        DO \$\$
        DECLARE
            partition_name text;
        BEGIN
            FOR partition_name IN 
                SELECT tablename FROM pg_tables 
                WHERE tablename LIKE 'messages_%' 
                   OR tablename LIKE 'listing_views_%'
            LOOP
                EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', partition_name);
            END LOOP;
        END \$\$;
    "
    
    unset PGPASSWORD
    
    log_info "Оптимизация базы данных завершена"
}

optimize_redis() {
    log_step "Оптимизация Redis..."
    
    if command -v redis-cli &> /dev/null; then
        # Очистка старых ключей
        log_info "Очистка старых ключей..."
        
        if [ -n "${REDIS_PASSWORD}" ]; then
            redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" --scan --pattern "session:*" | \
                xargs -r redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" DEL
            
            redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" --scan --pattern "temp:*" | \
                xargs -r redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" DEL
            
            redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" --scan --pattern "cache:*" | \
                xargs -r redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" DEL
        else
            redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" --scan --pattern "session:*" | \
                xargs -r redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" DEL
            
            redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" --scan --pattern "temp:*" | \
                xargs -r redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" DEL
            
            redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" --scan --pattern "cache:*" | \
                xargs -r redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" DEL
        fi
        
        # Очистка памяти
        log_info "Очистка памяти Redis..."
        if [ -n "${REDIS_PASSWORD}" ]; then
            redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" MEMORY PURGE
        else
            redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" MEMORY PURGE
        fi
        
        log_info "Оптимизация Redis завершена"
    else
        log_warn "redis-cli не найден"
    fi
}

optimize_uploads() {
    log_step "Оптимизация загруженных файлов..."
    
    local uploads_dir="/app/uploads"
    
    if [ -d "$uploads_dir" ]; then
        # Оптимизация изображений
        log_info "Оптимизация изображений..."
        
        if command -v find &> /dev/null && command -v mogrify &> /dev/null; then
            find "$uploads_dir" -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \) -exec mogrify -strip -quality 85 {} \;
            log_info "Изображения оптимизированы"
        else
            log_warn "ImageMagick не установлен"
        fi
        
        # Удаление старых временных файлов
        log_info "Удаление старых временных файлов..."
        find "$uploads_dir/temp" -type f -mtime +7 -delete 2>/dev/null || true
        find "$uploads_dir/temp" -type d -empty -delete 2>/dev/null || true
        
        log_info "Оптимизация загруженных файлов завершена"
    else
        log_warn "Директория загрузок не найдена"
    fi
}

optimize_logs() {
    log_step "Оптимизация логов..."
    
    local logs_dir="/app/logs"
    
    if [ -d "$logs_dir" ]; then
        # Ротация логов
        log_info "Ротация логов..."
        
        for log_file in "$logs_dir"/*.log; do
            if [ -f "$log_file" ]; then
                if [ $(stat -c%s "$log_file") -gt 104857600 ]; then
                    mv "$log_file" "${log_file}.old"
                    gzip "${log_file}.old"
                    log_info "Лог файл сжат: $(basename "$log_file")"
                fi
            fi
        done
        
        # Удаление старых логов (старше 30 дней)
        log_info "Удаление старых логов..."
        find "$logs_dir" -name "*.log.*" -type f -mtime +30 -delete
        
        log_info "Оптимизация логов завершена"
    else
        log_warn "Директория логов не найдена"
    fi
}

optimize_nginx() {
    log_step "Перезагрузка Nginx кеша..."
    
    if command -v nginx &> /dev/null; then
        # Очистка кеша Nginx
        if [ -d "/var/cache/nginx" ]; then
            find /var/cache/nginx -type f -delete
            log_info "Кеш Nginx очищен"
        fi
        
        # Перезагрузка конфигурации
        nginx -s reload
        log_info "Nginx перезагружен"
    else
        log_warn "Nginx не установлен"
    fi
}

get_database_size() {
    export PGPASSWORD="${DB_PASSWORD}"
    local size=$(psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "SELECT pg_database_size(current_database())" | xargs)
    unset PGPASSWORD
    echo $((size / 1024 / 1024))
}

send_report() {
    local db_size=$(get_database_size)
    
    log_info "========================================="
    log_info "ОТЧЁТ ОПТИМИЗАЦИИ"
    log_info "Размер базы данных: ${db_size} MB"
    log_info "========================================="
}

# ============================================
# ОСНОВНАЯ ЛОГИКА
# ============================================

main() {
    log_info "========================================="
    log_info "Запуск оптимизации AIDA"
    log_info "========================================="
    
    local start_time=$(date +%s)
    
    optimize_database
    optimize_redis
    optimize_uploads
    optimize_logs
    optimize_nginx
    
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    
    log_info "========================================="
    log_info "Оптимизация завершена за ${duration} секунд"
    log_info "========================================="
    
    send_report
}

# ============================================
# ЗАПУСК
# ============================================

case "${1}" in
    --help|-h)
        echo "Usage: $0"
        echo "Optimize database, redis, uploads, logs and nginx"
        exit 0
        ;;
    *)
        main "$@"
        ;;
esac