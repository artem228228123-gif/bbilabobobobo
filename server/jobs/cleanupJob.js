/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/jobs/cleanupJob.js
 * Описание: Фоновые задачи (очистка старых данных, лотерея, аналитика, бэкапы)
 */

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { redis, get, set, del, flushPattern } = require('../../config/redis');
const { config } = require('../../config/env');
const { sendEmail } = require('../services/emailService');

// ============================================
// КОНФИГУРАЦИЯ
// ============================================

const db = new Pool({
    connectionString: config.database.url,
});

const LOGS_DIR = path.join(__dirname, '../../logs');
const BACKUP_DIR = path.join(__dirname, '../../backups');

// Создаём папки если нет
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ============================================
// 1. ЕЖЕДНЕВНАЯ ОЧИСТКА (3:00 AM)
// ============================================
async function dailyCleanup() {
    console.log('🧹 [JOB] Запуск ежедневной очистки...', new Date().toISOString());
    
    try {
        // 1.1 Удаляем старые временные файлы (старше 7 дней)
        const tempDir = path.join(__dirname, '../../temp');
        if (fs.existsSync(tempDir)) {
            const files = fs.readdirSync(tempDir);
            const now = Date.now();
            const sevenDays = 7 * 24 * 60 * 60 * 1000;
            let deletedCount = 0;
            
            for (const file of files) {
                const filePath = path.join(tempDir, file);
                const stats = fs.statSync(filePath);
                if (now - stats.mtimeMs > sevenDays) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                }
            }
            console.log(`   🗑️ Удалено временных файлов: ${deletedCount}`);
        }
        
        // 1.2 Удаляем неподтверждённые аккаунты старше 7 дней
        const unverifiedResult = await db.query(
            `DELETE FROM users 
             WHERE email_verified = false 
             AND created_at < NOW() - INTERVAL '7 days'
             RETURNING id, email, name`
        );
        console.log(`   👤 Удалено неподтверждённых аккаунтов: ${unverifiedResult.rowCount}`);
        
        // 1.3 Удаляем старые сессии из Redis
        const sessionKeys = await redis.keys('session:*');
        let expiredSessions = 0;
        for (const key of sessionKeys) {
            const ttl = await redis.ttl(key);
            if (ttl <= 0) {
                await redis.del(key);
                expiredSessions++;
            }
        }
        console.log(`   🔑 Очищено сессий: ${expiredSessions}`);
        
        // 1.4 Архивируем старые объявления (старше 90 дней)
        const archivedResult = await db.query(
            `UPDATE listings 
             SET status = 'archived', archived_at = NOW()
             WHERE status = 'active' 
             AND created_at < NOW() - INTERVAL '90 days'
             RETURNING id`
        );
        console.log(`   📦 Архивировано объявлений: ${archivedResult.rowCount}`);
        
        // 1.5 Очищаем старые кеши
        await flushPattern('temp:*');
        await flushPattern('search:*');
        
        console.log('✅ [JOB] Ежедневная очистка завершена');
        
        // Логируем результат
        await logJobResult('daily_cleanup', {
            deletedTempFiles: deletedCount,
            deletedUnverifiedUsers: unverifiedResult.rowCount,
            expiredSessions,
            archivedListings: archivedResult.rowCount
        });
        
    } catch (error) {
        console.error('❌ [JOB] Ошибка очистки:', error);
        await logJobError('daily_cleanup', error);
    }
}

// ============================================
// 2. ЛОТЕРЕЯ — РОЗЫГРЫШ (КАЖДОЕ ВОСКРЕСЕНЬЕ В 20:00)
// ============================================
async function lotteryDraw() {
    console.log('🎰 [JOB] Запуск лотерейного розыгрыша...', new Date().toISOString());
    
    try {
        // Получаем активный розыгрыш
        const drawResult = await db.query(
            `SELECT * FROM lottery_draws 
             WHERE status = 'active' 
             AND draw_date <= NOW()
             ORDER BY draw_date ASC 
             LIMIT 1`
        );
        
        if (drawResult.rows.length === 0) {
            console.log('   ℹ️ Нет активных розыгрышей');
            return;
        }
        
        const draw = drawResult.rows[0];
        
        // Получаем все билеты
        const ticketsResult = await db.query(
            `SELECT id, user_id, ticket_number FROM lottery_tickets WHERE draw_id = $1`,
            [draw.id]
        );
        
        if (ticketsResult.rows.length === 0) {
            console.log('   ℹ️ Нет билетов для розыгрыша');
            // Закрываем розыгрыш без победителя
            await db.query(
                `UPDATE lottery_draws SET status = 'completed', completed_at = NOW() WHERE id = $1`,
                [draw.id]
            );
            return;
        }
        
        // Выбираем победителя
        const randomIndex = Math.floor(Math.random() * ticketsResult.rows.length);
        const winner = ticketsResult.rows[randomIndex];
        const winnerPrize = Math.floor(draw.prize_pool * 0.7); // 70% победителю
        
        // Начисляем приз
        await db.query(
            `UPDATE users SET bonus_balance = bonus_balance + $1 WHERE id = $2`,
            [winnerPrize, winner.user_id]
        );
        
        // Записываем транзакцию
        await db.query(
            `INSERT INTO bonus_transactions (user_id, amount, type, reference_id, created_at)
             VALUES ($1, $2, 'lottery_win', $3, NOW())`,
            [winner.user_id, winnerPrize, draw.id]
        );
        
        // Обновляем розыгрыш
        await db.query(
            `UPDATE lottery_draws 
             SET status = 'completed', winner_id = $1, winner_prize = $2, completed_at = NOW()
             WHERE id = $3`,
            [winner.user_id, winnerPrize, draw.id]
        );
        
        // Отправляем уведомление победителю
        const winnerUser = await db.query(
            `SELECT email, name FROM users WHERE id = $1`,
            [winner.user_id]
        );
        
        if (winnerUser.rows[0]) {
            await sendEmail(
                winnerUser.rows[0].email,
                '🎉 Вы выиграли в лотерее АЙДА!',
                `<h2>Поздравляем, ${winnerUser.rows[0].name}!</h2>
                 <p>Вы выиграли ${winnerPrize.toLocaleString()} бонусов в лотерее АЙДА!</p>
                 <p>Бонусы уже зачислены на ваш счёт.</p>
                 <a href="${config.app.clientUrl}/bonus">Перейти к бонусам</a>`
            );
        }
        
        console.log(`   🏆 Победитель: ${winner.user_id}, приз: ${winnerPrize} бонусов`);
        
        // Создаём новый розыгрыш на следующую неделю
        const nextDrawDate = new Date();
        nextDrawDate.setDate(nextDrawDate.getDate() + 7);
        nextDrawDate.setHours(20, 0, 0, 0);
        
        const weekNumber = getWeekNumber(nextDrawDate);
        
        await db.query(
            `INSERT INTO lottery_draws (week_number, year, prize_pool, status, draw_date)
             VALUES ($1, $2, 0, 'active', $3)`,
            [weekNumber, nextDrawDate.getFullYear(), nextDrawDate]
        );
        
        console.log('✅ [JOB] Лотерейный розыгрыш завершён');
        
        await logJobResult('lottery_draw', {
            drawId: draw.id,
            winnerId: winner.user_id,
            winnerPrize,
            totalTickets: ticketsResult.rows.length,
            prizePool: draw.prize_pool
        });
        
    } catch (error) {
        console.error('❌ [JOB] Ошибка лотереи:', error);
        await logJobError('lottery_draw', error);
    }
}

// ============================================
// 3. АНАЛИТИКА — ОБНОВЛЕНИЕ СТАТИСТИКИ (КАЖДЫЙ ЧАС)
// ============================================
async function updateAnalytics() {
    console.log('📊 [JOB] Обновление аналитики...', new Date().toISOString());
    
    try {
        // 3.1 Обновляем кеш популярных объявлений
        const popularListings = await db.query(
            `SELECT id, views, likes, 
                    (views * 1 + likes * 10) as score
             FROM listings 
             WHERE status = 'active'
             ORDER BY score DESC 
             LIMIT 100`
        );
        
        await set('analytics:popular_listings', popularListings.rows, 600);
        
        // 3.2 Обновляем кеш популярных категорий
        const popularCategories = await db.query(
            `SELECT c.id, c.name, COUNT(l.id) as count
             FROM categories c
             JOIN listings l ON l.category_id = c.id
             WHERE l.status = 'active'
             GROUP BY c.id, c.name
             ORDER BY count DESC
             LIMIT 20`
        );
        
        await set('analytics:popular_categories', popularCategories.rows, 3600);
        
        // 3.3 Обновляем кеш городов с наибольшим количеством объявлений
        const popularCities = await db.query(
            `SELECT city, COUNT(*) as count
             FROM listings
             WHERE status = 'active' AND city IS NOT NULL
             GROUP BY city
             ORDER BY count DESC
             LIMIT 20`
        );
        
        await set('analytics:popular_cities', popularCities.rows, 3600);
        
        // 3.4 Обновляем общую статистику
        const totalStats = await db.query(`
            SELECT 
                (SELECT COUNT(*) FROM users WHERE status = 'active') as total_users,
                (SELECT COUNT(*) FROM listings WHERE status = 'active') as active_listings,
                (SELECT COUNT(*) FROM listings) as total_listings,
                (SELECT COUNT(*) FROM chats) as total_chats,
                (SELECT COUNT(*) FROM messages) as total_messages
        `);
        
        await set('analytics:total_stats', totalStats.rows[0], 3600);
        
        console.log('✅ [JOB] Аналитика обновлена');
        
        await logJobResult('update_analytics', {
            popularListings: popularListings.rows.length,
            popularCategories: popularCategories.rows.length,
            popularCities: popularCities.rows.length
        });
        
    } catch (error) {
        console.error('❌ [JOB] Ошибка аналитики:', error);
        await logJobError('update_analytics', error);
    }
}

// ============================================
// 4. РЕЗЕРВНОЕ КОПИРОВАНИЕ БД (КАЖДЫЙ ДЕНЬ В 4:00)
// ============================================
async function databaseBackup() {
    console.log('💾 [JOB] Создание резервной копии БД...', new Date().toISOString());
    
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(BACKUP_DIR, `backup_${timestamp}.sql`);
        
        // Используем pg_dump через child_process
        const { exec } = require('child_process');
        const { database } = config;
        
        const command = `pg_dump --dbname=${database.url} --format=plain --verbose --file=${backupFile}`;
        
        exec(command, async (error, stdout, stderr) => {
            if (error) {
                console.error('❌ [JOB] Ошибка бэкапа:', error);
                await logJobError('database_backup', error);
                return;
            }
            
            // Сжимаем файл
            const { exec: execGzip } = require('child_process');
            execGzip(`gzip ${backupFile}`, async (gzipError) => {
                if (gzipError) {
                    console.error('❌ [JOB] Ошибка сжатия:', gzipError);
                    await logJobError('database_backup_compress', gzipError);
                    return;
                }
                
                // Удаляем старые бэкапы (старше 30 дней)
                const files = fs.readdirSync(BACKUP_DIR);
                const now = Date.now();
                const thirtyDays = 30 * 24 * 60 * 60 * 1000;
                let deletedCount = 0;
                
                for (const file of files) {
                    const filePath = path.join(BACKUP_DIR, file);
                    const stats = fs.statSync(filePath);
                    if (now - stats.mtimeMs > thirtyDays) {
                        fs.unlinkSync(filePath);
                        deletedCount++;
                    }
                }
                
                console.log(`✅ [JOB] Бэкап создан: ${backupFile}.gz`);
                console.log(`   🗑️ Удалено старых бэкапов: ${deletedCount}`);
                
                await logJobResult('database_backup', {
                    file: `${backupFile}.gz`,
                    size: fs.statSync(`${backupFile}.gz`).size,
                    deletedOldBackups: deletedCount
                });
            });
        });
        
    } catch (error) {
        console.error('❌ [JOB] Ошибка бэкапа:', error);
        await logJobError('database_backup', error);
    }
}

// ============================================
// 5. ПРОВЕРКА ЗДОРОВЬЯ СИСТЕМЫ (КАЖДЫЕ 5 МИНУТ)
// ============================================
async function healthCheck() {
    const startTime = Date.now();
    
    try {
        // Проверка БД
        const dbStart = Date.now();
        await db.query('SELECT 1');
        const dbTime = Date.now() - dbStart;
        
        // Проверка Redis
        const redisStart = Date.now();
        await redis.ping();
        const redisTime = Date.now() - redisStart;
        
        // Проверка дискового пространства
        const diskUsage = await getDiskUsage();
        
        // Проверка памяти
        const memoryUsage = process.memoryUsage();
        
        const health = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            database: { status: 'ok', latency: dbTime },
            redis: { status: 'ok', latency: redisTime },
            disk: diskUsage,
            memory: {
                rss: Math.round(memoryUsage.rss / 1024 / 1024),
                heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
                heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024)
            },
            responseTime: Date.now() - startTime
        };
        
        await set('system:health', health, 60);
        
        // Если проблемы с диском — отправляем уведомление
        if (diskUsage.freePercent < 10) {
            console.warn(`⚠️ [JOB] Мало места на диске: ${diskUsage.freePercent}% свободно`);
            await logJobWarning('health_check', `Мало места на диске: ${diskUsage.freePercent}%`);
        }
        
    } catch (error) {
        console.error('❌ [JOB] Health check failed:', error);
        await set('system:health', {
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            error: error.message
        }, 60);
        await logJobError('health_check', error);
    }
}

// ============================================
// 6. ОТПРАВКА ОТЧЁТОВ АДМИНИСТРАТОРУ (ЕЖЕНЕДЕЛЬНО, ПН 9:00)
// ============================================
async function sendWeeklyReport() {
    console.log('📧 [JOB] Отправка еженедельного отчёта...', new Date().toISOString());
    
    try {
        // Получаем статистику за неделю
        const stats = await db.query(`
            SELECT 
                (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days') as new_users,
                (SELECT COUNT(*) FROM listings WHERE created_at > NOW() - INTERVAL '7 days') as new_listings,
                (SELECT COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL '7 days') as new_messages,
                (SELECT COUNT(*) FROM chats WHERE created_at > NOW() - INTERVAL '7 days') as new_chats,
                (SELECT SUM(amount) FROM bonus_transactions WHERE created_at > NOW() - INTERVAL '7 days' AND amount > 0) as bonuses_issued
        `);
        
        // Получаем email администратора
        const adminResult = await db.query(
            `SELECT email FROM users WHERE role = 'admin' LIMIT 1`
        );
        
        if (adminResult.rows[0]) {
            const reportData = stats.rows[0];
            
            await sendEmail(
                adminResult.rows[0].email,
                '📊 Еженедельный отчёт АЙДА',
                `<h2>Отчёт за неделю</h2>
                 <ul>
                     <li>👤 Новых пользователей: ${reportData.new_users}</li>
                     <li>📝 Новых объявлений: ${reportData.new_listings}</li>
                     <li>💬 Новых сообщений: ${reportData.new_messages}</li>
                     <li>💬 Новых чатов: ${reportData.new_chats}</li>
                     <li>🎁 Выдано бонусов: ${reportData.bonuses_issued || 0}</li>
                 </ul>
                 <a href="${config.app.clientUrl}/admin">Перейти в админ-панель</a>`
            );
        }
        
        console.log('✅ [JOB] Отчёт отправлен');
        
        await logJobResult('weekly_report', stats.rows[0]);
        
    } catch (error) {
        console.error('❌ [JOB] Ошибка отправки отчёта:', error);
        await logJobError('weekly_report', error);
    }
}

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function getWeekNumber(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

async function getDiskUsage() {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    try {
        const { stdout } = await execAsync('df -k /');
        const lines = stdout.trim().split('\n');
        const data = lines[1].split(/\s+/);
        
        const total = parseInt(data[1]) * 1024;
        const used = parseInt(data[2]) * 1024;
        const available = parseInt(data[3]) * 1024;
        const usePercent = parseInt(data[4]);
        
        return {
            total: Math.round(total / 1024 / 1024 / 1024),
            used: Math.round(used / 1024 / 1024 / 1024),
            available: Math.round(available / 1024 / 1024 / 1024),
            usePercent,
            freePercent: 100 - usePercent
        };
    } catch (error) {
        return { error: error.message };
    }
}

async function logJobResult(jobName, data) {
    const logEntry = {
        job: jobName,
        status: 'success',
        timestamp: new Date().toISOString(),
        data
    };
    
    fs.appendFileSync(
        path.join(LOGS_DIR, 'jobs.log'),
        JSON.stringify(logEntry) + '\n'
    );
}

async function logJobError(jobName, error) {
    const logEntry = {
        job: jobName,
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error.message,
        stack: error.stack
    };
    
    fs.appendFileSync(
        path.join(LOGS_DIR, 'jobs_errors.log'),
        JSON.stringify(logEntry) + '\n'
    );
}

async function logJobWarning(jobName, message) {
    const logEntry = {
        job: jobName,
        status: 'warning',
        timestamp: new Date().toISOString(),
        message
    };
    
    fs.appendFileSync(
        path.join(LOGS_DIR, 'jobs_warnings.log'),
        JSON.stringify(logEntry) + '\n'
    );
}

// ============================================
// ЗАПУСК ВСЕХ ЗАДАЧ
// ============================================

function startAllJobs() {
    console.log('⏰ [JOBS] Запуск планировщика задач...');
    
    // Ежедневная очистка в 3:00
    cron.schedule('0 3 * * *', dailyCleanup);
    
    // Лотерея — каждое воскресенье в 20:00
    cron.schedule('0 20 * * 0', lotteryDraw);
    
    // Аналитика — каждый час
    cron.schedule('0 * * * *', updateAnalytics);
    
    // Резервное копирование в 4:00
    cron.schedule('0 4 * * *', databaseBackup);
    
    // Health check каждые 5 минут
    cron.schedule('*/5 * * * *', healthCheck);
    
    // Еженедельный отчёт по понедельникам в 9:00
    cron.schedule('0 9 * * 1', sendWeeklyReport);
    
    console.log('✅ [JOBS] Все задачи запущены');
    
    // Запускаем health check сразу
    setTimeout(healthCheck, 5000);
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    startAllJobs,
    dailyCleanup,
    lotteryDraw,
    updateAnalytics,
    databaseBackup,
    healthCheck,
    sendWeeklyReport
};