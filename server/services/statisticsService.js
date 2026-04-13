/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/statisticsService.js
 * Описание: Сервис статистики (сбор метрик, агрегация, отчёты, кеширование)
 */

const { get, set, incr, decr, zincrby, zrevrange, sadd, smembers } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { User, Listing, Payment } = require('../models');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_TTL = {
    daily: 86400,        // 24 часа
    weekly: 604800,      // 7 дней
    monthly: 2592000,    // 30 дней
    realtime: 60         // 1 минута
};

const STATS_KEYS = {
    // Ежедневные метрики
    dailyUsers: 'stats:daily:users',
    dailyListings: 'stats:daily:listings',
    dailyMessages: 'stats:daily:messages',
    dailyViews: 'stats:daily:views',
    dailyRevenue: 'stats:daily:revenue',
    
    // Реальные метрики
    onlineUsers: 'stats:online:users',
    totalUsers: 'stats:total:users',
    totalListings: 'stats:total:listings',
    totalMessages: 'stats:total:messages',
    totalRevenue: 'stats:total:revenue',
    
    // Топы
    topCategories: 'stats:top:categories',
    topCities: 'stats:top:cities',
    topSellers: 'stats:top:sellers',
    topListings: 'stats:top:listings',
    
    // Активность
    userActivity: 'stats:user:activity',
    hourlyActivity: 'stats:hourly:activity'
};

// ============================================
// СБОР МЕТРИК
// ============================================

/**
 * Регистрация нового пользователя
 * @param {number} userId - ID пользователя
 */
async function trackNewUser(userId) {
    const today = new Date().toISOString().split('T')[0];
    
    await incr(`${STATS_KEYS.dailyUsers}:${today}`, 1);
    await incr(STATS_KEYS.totalUsers, 1);
    await sadd(`${STATS_KEYS.userActivity}:${today}`, userId);
}

/**
 * Регистрация нового объявления
 * @param {number} listingId - ID объявления
 * @param {number} userId - ID пользователя
 * @param {number} categoryId - ID категории
 */
async function trackNewListing(listingId, userId, categoryId) {
    const today = new Date().toISOString().split('T')[0];
    
    await incr(`${STATS_KEYS.dailyListings}:${today}`, 1);
    await incr(STATS_KEYS.totalListings, 1);
    await zincrby(STATS_KEYS.topCategories, 1, categoryId.toString());
    await sadd(`${STATS_KEYS.userActivity}:${today}`, userId);
}

/**
 * Регистрация просмотра объявления
 * @param {number} listingId - ID объявления
 * @param {number} userId - ID пользователя (опционально)
 */
async function trackView(listingId, userId = null) {
    const today = new Date().toISOString().split('T')[0];
    const hour = new Date().getHours();
    
    await incr(`${STATS_KEYS.dailyViews}:${today}`, 1);
    await incr(`${STATS_KEYS.hourlyActivity}:${today}:${hour}`, 1);
    await zincrby(STATS_KEYS.topListings, 1, listingId.toString());
    
    if (userId) {
        await sadd(`${STATS_KEYS.userActivity}:${today}`, userId);
    }
}

/**
 * Регистрация нового сообщения
 * @param {number} chatId - ID чата
 * @param {number} userId - ID пользователя
 */
async function trackNewMessage(chatId, userId) {
    const today = new Date().toISOString().split('T')[0];
    
    await incr(`${STATS_KEYS.dailyMessages}:${today}`, 1);
    await incr(STATS_KEYS.totalMessages, 1);
    await sadd(`${STATS_KEYS.userActivity}:${today}`, userId);
}

/**
 * Регистрация дохода
 * @param {number} amount - сумма
 * @param {string} type - тип дохода
 * @param {number} userId - ID пользователя
 */
async function trackRevenue(amount, type, userId) {
    const today = new Date().toISOString().split('T')[0];
    
    await incr(`${STATS_KEYS.dailyRevenue}:${today}`, amount);
    await incr(STATS_KEYS.totalRevenue, amount);
}

// ============================================
// ОНЛАЙН-СТАТИСТИКА
// ============================================

/**
 * Обновление онлайн-статуса пользователя
 * @param {number} userId - ID пользователя
 * @param {boolean} isOnline - онлайн ли
 */
async function updateOnlineStatus(userId, isOnline) {
    if (isOnline) {
        await sadd(STATS_KEYS.onlineUsers, userId);
    } else {
        await decr(STATS_KEYS.onlineUsers, 1);
    }
}

/**
 * Получение количества онлайн-пользователей
 * @returns {Promise<number>}
 */
async function getOnlineUsersCount() {
    const count = await get(STATS_KEYS.onlineUsers);
    return parseInt(count) || 0;
}

// ============================================
// ПОЛУЧЕНИЕ СТАТИСТИКИ
// ============================================

/**
 * Получение дневной статистики
 * @param {string} date - дата (YYYY-MM-DD)
 * @returns {Promise<Object>}
 */
async function getDailyStats(date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    const [users, listings, messages, views, revenue] = await Promise.all([
        get(`${STATS_KEYS.dailyUsers}:${targetDate}`) || 0,
        get(`${STATS_KEYS.dailyListings}:${targetDate}`) || 0,
        get(`${STATS_KEYS.dailyMessages}:${targetDate}`) || 0,
        get(`${STATS_KEYS.dailyViews}:${targetDate}`) || 0,
        get(`${STATS_KEYS.dailyRevenue}:${targetDate}`) || 0
    ]);
    
    const activeUsers = await smembers(`${STATS_KEYS.userActivity}:${targetDate}`);
    
    return {
        date: targetDate,
        newUsers: parseInt(users),
        newListings: parseInt(listings),
        newMessages: parseInt(messages),
        totalViews: parseInt(views),
        revenue: parseInt(revenue),
        activeUsers: activeUsers.length
    };
}

/**
 * Получение статистики за период
 * @param {string} period - период (day, week, month, year)
 * @returns {Promise<Array>}
 */
async function getPeriodStats(period = 'week') {
    let days = 7;
    if (period === 'month') days = 30;
    if (period === 'year') days = 365;
    if (period === 'day') days = 1;
    
    const stats = [];
    for (let i = days - 1; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        stats.push(await getDailyStats(dateStr));
    }
    
    return stats;
}

/**
 * Получение общей статистики
 * @returns {Promise<Object>}
 */
async function getTotalStats() {
    const [totalUsers, totalListings, totalMessages, totalRevenue] = await Promise.all([
        get(STATS_KEYS.totalUsers) || 0,
        get(STATS_KEYS.totalListings) || 0,
        get(STATS_KEYS.totalMessages) || 0,
        get(STATS_KEYS.totalRevenue) || 0
    ]);
    
    const onlineUsers = await getOnlineUsersCount();
    
    return {
        totalUsers: parseInt(totalUsers),
        totalListings: parseInt(totalListings),
        totalMessages: parseInt(totalMessages),
        totalRevenue: parseInt(totalRevenue),
        onlineUsers
    };
}

// ============================================
// ТОПЫ И РЕЙТИНГИ
// ============================================

/**
 * Получение топ категорий
 * @param {number} limit - количество
 * @returns {Promise<Array>}
 */
async function getTopCategories(limit = 10) {
    const categories = await zrevrange(STATS_KEYS.topCategories, 0, limit - 1, true);
    
    const result = [];
    for (const cat of categories) {
        const categoryData = await User.query(`SELECT id, name FROM categories WHERE id = $1`, [cat.value]);
        if (categoryData.rows[0]) {
            result.push({
                id: cat.value,
                name: categoryData.rows[0].name,
                count: parseInt(cat.score)
            });
        }
    }
    
    return result;
}

/**
 * Получение топ городов
 * @param {number} limit - количество
 * @returns {Promise<Array>}
 */
async function getTopCities(limit = 10) {
    const cities = await zrevrange(STATS_KEYS.topCities, 0, limit - 1, true);
    
    return cities.map(city => ({
        city: city.value,
        count: parseInt(city.score)
    }));
}

/**
 * Получение топ продавцов
 * @param {number} limit - количество
 * @returns {Promise<Array>}
 */
async function getTopSellers(limit = 10) {
    const sellers = await zrevrange(STATS_KEYS.topSellers, 0, limit - 1, true);
    
    const result = [];
    for (const seller of sellers) {
        const userData = await User.query(`SELECT id, name, avatar FROM users WHERE id = $1`, [seller.value]);
        if (userData.rows[0]) {
            result.push({
                id: seller.value,
                name: userData.rows[0].name,
                avatar: userData.rows[0].avatar,
                score: parseInt(seller.score)
            });
        }
    }
    
    return result;
}

/**
 * Получение топ объявлений
 * @param {number} limit - количество
 * @returns {Promise<Array>}
 */
async function getTopListings(limit = 10) {
    const listings = await zrevrange(STATS_KEYS.topListings, 0, limit - 1, true);
    
    const result = [];
    for (const listing of listings) {
        const listingData = await Listing.query(`SELECT id, title, price, views, likes FROM listings WHERE id = $1`, [listing.value]);
        if (listingData.rows[0]) {
            result.push({
                id: listing.value,
                title: listingData.rows[0].title,
                price: listingData.rows[0].price,
                views: listingData.rows[0].views,
                likes: listingData.rows[0].likes,
                score: parseInt(listing.score)
            });
        }
    }
    
    return result;
}

// ============================================
= АКТИВНОСТЬ ПО ЧАСАМ
// ============================================

/**
 * Получение активности по часам за сегодня
 * @returns {Promise<Array>}
 */
async function getHourlyActivity() {
    const today = new Date().toISOString().split('T')[0];
    const activity = [];
    
    for (let hour = 0; hour < 24; hour++) {
        const count = await get(`${STATS_KEYS.hourlyActivity}:${today}:${hour}`) || 0;
        activity.push({ hour, count: parseInt(count) });
    }
    
    return activity;
}

// ============================================
= АГРЕГАЦИЯ ДАННЫХ ИЗ БД
// ============================================

/**
 * Агрегация исторических данных из БД
 * @param {string} dateFrom - дата начала
 * @param {string} dateTo - дата окончания
 */
async function aggregateHistoricalData(dateFrom, dateTo) {
    // Пользователи по дням
    const usersByDay = await User.query(`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM users
        WHERE created_at BETWEEN $1 AND $2
        GROUP BY DATE(created_at)
        ORDER BY date ASC
    `, [dateFrom, dateTo]);
    
    // Объявления по дням
    const listingsByDay = await Listing.query(`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM listings
        WHERE created_at BETWEEN $1 AND $2
        GROUP BY DATE(created_at)
        ORDER BY date ASC
    `, [dateFrom, dateTo]);
    
    // Доходы по дням
    const revenueByDay = await Payment.query(`
        SELECT DATE(created_at) as date, SUM(amount) as total
        FROM payments
        WHERE status = 'completed' AND created_at BETWEEN $1 AND $2
        GROUP BY DATE(created_at)
        ORDER BY date ASC
    `, [dateFrom, dateTo]);
    
    // Сохраняем в Redis для быстрого доступа
    for (const row of usersByDay.rows) {
        await set(`${STATS_KEYS.dailyUsers}:${row.date}`, row.count, CACHE_TTL.daily);
    }
    
    for (const row of listingsByDay.rows) {
        await set(`${STATS_KEYS.dailyListings}:${row.date}`, row.count, CACHE_TTL.daily);
    }
    
    for (const row of revenueByDay.rows) {
        await set(`${STATS_KEYS.dailyRevenue}:${row.date}`, row.total, CACHE_TTL.daily);
    }
    
    return {
        users: usersByDay.rows,
        listings: listingsByDay.rows,
        revenue: revenueByDay.rows
    };
}

// ============================================
= ЭКСПОРТ ОТЧЁТА
// ============================================

/**
 * Генерация отчёта за период
 * @param {string} period - период (week, month, year)
 * @returns {Promise<Object>}
 */
async function generateReport(period = 'week') {
    const stats = await getPeriodStats(period);
    const totals = await getTotalStats();
    const topCategories = await getTopCategories(5);
    const topCities = await getTopCities(5);
    const hourlyActivity = await getHourlyActivity();
    
    // Расчёт средних значений
    const avgDailyUsers = stats.reduce((sum, day) => sum + day.newUsers, 0) / stats.length;
    const avgDailyListings = stats.reduce((sum, day) => sum + day.newListings, 0) / stats.length;
    const avgDailyRevenue = stats.reduce((sum, day) => sum + day.revenue, 0) / stats.length;
    
    return {
        period,
        dateRange: {
            from: stats[0]?.date,
            to: stats[stats.length - 1]?.date
        },
        summary: {
            totalUsers: totals.totalUsers,
            totalListings: totals.totalListings,
            totalMessages: totals.totalMessages,
            totalRevenue: totals.totalRevenue,
            onlineUsers: totals.onlineUsers,
            avgDailyUsers: Math.round(avgDailyUsers),
            avgDailyListings: Math.round(avgDailyListings),
            avgDailyRevenue: Math.round(avgDailyRevenue)
        },
        dailyStats: stats,
        topCategories,
        topCities,
        hourlyActivity
    };
}

// ============================================
= ОБНОВЛЕНИЕ СТАТИСТИКИ
// ============================================

/**
 * Обновление всех статистических данных (запускается по крону)
 */
async function refreshAllStats() {
    console.log('🔄 Обновление статистики...');
    
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - 30);
    const dateTo = new Date();
    
    await aggregateHistoricalData(dateFrom.toISOString().split('T')[0], dateTo.toISOString().split('T')[0]);
    
    // Обновляем топ городов
    const citiesResult = await Listing.query(`
        SELECT city, COUNT(*) as count
        FROM listings
        WHERE status = 'active' AND city IS NOT NULL
        GROUP BY city
        ORDER BY count DESC
        LIMIT 100
    `);
    
    for (const city of citiesResult.rows) {
        await zincrby(STATS_KEYS.topCities, city.count, city.city);
    }
    
    // Обновляем топ продавцов
    const sellersResult = await User.query(`
        SELECT u.id, COUNT(l.id) as listings_count, COALESCE(AVG(r.rating), 0) as avg_rating
        FROM users u
        LEFT JOIN listings l ON l.user_id = u.id AND l.status = 'active'
        LEFT JOIN reviews r ON r.to_user_id = u.id
        GROUP BY u.id
        ORDER BY listings_count DESC
        LIMIT 100
    `);
    
    for (const seller of sellersResult.rows) {
        const score = (seller.listings_count || 0) * 10 + (seller.avg_rating || 0) * 5;
        await zincrby(STATS_KEYS.topSellers, score, seller.id);
    }
    
    console.log('✅ Статистика обновлена');
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    // Сбор метрик
    trackNewUser,
    trackNewListing,
    trackView,
    trackNewMessage,
    trackRevenue,
    updateOnlineStatus,
    
    // Получение статистики
    getDailyStats,
    getPeriodStats,
    getTotalStats,
    getOnlineUsersCount,
    getTopCategories,
    getTopCities,
    getTopSellers,
    getTopListings,
    getHourlyActivity,
    
    // Агрегация и отчёты
    aggregateHistoricalData,
    generateReport,
    refreshAllStats,
    
    // Константы
    STATS_KEYS
};