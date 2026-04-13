#!/bin/bash

# ============================================
# AIDA — Премиальная доска объявлений
# Версия: 3.0 ULTRA
# Файл: scripts/healthcheck.sh
# Описание: Скрипт проверки здоровья сервисов
# ============================================

set -e

# ============================================
# КОНФИГУРАЦИЯ
# ============================================

API_URL="${API_URL:-http://localhost:3000}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-aida}"
DB_USER="${DB_USER:-aida}"
DB_PASSWORD="${DB_PASSWORD:-}"
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"

# Таймауты (в секундах)
TIMEOUT=10
DB_TIMEOUT=5
REDIS_TIMEOUT=5

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

# Проверка API
check_api() {
    log_step "Проверка API (${API_URL})..."
    
    local response=$(curl -s -o /dev/null -w "%{http_code}" --max-time ${TIMEOUT} "${API_URL}/health")
    
    if [ "$response" = "200" ] || [ "$response" = "204" ]; then
        log_info "API здоров"
        return 0
    else
        log_error "API не отвечает (HTTP ${response})"
        return 1
    fi
}

# Проверка базы данных
check_database() {
    log_step "Проверка базы данных..."
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    if psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "SELECT 1" > /dev/null 2>&1; then
        log_info "База данных здорова"
        unset PGPASSWORD
        return 0
    else
        log_error "База данных не отвечает"
        unset PGPASSWORD
        return 1
    fi
}

# Проверка Redis
check_redis() {
    log_step "Проверка Redis..."
    
    if command -v redis-cli &> /dev/null; then
        if [ -n "${REDIS_PASSWORD}" ]; then
            if redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" ping | grep -q "PONG"; then
                log_info "Redis здоров"
                return 0
            else
                log_error "Redis не отвечает"
                return 1
            fi
        else
            if redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" ping | grep -q "PONG"; then
                log_info "Redis здоров"
                return 0
            else
                log_error "Redis не отвечает"
                return 1
            fi
        fi
    else
        log_warn "redis-cli не установлен, пропускаем проверку Redis"
        return 0
    fi
}

# Проверка дискового пространства
check_disk_space() {
    log_step "Проверка дискового пространства..."
    
    local usage=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
    
    if [ "$usage" -lt 90 ]; then
        log_info "Дисковое пространство: ${usage}% использовано"
        return 0
    elif [ "$usage" -lt 95 ]; then
        log_warn "Дисковое пространство: ${usage}% использовано"
        return 0
    else
        log_error "Критически мало дискового пространства: ${usage}%"
        return 1
    fi
}

# Проверка памяти
check_memory() {
    log_step "Проверка памяти..."
    
    local total=$(free -m | awk 'NR==2 {print $2}')
    local used=$(free -m | awk 'NR==2 {print $3}')
    local usage=$((used * 100 / total))
    
    if [ "$usage" -lt 90 ]; then
        log_info "Память: ${usage}% использовано (${used}MB / ${total}MB)"
        return 0
    elif [ "$usage" -lt 95 ]; then
        log_warn "Память: ${usage}% использовано (${used}MB / ${total}MB)"
        return 0
    else
        log_error "Критически мало памяти: ${usage}%"
        return 1
    fi
}

# Проверка процессора
check_cpu() {
    log_step "Проверка процессора..."
    
    local load=$(uptime | awk -F 'load average:' '{print $2}' | cut -d',' -f1 | sed 's/ //g')
    local cores=$(nproc)
    
    log_info "CPU Load: ${load}, Ядер: ${cores}"
    
    # Проверяем, не превышает ли нагрузка количество ядер * 2
    if (( $(echo "$load > $((cores * 2))" | bc -l) )); then
        log_warn "Высокая нагрузка на CPU: ${load}"
        return 0
    else
        return 0
    fi
}

# Проверка количества соединений с БД
check_db_connections() {
    log_step "Проверка соединений с базой данных..."
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    local connections=$(psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "SELECT COUNT(*) FROM pg_stat_activity" | xargs)
    
    unset PGPASSWORD
    
    if [ "$connections" -lt 100 ]; then
        log_info "Соединений с БД: ${connections}"
        return 0
    elif [ "$connections" -lt 200 ]; then
        log_warn "Много соединений с БД: ${connections}"
        return 0
    else
        log_error "Слишком много соединений с БД: ${connections}"
        return 1
    fi
}

# Проверка количества активных пользователей
check_active_users() {
    log_step "Проверка активных пользователей..."
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    local active=$(psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "SELECT COUNT(*) FROM users WHERE last_seen > NOW() - INTERVAL '1 hour'" | xargs)
    
    unset PGPASSWORD
    
    log_info "Активных пользователей за час: ${active}"
    return 0
}

# Генерация отчёта
generate_report() {
    local status=$1
    local timestamp=$(date -Iseconds)
    local report_file="/var/log/aida/healthcheck_${timestamp}.log"
    
    mkdir -p /var/log/aida
    
    cat > "${report_file}" << EOF
========================================
AIDA Healthcheck Report
========================================
Timestamp: ${timestamp}
Status: ${status}
API: ${API_URL}
Database: ${DB_HOST}:${DB_PORT}/${DB_NAME}
Redis: ${REDIS_HOST}:${REDIS_PORT}
========================================
EOF
    
    log_info "Отчёт сохранён: ${report_file}"
}

# Отправка уведомления
send_notification() {
    local status=$1
    
    if command -v curl &> /dev/null; then
        if [ -n "${TELEGRAM_BOT_TOKEN}" ] && [ -n "${TELEGRAM_CHAT_ID}" ]; then
            local message="AIDA Healthcheck: ${status}\nTime: $(date)"
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
    log_info "Запуск проверки здоровья AIDA"
    log_info "========================================="
    
    local failed=0
    
    check_api || failed=$((failed + 1))
    check_database || failed=$((failed + 1))
    check_redis || failed=$((failed + 1))
    check_disk_space || failed=$((failed + 1))
    check_memory || failed=$((failed + 1))
    check_cpu
    check_db_connections || failed=$((failed + 1))
    check_active_users
    
    log_info "========================================="
    
    if [ $failed -eq 0 ]; then
        log_info "ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ УСПЕШНО"
        generate_report "HEALTHY"
        send_notification "HEALTHY"
        exit 0
    else
        log_error "ПРОВАЛЕНО ПРОВЕРОК: ${failed}"
        generate_report "UNHEALTHY"
        send_notification "UNHEALTHY"
        exit 1
    fi
}

# ============================================
# ЗАПУСК
# ============================================

case "${1}" in
    --help|-h)
        echo "Usage: $0"
        echo "Check health of all services"
        echo ""
        echo "Environment variables:"
        echo "  API_URL          API URL (default: http://localhost:3000)"
        echo "  DB_HOST          Database host"
        echo "  DB_PORT          Database port"
        echo "  DB_NAME          Database name"
        echo "  DB_USER          Database user"
        echo "  DB_PASSWORD      Database password"
        echo "  REDIS_HOST       Redis host"
        echo "  REDIS_PORT       Redis port"
        echo "  REDIS_PASSWORD   Redis password"
        echo "  TELEGRAM_BOT_TOKEN   Telegram bot token for notifications"
        echo "  TELEGRAM_CHAT_ID     Telegram chat ID"
        exit 0
        ;;
    *)
        main "$@"
        ;;
esac