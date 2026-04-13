#!/bin/bash

# ============================================
# AIDA — Премиальная доска объявлений
# Версия: 3.0 ULTRA
# Файл: scripts/seed.sh
# Описание: Скрипт для наполнения базы данных тестовыми данными
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

# Количество записей
USERS_COUNT="${USERS_COUNT:-50}"
LISTINGS_COUNT="${LISTINGS_COUNT:-200}"
FAVORITES_PER_USER="${FAVORITES_PER_USER:-10}"
REVIEWS_COUNT="${REVIEWS_COUNT:-100}"

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

check_node() {
    log_step "Проверка Node.js..."
    
    if ! command -v node &> /dev/null; then
        log_error "Node.js не установлен"
        exit 1
    fi
    
    log_info "Node.js версия: $(node --version)"
}

run_seed() {
    log_step "Запуск сидов..."
    
    export DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD
    export USERS_COUNT LISTINGS_COUNT FAVORITES_PER_USER REVIEWS_COUNT
    
    if [ -f "scripts/seed.js" ]; then
        node scripts/seed.js
    else
        log_error "Файл scripts/seed.js не найден"
        exit 1
    fi
}

seed_categories() {
    log_step "Заполнение категорий..."
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" << EOF
INSERT INTO categories (name, slug, icon, order_index) VALUES
    ('Транспорт', 'transport', '🚗', 1),
    ('Недвижимость', 'realty', '🏠', 2),
    ('Работа', 'jobs', '💼', 3),
    ('Услуги', 'services', '🔧', 4),
    ('Личные вещи', 'personal', '👕', 5),
    ('Для дома и дачи', 'home', '🛋️', 6),
    ('Электроника', 'electronics', '📱', 7),
    ('Хобби и отдых', 'hobby', '🎮', 8),
    ('Животные', 'animals', '🐕', 9),
    ('Бизнес', 'business', '🏭', 10)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO categories (parent_id, name, slug, icon, order_index) VALUES
    ((SELECT id FROM categories WHERE slug = 'transport'), 'Автомобили', 'cars', '🚙', 1),
    ((SELECT id FROM categories WHERE slug = 'transport'), 'Мотоциклы', 'motorcycles', '🏍️', 2),
    ((SELECT id FROM categories WHERE slug = 'realty'), 'Квартиры', 'apartments', '🏢', 1),
    ((SELECT id FROM categories WHERE slug = 'realty'), 'Дома', 'houses', '🏡', 2),
    ((SELECT id FROM categories WHERE slug = 'electronics'), 'Телефоны', 'phones', '📱', 1),
    ((SELECT id FROM categories WHERE slug = 'electronics'), 'Ноутбуки', 'laptops', '💻', 2)
ON CONFLICT (slug) DO NOTHING;
EOF
    
    unset PGPASSWORD
    log_info "Категории заполнены"
}

seed_admin() {
    log_step "Создание администратора..."
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    local password_hash=$(node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('Admin123!', 10).then(hash => console.log(hash))")
    
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" << EOF
INSERT INTO users (name, email, password_hash, role, status, email_verified)
VALUES ('Администратор', 'admin@aida.ru', '${password_hash}', 'admin', 'active', true)
ON CONFLICT (email) DO NOTHING;
EOF
    
    unset PGPASSWORD
    log_info "Администратор создан"
}

seed_test_users() {
    log_step "Создание тестовых пользователей..."
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    for i in $(seq 1 5); do
        local password_hash=$(node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('Test123!', 10).then(hash => console.log(hash))")
        
        psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" << EOF
INSERT INTO users (name, email, password_hash, phone, city, status, email_verified)
VALUES (
    'Тест Пользователь ${i}',
    'test${i}@test.ru',
    '${password_hash}',
    '+7${i}123456789',
    'Москва',
    'active',
    true
)
ON CONFLICT (email) DO NOTHING;
EOF
    done
    
    unset PGPASSWORD
    log_info "Тестовые пользователи созданы"
}

seed_test_listings() {
    log_step "Создание тестовых объявлений..."
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    local categories=$(psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "SELECT id FROM categories WHERE parent_id IS NOT NULL LIMIT 5" | xargs)
    local users=$(psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -c "SELECT id FROM users WHERE email LIKE 'test%@test.ru' LIMIT 5" | xargs)
    
    local category_array=($categories)
    local user_array=($users)
    
    for i in $(seq 1 20); do
        local category_id=${category_array[$((RANDOM % ${#category_array[@]}))]}
        local user_id=${user_array[$((RANDOM % ${#user_array[@]}))]}
        local price=$((RANDOM % 100000 + 1000))
        
        psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" << EOF
INSERT INTO listings (user_id, category_id, title, description, price, city, status, views, likes)
VALUES (
    ${user_id},
    ${category_id},
    'Тестовое объявление ${i}',
    'Это тестовое объявление для демонстрации функционала.',
    ${price},
    'Москва',
    'active',
    ${RANDOM},
    ${RANDOM}
)
ON CONFLICT DO NOTHING;
EOF
    done
    
    unset PGPASSWORD
    log_info "Тестовые объявления созданы"
}

clear_database() {
    log_step "Очистка базы данных..."
    
    export PGPASSWORD="${DB_PASSWORD}"
    
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" << EOF
TRUNCATE TABLE bonus_transactions, favorites, reviews, messages, chats, listings, users CASCADE;
EOF
    
    unset PGPASSWORD
    log_info "База данных очищена"
}

# ============================================
# ОСНОВНАЯ ЛОГИКА
# ============================================

show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --clear        Clear database before seeding"
    echo "  --help, -h     Show this help"
    echo ""
    echo "Environment variables:"
    echo "  DB_HOST         Database host (default: localhost)"
    echo "  DB_PORT         Database port (default: 5432)"
    echo "  DB_NAME         Database name (default: aida)"
    echo "  DB_USER         Database user (default: aida)"
    echo "  DB_PASSWORD     Database password"
    echo "  USERS_COUNT     Number of test users (default: 50)"
    echo "  LISTINGS_COUNT  Number of test listings (default: 200)"
    echo "  FAVORITES_PER_USER  Favorites per user (default: 10)"
    echo "  REVIEWS_COUNT   Number of reviews (default: 100)"
}

main() {
    log_info "========================================="
    log_info "Заполнение базы данных тестовыми данными"
    log_info "========================================="
    
    check_database
    check_node
    
    if [ "$1" = "--clear" ]; then
        clear_database
    fi
    
    seed_categories
    seed_admin
    seed_test_users
    seed_test_listings
    run_seed
    
    log_info "========================================="
    log_info "База данных успешно заполнена"
    log_info "========================================="
}

# ============================================
# ЗАПУСК
# ============================================

case "${1}" in
    --help|-h)
        show_help
        ;;
    --clear)
        main --clear
        ;;
    *)
        main
        ;;
esac