#!/bin/bash

# ============================================
# AIDA — Премиальная доска объявлений
# Версия: 3.0 ULTRA
# Файл: scripts/migrate.sh
# Описание: Скрипт для запуска миграций базы данных
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

MIGRATIONS_DIR="./database/migrations"
MIGRATIONS_TABLE="migrations"

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

check_database() {
    log_step "Проверка подключения к базе данных..."
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    if psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "SELECT 1" > /dev/null 2>&1; then
        log_info "Подключение к базе данных установлено"
        unset PGPASSWORD
        return 0
    else
        log_error "Не удалось подключиться к базе данных"
        unset PGPASSWORD
        exit 1
    fi
}

ensure_migrations_table() {
    log_step "Проверка таблицы миграций..."
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" << EOF
CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    executed_at TIMESTAMP DEFAULT NOW(),
    duration_ms INTEGER
);
EOF
    
    unset PGPASSWORD
    log_info "Таблица миграций готова"
}

get_executed_migrations() {
    export PGPASSWORD="${DB_PASSWORD}"
    
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id" | xargs
    
    unset PGPASSWORD
}

get_migration_files() {
    ls -1 "${MIGRATIONS_DIR}"/*.sql 2>/dev/null | xargs -n1 basename | sort
}

run_migration() {
    local file=$1
    local filepath="${MIGRATIONS_DIR}/${file}"
    local start_time=$(date +%s%3N)
    
    log_step "Выполнение миграции: ${file}"
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    if psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -f "${filepath}" > /dev/null 2>&1; then
        local end_time=$(date +%s%3N)
        local duration=$((end_time - start_time))
        
        psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "INSERT INTO ${MIGRATIONS_TABLE} (name, duration_ms) VALUES ('${file}', ${duration})" > /dev/null 2>&1
        
        log_info "Миграция ${file} выполнена (${duration}ms)"
        unset PGPASSWORD
        return 0
    else
        log_error "Ошибка выполнения миграции ${file}"
        unset PGPASSWORD
        return 1
    fi
}

rollback_migration() {
    local file=$1
    local rollback_file="${file%.sql}_down.sql"
    local rollback_path="${MIGRATIONS_DIR}/${rollback_file}"
    
    if [ ! -f "$rollback_path" ]; then
        log_error "Rollback файл не найден: ${rollback_file}"
        return 1
    fi
    
    log_step "Откат миграции: ${file}"
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    if psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -f "${rollback_path}" > /dev/null 2>&1; then
        psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "DELETE FROM ${MIGRATIONS_TABLE} WHERE name = '${file}'" > /dev/null 2>&1
        log_info "Миграция ${file} откачена"
        unset PGPASSWORD
        return 0
    else
        log_error "Ошибка отката миграции ${file}"
        unset PGPASSWORD
        return 1
    fi
}

# ============================================
# КОМАНДЫ
# ============================================

cmd_up() {
    log_info "Запуск миграций..."
    
    check_database
    ensure_migrations_table
    
    local executed=$(get_executed_migrations)
    local files=$(get_migration_files)
    local pending=()
    
    for file in $files; do
        if ! echo "$executed" | grep -q "$file"; then
            pending+=("$file")
        fi
    done
    
    if [ ${#pending[@]} -eq 0 ]; then
        log_info "Нет новых миграций"
        return 0
    fi
    
    log_info "Найдено ${#pending[@]} новых миграций"
    
    for file in "${pending[@]}"; do
        if ! run_migration "$file"; then
            log_error "Миграция прервана из-за ошибки"
            exit 1
        fi
    done
    
    log_info "Все миграции выполнены успешно"
}

cmd_down() {
    local steps=${1:-1}
    
    log_info "Откат ${steps} миграции(й)..."
    
    check_database
    ensure_migrations_table
    
    local migrations=$(psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id DESC LIMIT ${steps}" | xargs)
    
    if [ -z "$migrations" ]; then
        log_warn "Нет миграций для отката"
        return 0
    fi
    
    for migration in $migrations; do
        if ! rollback_migration "$migration"; then
            log_error "Откат прерван из-за ошибки"
            exit 1
        fi
    done
    
    log_info "Откачено ${steps} миграции(й)"
}

cmd_reset() {
    log_warn "ВНИМАНИЕ: Это удалит все данные в базе данных!"
    echo -n "Вы уверены? (yes/no): "
    read answer
    
    if [ "$answer" != "yes" ]; then
        log_info "Операция отменена"
        exit 0
    fi
    
    log_step "Сброс базы данных..."
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    # Получаем все таблицы
    local tables=$(psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '${MIGRATIONS_TABLE}'" | xargs)
    
    for table in $tables; do
        psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "DROP TABLE IF EXISTS ${table} CASCADE" > /dev/null 2>&1
    done
    
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "DROP TABLE IF EXISTS ${MIGRATIONS_TABLE} CASCADE" > /dev/null 2>&1
    
    unset PGPASSWORD
    
    log_info "База данных сброшена"
    
    # Запускаем миграции заново
    cmd_up
}

cmd_status() {
    log_info "Статус миграций..."
    
    check_database
    ensure_migrations_table
    
    local executed=$(get_executed_migrations)
    local files=$(get_migration_files)
    
    echo ""
    echo "Миграции:"
    echo "──────────────────────────────────────────────────"
    
    for file in $files; do
        if echo "$executed" | grep -q "$file"; then
            echo -e "${GREEN}✅ ${file} — выполнена${NC}"
        else
            echo -e "${YELLOW}⏳ ${file} — ожидает${NC}"
        fi
    done
    
    echo "──────────────────────────────────────────────────"
    
    local total=$(echo "$files" | wc -l)
    local executed_count=$(echo "$executed" | wc -w)
    local pending_count=$((total - executed_count))
    
    echo "Всего: ${total}"
    echo -e "${GREEN}Выполнено: ${executed_count}${NC}"
    echo -e "${YELLOW}Ожидает: ${pending_count}${NC}"
}

cmd_create() {
    local name=$1
    
    if [ -z "$name" ]; then
        log_error "Укажите имя миграции"
        exit 1
    fi
    
    local timestamp=$(date +"%Y%m%d_%H%M%S")
    local filename="${timestamp}_${name}.sql"
    local filepath="${MIGRATIONS_DIR}/${filename}"
    
    cat > "$filepath" << EOF
-- ============================================
-- AIDA — Премиальная доска объявлений
-- Версия: 3.0 ULTRA
-- Файл: database/migrations/${filename}
-- Описание: ${name}
-- ============================================

-- ============================================
-- UP
-- ============================================


-- ============================================
-- DOWN
-- ============================================

EOF
    
    log_info "Создана миграция: ${filename}"
}

# ============================================
# ОСНОВНАЯ ЛОГИКА
# ============================================

show_help() {
    echo "Usage: $0 [COMMAND] [OPTIONS]"
    echo ""
    echo "Commands:"
    echo "  up, migrate     Run pending migrations"
    echo "  down, rollback [N]  Rollback last N migrations (default: 1)"
    echo "  reset           Drop database and run all migrations"
    echo "  status          Show migrations status"
    echo "  create <name>   Create new migration file"
    echo "  --help, -h      Show this help"
    echo ""
    echo "Environment variables:"
    echo "  DB_HOST         Database host (default: localhost)"
    echo "  DB_PORT         Database port (default: 5432)"
    echo "  DB_NAME         Database name (default: aida)"
    echo "  DB_USER         Database user (default: aida)"
    echo "  DB_PASSWORD     Database password"
}

case "${1}" in
    up|migrate)
        cmd_up
        ;;
    down|rollback)
        cmd_down "$2"
        ;;
    reset)
        cmd_reset
        ;;
    status)
        cmd_status
        ;;
    create)
        cmd_create "$2"
        ;;
    --help|-h)
        show_help
        ;;
    *)
        log_error "Неизвестная команда: ${1}"
        show_help
        exit 1
        ;;
esac