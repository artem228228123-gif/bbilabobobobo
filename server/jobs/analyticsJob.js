/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/jobs/analyticsJob.js
 * Описание: Фоновые задачи для сбора и обновления аналитики
 */

const cron = require('node-cron');
const { get, set, del, incr, zincrby, zrevrange, sadd, smembers } = require('../../config/redis');
const { query } = require('../../config/database');
const { addJob } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_TTL = {
    dailyStats: 86400,      // 24 часа
    weeklyStats: 604800,    // 7 дней
    monthlyStats: 2592000,  // 30 дней
    realtime: 60            // 1 минута
};

const STATS_KEYS = {
    dailyUsers: 'analytics:daily:users',
    dailyListings: 'analytics:daily:listings',
    dailyMessages: 'analytics:daily:messages',
    dailyViews: 'analytics:daily:views',
    dailyRevenue: 'analytics:daily:revenue',
    hourlyActivity: 'analytics:hourly:activity',
    topCategories: 'analytics:top:categories',
    topCities: 'analytics:top:cities',
    topSellers: 'analytics:top:sellers',
    topListings: 'analytics:top:listings',
    userActivity: 'analytics:user:activity'
};

// ============================================
= СБОР МЕТРИК
// ============================================

/**
 * Сбор дневной статистики
 */
async function collectDailyStats() {
    const today = new Date().toISOString().split('T')[0];
    
    console.log(`📊 [AnalyticsJob] Сбор дневной статистики за ${today}`);
    
    try {
        // Новые пользователи
        const newUsers = await query(
            `SELECT COUNT(*) FROM users WHERE DATE(created_at) = $1`,
            [today]
        );
        await set(`${STATS_KEYS.dailyUsers}:${today}`, parseInt(newUsers.rows[0].count), CACHE_TTL.dailyStats);
        
        // Новые объявления
        const newListings = await query(
            `SELECT COUNT(*) FROM listings WHERE DATE(created_at) = $1`,
            [today]
        );
        await set(`${STATS_KEYS.dailyListings}:${today}`, parseInt(newListings.rows[0].count), CACHE_TTL.dailyStats);
        
        // Новые сообщения
        const newMessages = await query(
            `SELECT COUNT(*) FROM messages WHERE DATE(created_at) = $1`,
            [today]
        );
        await set(`${STATS_KEYS.dailyMessages}:${today}`, parseInt(newMessages.rows[0].count), CACHE_TTL.dailyStats);
        
        // Просмотры
        const views = await query(
            `SELECT COUNT(*) FROM listing_views WHERE DATE(created_at) = $1`,
            [today]
        );
        await set(`${STATS_KEYS.dailyViews}:${today}`, parseInt(views.rows[0].count), CACHE_TTL.dailyStats);
        
        // Доходы
        const revenue = await query(
            `SELECT COALESCE(SUM(amount), 0) FROM payments 
             WHERE status = 'completed' AND DATE(created_at) = $1`,
            [today]
        );
        await set(`${STATS_KEYS.dailyRevenue}:${today}`, parseInt(revenue.rows[0].coalesce), CACHE_TTL.dailyStats);
        
        console.log(`✅ [AnalyticsJob] Дневная статистика собрана`);
        
        return {
            date: today,
            newUsers: parseInt(newUsers.rows[0].count),
            newListings: parseInt(newListings.rows[0].count),
            newMessages: parseInt(newMessages.rows[0].count),
            views: parseInt(views.rows[0].count),
            revenue: parseInt(revenue.rows[0].coalesce)
        };
    } catch (error) {
        console.error('❌ [AnalyticsJob] Ошибка сбора дневной статистики:', error);
        return null;
    }
}

/**
 * Сбор почасовой активности
 */
async function collectHourlyActivity() {
    const today = new Date().toISOString().split('T')[0];
    const hour = new Date().getHours();
    
    try {
        // Активность пользователей
        const activeUsers = await query(
            `SELECT COUNT(DISTINCT user_id) FROM listing_views 
             WHERE DATE(created_at) = $1 AND EXTRACT(HOUR FROM created_at) = $2`,
            [today, hour]
        );
        
        await set(`${STATS_KEYS.hourlyActivity}:${today}:${hour}`, 
            parseInt(activeUsers.rows[0].count), CACHE_TTL.dailyStats);
        
        // Сохраняем ID активных пользователей
        const userIds = await query(
            `SELECT DISTINCT user_id FROM listing_views 
             WHERE DATE(created_at) = $1 AND EXTRACT(HOUR FROM created_at) = $2 
             AND user_id IS NOT NULL`,
            [today, hour]
        );
        
        for (const row of userIds.rows) {
            await sadd(`${STATS_KEYS.userActivity}:${today}:${hour}`, row.user_id);
        }
        
        console.log(`📊 [AnalyticsJob] Почасовая активность за ${today} ${hour}:00 собрана`);
    } catch (error) {
        console.error('❌ [AnalyticsJob] Ошибка сбора почасовой активности:', error);
    }
}

// ============================================
= ОБНОВЛЕНИЕ ТОПОВ
// ============================================

/**
 * Обновление топа категорий
 */
async function updateTopCategories() {
    console.log(`📊 [AnalyticsJob] Обновление топа категорий...`);
    
    try {
        const result = await query(`
            SELECT c.id, c.name, c.icon, COUNT(l.id) as listings_count
            FROM categories c
            LEFT JOIN listings l ON l.category_id = c.id AND l.status = 'active'
            GROUP BY c.id, c.name, c.icon
            ORDER BY listings_count DESC
            LIMIT 20
        `);
        
        // Очищаем старые данные
        await del(STATS_KEYS.topCategories);
        
        for (const row of result.rows) {
            await zincrby(STATS_KEYS.topCategories, row.listings_count, JSON.stringify({
                id: row.id,
                name: row.name,
                icon: row.icon
            }));
        }
        
        console.log(`✅ [AnalyticsJob] Топ категорий обновлён`);
    } catch (error) {
        console.error('❌ [AnalyticsJob] Ошибка обновления топа категорий:', error);
    }
}

/**
 * Обновление топа городов
 */
async function updateTopCities() {
    console.log(`📊 [AnalyticsJob] Обновление топа городов...`);
    
    try {
        const result = await query(`
            SELECT city, COUNT(*) as listings_count
            FROM listings
            WHERE status = 'active' AND city IS NOT NULL
            GROUP BY city
            ORDER BY listings_count DESC
            LIMIT 20
        `);
        
        await del(STATS_KEYS.topCities);
        
        for (const row of result.rows) {
            await zincrby(STATS_KEYS.topCities, row.listings_count, row.city);
        }
        
        console.log(`✅ [AnalyticsJob] Топ городов обновлён`);
    } catch (error) {
        console.error('❌ [AnalyticsJob] Ошибка обновления топа городов:', error);
    }
}

/**
 * Обновление топа продавцов
 */
async function updateTopSellers() {
    console.log(`📊 [AnalyticsJob] Обновление топа продавцов...`);
    
    try {
        const result = await query(`
            SELECT u.id, u.name, u.avatar, 
                   COUNT(l.id) as listings_count,
                   COALESCE(AVG(r.rating), 0) as avg_rating,
                   COUNT(DISTINCT f.user_id) as favorited_count
            FROM users u
            LEFT JOIN listings l ON l.user_id = u.id AND l.status = 'active'
            LEFT JOIN reviews r ON r.to_user_id = u.id
            LEFT JOIN favorites f ON f.listing_id = l.id
            WHERE u.role = 'user'
            GROUP BY u.id, u.name, u.avatar
            ORDER BY listings_count DESC
            LIMIT 50
        `);
        
        await del(STATS_KEYS.topSellers);
        
        for (const row of result.rows) {
            const score = (row.listings_count * 10) + (row.avg_rating * 5) + (row.favorited_count * 2);
            await zincrby(STATS_KEYS.topSellers, score, JSON.stringify({
                id: row.id,
                name: row.name,
                avatar: row.avatar,
                listings_count: row.listings_count,
                avg_rating: parseFloat(row.avg_rating)
            }));
        }
        
        console.log(`✅ [AnalyticsJob] Топ продавцов обновлён`);
    } catch (error) {
        console.error('❌ [AnalyticsJob] Ошибка обновления топа продавцов:', error);
    }
}

/**
 * Обновление топа объявлений
 */
async function updateTopListings() {
    console.log(`📊 [AnalyticsJob] Обновление топа объявлений...`);
    
    try {
        const result = await query(`
            SELECT l.id, l.title, l.price, l.views, l.likes,
                   (l.views + l.likes * 10) as popularity_score
            FROM listings l
            WHERE l.status = 'active'
            ORDER BY popularity_score DESC
            LIMIT 100
        `);
        
        await del(STATS_KEYS.topListings);
        
        for (const row of result.rows) {
            await zincrby(STATS_KEYS.topListings, row.popularity_score, JSON.stringify({
                id: row.id,
                title: row.title,
                price: row.price,
                views: row.views,
                likes: row.likes
            }));
        }
        
        console.log(`✅ [AnalyticsJob] Топ объявлений обновлён`);
    } catch (error) {
        console.error('❌ [AnalyticsJob] Ошибка обновления топа объявлений:', error);
    }
}

// ============================================
= АГРЕГАЦИЯ СТАТИСТИКИ
// ============================================

/**
 * Агрегация статистики за период
 */
async function aggregatePeriodStats(days = 30) {
    console.log(`📊 [AnalyticsJob] Агрегация статистики за ${days} дней...`);
    
    try {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        
        const stats = [];
        
        for (let i = 0; i < days; i++) {
            const date = new Date(startDate);
            date.setDate(date.getDate() + i);
            const dateStr = date.toISOString().split('T')[0];
            
            const [users, listings, messages, views, revenue] = await Promise.all([
                get(`${STATS_KEYS.dailyUsers}:${dateStr}`) || 0,
                get(`${STATS_KEYS.dailyListings}:${dateStr}`) || 0,
                get(`${STATS_KEYS.dailyMessages}:${dateStr}`) || 0,
                get(`${STATS_KEYS.dailyViews}:${dateStr}`) || 0,
                get(`${STATS_KEYS.dailyRevenue}:${dateStr}`) || 0
            ]);
            
            stats.push({
                date: dateStr,
                newUsers: parseInt(users),
                newListings: parseInt(listings),
                newMessages: parseInt(messages),
                views: parseInt(views),
                revenue: parseInt(revenue)
            });
        }
        
        await set(`analytics:period:${days}days`, stats, CACHE_TTL.weeklyStats);
        
        console.log(`✅ [AnalyticsJob] Агрегация статистики за ${days} дней завершена`);
        return stats;
    } catch (error) {
        console.error('❌ [AnalyticsJob] Ошибка агрегации статистики:', error);
        return [];
    }
}

// ============================================
= ОЧИСТКА СТАРЫХ ДАННЫХ
// ============================================

/**
 * Очистка старых аналитических данных
 */
async function cleanupOldAnalytics() {
    console.log(`🧹 [AnalyticsJob] Очистка старых аналитических данных...`);
    
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    try {
        // Удаляем старые просмотры
        await query(
            `DELETE FROM listing_views WHERE created_at < $1`,
            [thirtyDaysAgo]
        );
        
        // Удаляем старую поисковую аналитику
        await query(
            `DELETE FROM search_analytics WHERE created_at < $1`,
            [thirtyDaysAgo]
        );
        
        // Очищаем старые ключи в Redis
        const pattern = `${STATS_KEYS.dailyUsers}:*`;
        // В реальном проекте нужно использовать SCAN для удаления по паттерну
        
        console.log(`✅ [AnalyticsJob] Очистка старых данных завершена`);
    } catch (error) {
        console.error('❌ [AnalyticsJob] Ошибка очистки старых данных:', error);
    }
}

// ============================================
= ОТПРАВКА ОТЧЁТОВ
// ============================================

/**
 * Отправка ежедневного отчёта администратору
 */
async function sendDailyReport() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];
    
    const stats = await get(`${STATS_KEYS.dailyUsers}:${dateStr}`);
    
    if (!stats) return;
    
    console.log(`📧 [AnalyticsJob] Отправка ежедневного отчёта...`);
    
    // Здесь будет отправка email администратору
    await addJob('emailQueue', 'sendDailyReport', {
        date: dateStr,
        stats: {
            newUsers: await get(`${STATS_KEYS.dailyUsers}:${dateStr}`) || 0,
            newListings: await get(`${STATS_KEYS.dailyListings}:${dateStr}`) || 0,
            newMessages: await get(`${STATS_KEYS.dailyMessages}:${dateStr}`) || 0,
            views: await get(`${STATS_KEYS.dailyViews}:${dateStr}`) || 0,
            revenue: await get(`${STATS_KEYS.dailyRevenue}:${dateStr}`) || 0
        }
    });
    
    console.log(`✅ [AnalyticsJob] Ежедневный отчёт отправлен`);
}

// ============================================
= ЗАПУСК ВСЕХ ЗАДАЧ
// ============================================

/**
 * Запуск всех аналитических задач по расписанию
 */
function startAnalyticsJobs() {
    console.log('⏰ [AnalyticsJob] Запуск планировщика аналитики...');
    
    // Сбор дневной статистики в 00:05
    cron.schedule('5 0 * * *', async () => {
        console.log('📊 [AnalyticsJob] Запуск сбора дневной статистики...');
        await collectDailyStats();
        await aggregatePeriodStats(7);
        await aggregatePeriodStats(30);
        await sendDailyReport();
    });
    
    // Сбор почасовой активности каждый час
    cron.schedule('0 * * * *', async () => {
        await collectHourlyActivity();
    });
    
    // Обновление топов каждый час
    cron.schedule('30 * * * *', async () => {
        await updateTopCategories();
        await updateTopCities();
        await updateTopSellers();
        await updateTopListings();
    });
    
    // Очистка старых данных каждую неделю в воскресенье в 2:00
    cron.schedule('0 2 * * 0', async () => {
        await cleanupOldAnalytics();
    });
    
    console.log('✅ [AnalyticsJob] Все задачи аналитики запущены');
}

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    startAnalyticsJobs,
    collectDailyStats,
    collectHourlyActivity,
    updateTopCategories,
    updateTopCities,
    updateTopSellers,
    updateTopListings,
    aggregatePeriodStats,
    cleanupOldAnalytics,
    sendDailyReport,
    STATS_KEYS
};