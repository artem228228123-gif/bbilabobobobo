#!/usr/bin/env node

/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: scripts/migrate.js
 * Описание: Скрипт для управления миграциями базы данных
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Загрузка переменных окружения
dotenv.config({ path: path.join(__dirname, '../.env') });

// ============================================
// КОНФИГУРАЦИЯ
// ============================================

const db = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'aida',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
});

const MIGRATIONS_DIR = path.join(__dirname, '../database/migrations');
const MIGRATIONS_TABLE = 'migrations';

// Цвета для вывода
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSuccess(message) {
    log(`✅ ${message}`, 'green');
}

function logError(message) {
    log(`❌ ${message}`, 'red');
}

function logInfo(message) {
    log(`ℹ️ ${message}`, 'cyan');
}

function logWarning(message) {
    log(`⚠️ ${message}`, 'yellow');
}

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

async function ensureMigrationsTable() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL UNIQUE,
            executed_at TIMESTAMP DEFAULT NOW(),
            duration_ms INTEGER
        )
    `);
}

async function getExecutedMigrations() {
    const result = await db.query(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`);
    return new Set(result.rows.map(row => row.name));
}

async function getMigrationFiles() {
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();
    return files;
}

async function runMigration(file) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    const startTime = Date.now();
    
    try {
        await db.query('BEGIN');
        await db.query(sql);
        await db.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (name, duration_ms) VALUES ($1, $2)`,
            [file, Date.now() - startTime]
        );
        await db.query('COMMIT');
        
        logSuccess(`Выполнена миграция: ${file} (${Date.now() - startTime}ms)`);
        return true;
    } catch (error) {
        await db.query('ROLLBACK');
        logError(`Ошибка миграции ${file}: ${error.message}`);
        return false;
    }
}

async function rollbackMigration(file) {
    // Создание rollback файла (если есть)
    const rollbackFile = file.replace('.sql', '_down.sql');
    const rollbackPath = path.join(MIGRATIONS_DIR, rollbackFile);
    
    if (!fs.existsSync(rollbackPath)) {
        logError(`Rollback файл не найден: ${rollbackFile}`);
        return false;
    }
    
    const sql = fs.readFileSync(rollbackPath, 'utf8');
    const startTime = Date.now();
    
    try {
        await db.query('BEGIN');
        await db.query(sql);
        await db.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE name = $1`, [file]);
        await db.query('COMMIT');
        
        logSuccess(`Откачена миграция: ${file} (${Date.now() - startTime}ms)`);
        return true;
    } catch (error) {
        await db.query('ROLLBACK');
        logError(`Ошибка отката миграции ${file}: ${error.message}`);
        return false;
    }
}

// ============================================
// ОСНОВНЫЕ КОМАНДЫ
// ============================================

async function migrate() {
    logInfo('Запуск миграций...');
    
    await ensureMigrationsTable();
    
    const executed = await getExecutedMigrations();
    const files = await getMigrationFiles();
    const pending = files.filter(f => !executed.has(f));
    
    if (pending.length === 0) {
        logSuccess('Нет новых миграций');
        return;
    }
    
    logInfo(`Найдено ${pending.length} новых миграций`);
    
    for (const file of pending) {
        const success = await runMigration(file);
        if (!success) {
            logError('Миграция прервана из-за ошибки');
            process.exit(1);
        }
    }
    
    logSuccess('Все миграции выполнены успешно');
}

async function rollback(steps = 1) {
    logInfo(`Откат ${steps} миграции(й)...`);
    
    await ensureMigrationsTable();
    
    const result = await db.query(
        `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id DESC LIMIT $1`,
        [steps]
    );
    
    const migrations = result.rows.map(row => row.name);
    
    if (migrations.length === 0) {
        logWarning('Нет миграций для отката');
        return;
    }
    
    for (const migration of migrations) {
        const success = await rollbackMigration(migration);
        if (!success) {
            logError('Откат прерван из-за ошибки');
            process.exit(1);
        }
    }
    
    logSuccess(`Откачено ${migrations.length} миграции(й)`);
}

async function reset() {
    logWarning('ВНИМАНИЕ: Это удалит все данные в базе данных!');
    logWarning('Вы уверены? (yes/no)');
    
    process.stdin.once('data', async (data) => {
        const answer = data.toString().trim().toLowerCase();
        
        if (answer !== 'yes') {
            logInfo('Операция отменена');
            process.exit(0);
        }
        
        logInfo('Сброс базы данных...');
        
        // Получаем все таблицы
        const result = await db.query(`
            SELECT tablename FROM pg_tables 
            WHERE schemaname = 'public' 
            AND tablename != 'migrations'
        `);
        
        for (const row of result.rows) {
            await db.query(`DROP TABLE IF EXISTS ${row.tablename} CASCADE`);
        }
        
        await db.query(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE} CASCADE`);
        
        logSuccess('База данных сброшена');
        
        // Запускаем миграции заново
        await migrate();
        
        process.exit(0);
    });
}

async function status() {
    logInfo('Статус миграций...');
    
    await ensureMigrationsTable();
    
    const executed = await getExecutedMigrations();
    const files = await getMigrationFiles();
    
    log('', 'bright');
    log('Миграции:', 'bright');
    log('─'.repeat(50), 'dim');
    
    for (const file of files) {
        const isExecuted = executed.has(file);
        const status = isExecuted ? '✅ выполнена' : '⏳ ожидает';
        const color = isExecuted ? 'green' : 'yellow';
        log(`${file} — ${status}`, color);
    }
    
    log('─'.repeat(50), 'dim');
    log(`Всего: ${files.length}`, 'bright');
    log(`Выполнено: ${executed.size}`, 'green');
    log(`Ожидает: ${files.length - executed.size}`, 'yellow');
}

async function create(name) {
    if (!name) {
        logError('Укажите имя миграции');
        process.exit(1);
    }
    
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    const filename = `${timestamp}_${name}.sql`;
    const filepath = path.join(MIGRATIONS_DIR, filename);
    
    const template = `-- ============================================
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

`;
    
    fs.writeFileSync(filepath, template);
    logSuccess(`Создана миграция: ${filename}`);
}

// ============================================
// ОСНОВНАЯ ЛОГИКА
// ============================================

async function main() {
    const command = process.argv[2];
    const arg = process.argv[3];
    
    log('=========================================', 'bright');
    log('AIDA — Управление миграциями базы данных', 'bright');
    log('=========================================', 'bright');
    
    try {
        switch (command) {
            case 'up':
            case 'migrate':
                await migrate();
                break;
            case 'down':
            case 'rollback':
                await rollback(arg ? parseInt(arg) : 1);
                break;
            case 'reset':
                await reset();
                break;
            case 'status':
                await status();
                break;
            case 'create':
                await create(arg);
                break;
            case '--help':
            case '-h':
                log(`
Использование: node migrate.js [COMMAND]

Команды:
  up, migrate     Выполнить все ожидающие миграции
  down, rollback [N]  Откатить последние N миграций (по умолчанию 1)
  reset           Сбросить базу данных и выполнить все миграции заново
  status          Показать статус миграций
  create <name>   Создать новую миграцию
  --help, -h      Показать эту справку
                `, 'cyan');
                break;
            default:
                logError(`Неизвестная команда: ${command}`);
                log('Используйте --help для списка команд');
                process.exit(1);
        }
    } catch (error) {
        logError(`Ошибка: ${error.message}`);
        console.error(error);
        process.exit(1);
    } finally {
        await db.end();
    }
}

// ============================================
// ЗАПУСК
// ============================================

if (require.main === module) {
    main();
}

module.exports = { migrate, rollback, reset, status, create };