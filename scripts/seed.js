#!/usr/bin/env node

const { Pool } = require('pg');

const db = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'aida',
    user: 'aida',
    password: 'aida123',
});

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

async function seedAdmin() {
    log('Создание администратора...', 'cyan');
    
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash('Admin123!', 10);
    
    await db.query(
        `INSERT INTO users (name, email, password_hash, role, status, email_verified, created_at)
         VALUES ('Администратор', 'admin@aida.ru', $1, 'admin', 'active', true, NOW())
         ON CONFLICT (email) DO NOTHING`,
        [passwordHash]
    );
    
    log('✅ Администратор создан (admin@aida.ru / Admin123!)', 'green');
}

async function main() {
    log('=========================================', 'cyan');
    log('AIDA — Заполнение базы данных тестовыми данными', 'cyan');
    log('=========================================', 'cyan');
    
    try {
        await seedAdmin();
        log('✅ База данных успешно заполнена!', 'green');
    } catch (error) {
        log(`❌ Ошибка: ${error.message}`, 'red');
        console.error(error);
        process.exit(1);
    } finally {
        await db.end();
    }
}

main();
