/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/analyticsService.js
 * Описание: Сервис аналитики (сбор данных, отчёты, графики, метрики)
 */

const { query } = require('../../config/database');
const { get, set, incr, zincrby, zrevrange, sadd, smembers } = require('../../config/redis');

// ============================================
// КОНФИГУРАЦИЯ
// ============================================

const ANALYTICS_CONFIG = {
    // Ключи для Redis
    keys: {
        dailyUsers: 'analytics:daily:users',
        dailyListings: 'analytics:daily:listings',
        dailyMessages: 'analytics:daily:messages',
        dailyViews: 'analytics:daily:views',
        dailyRevenue: 'analytics:daily:revenue',
        topCategories: 'analytics:top:categories',
        topCities: 'analytics:top:cities',
        topSellers: 'analytics:top:sellers',
        userActivity: 'analytics:user:activity',
        searchQueries: 'analytics:search:queries'
    },
    // Время жизни в секундах
    ttl: {
        daily: 86400,      // 24 часа
        weekly: 604800,    // 7 дней
        monthly: 2592000,  // 30 дней
        yearly: 31536000    // 365 дней
    }
};

// ============================================
// СБОР ДАННЫХ
// ============================================

/**
 * Регистрация просмотра объявления
 * @param {number} listingId - ID объявления
 * @param {number} userId - ID пользователя (опционально)
 * @param {string} ip - IP адрес
 */
async function trackView(listingId, userId = null, ip = null) {
    const today = new Date().toISOString().split('T')[0];
    
    // Обновляем счётчик просмотров объявления
    await incr(`analytics:listing:views:${listingId}`, 1);
    
    // Обновляем дневную статистику
    await incr(`${ANALYTICS_CONFIG.keys.dailyViews}:${today}`, 1);
    
    // Сохраняем в БД для детальной аналитики
    await query(
        `INSERT INTO listing_views (listing_id, user_id, ip, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [listingId, userId, ip]
    );
    
    // Обновляем рейтинг объявления
    await updateListingScore(listingId);
}

/**
 * Регистрация нового пользователя
 * @param {number} userId - ID пользователя
 */
async function trackNewUser(userId) {
    const today = new Date().toISOString().split('T')[0];
    
    await incr(`${ANALYTICS_CONFIG.keys.dailyUsers}:${today}`, 1);
    await sadd(`${ANALYTICS_CONFIG.keys.userActivity}:${today}`, userId);
}

/**
 * Регистрация нового объявления
 * @param {number} listingId - ID объявления
 * @param {number} userId - ID пользователя
 * @param {number} categoryId - ID категории
 */
async function trackNewListing(listingId, userId, categoryId) {
    const today = new Date().toISOString().split('T')[0];
    
    await incr(`${ANALYTICS_CONFIG.keys.dailyListings}:${today}`, 1);
    await zincrby(ANALYTICS_CONFIG.keys.topCategories, 1, categoryId.toString());
    await sadd(`${ANALYTICS_CONFIG.keys.userActivity}:${today}`, userId);
}

/**
 * Регистрация нового сообщения в чате
 * @param {number} chatId - ID чата
 * @param {number} userId - ID пользователя
 */
async function trackNewMessage(chatId, userId) {
    const today = new Date().toISOString().split('T')[0];
    await incr(`${ANALYTICS_CONFIG.keys.dailyMessages}:${today}`, 1);
}

/**
 * Регистрация поискового запроса
 * @param {string} query - поисковый запрос
 * @param {number} userId - ID пользователя (опционально)
 * @param {number} resultsCount - количество результатов
 */
async function trackSearchQuery(query, userId = null, resultsCount = 0) {
    if (!query || query.length < 2) return;
    
    const today = new Date().toISOString().split('T')[0];
    const normalizedQuery = query.toLowerCase().trim();
    
    await incr(`${ANALYTICS_CONFIG.keys.searchQueries}:${normalizedQuery}`, 1);
    await incr(`${ANALYTICS_CONFIG.keys.searchQueries}:daily:${today}:${normalizedQuery}`, 1);
    
    // Сохраняем в БД
    await query(
        `INSERT INTO search_analytics (search_query, user_id, results_count, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [query, userId, resultsCount]
    );
}

/**
 * Регистрация дохода
 * @param {number} amount - сумма
 * @param {string} type - тип дохода (bump, vip, commission)
 * @param {number} userId - ID пользователя
 */
async function trackRevenue(amount, type, userId) {
    const today = new Date().toISOString().split('T')[0];
    
    await incr(`${ANALYTICS_CONFIG.keys.dailyRevenue}:${today}`, amount);
    
    await query(
        `INSERT INTO revenue_analytics (amount, type, user_id, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [amount, type, userId]
    );
}

// ============================================
// ОБНОВЛЕНИЕ РЕЙТИНГОВ
// ============================================

/**
 * Обновление рейтинга объявления (для популярных)
 * @param {number} listingId - ID объявления
 */
async function updateListingScore(listingId) {
    // Получаем текущие метрики
    const views = await get(`analytics:listing:views:${listingId}`) || 0;
    const likes = await get(`analytics:listing:likes:${listingId}`) || 0;
    const shares = await get(`analytics:listing:shares:${listingId}`) || 0;
    const chats = await get(`analytics:listing:chats:${listingId}`) || 0;
    
    // Формула рейтинга: просмотры + лайки*10 + шеринги*5 + чаты*3
    const score = parseInt(views) + parseInt(likes) * 10 + parseInt(shares) * 5 + parseInt(chats) * 3;
    
    await zincrby('analytics:top:listings', score, listingId.toString());
}

/**
 * Обновление рейтинга продавца
 * @param {number} sellerId - ID продавца
 */
async function updateSellerScore(sellerId) {
    const result = await query(`
        SELECT 
            COUNT(*) as total_sales,
            AVG(r.rating) as avg_rating,
            COUNT(DISTINCT l.id) as total_listings
        FROM users u
        LEFT JOIN listings l ON l.user_id = u.id AND l.status = 'sold'
        LEFT JOIN reviews r ON r.to_user_id = u.id
        WHERE u.id = $1
        GROUP BY u.id
    `, [sellerId]);
    
    if (result.rows.length > 0) {
        const { total_sales, avg_rating, total_listings } = result.rows[0];
        const score = (total_sales || 0) * 10 + (avg_rating || 0) * 5 + (total_listings || 0) * 2;
        await zincrby(ANALYTICS_CONFIG.keys.topSellers, score, sellerId.toString());
    }
}

// ============================================
// ПОЛУЧЕНИЕ СТАТИСТИКИ
// ============================================

/**
 * Получение дневной статистики
 * @param {string} date - дата (YYYY-MM-DD)
 * @returns {Promise<Object>} - статистика
 */
async function getDailyStats(date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    const [users, listings, messages, views, revenue] = await Promise.all([
        get(`${ANALYTICS_CONFIG.keys.dailyUsers}:${targetDate}`) || 0,
        get(`${ANALYTICS_CONFIG.keys.dailyListings}:${targetDate}`) || 0,
        get(`${ANALYTICS_CONFIG.keys.dailyMessages}:${targetDate}`) || 0,
        get(`${ANALYTICS_CONFIG.keys.dailyViews}:${targetDate}`) || 0,
        get(`${ANALYTICS_CONFIG.keys.dailyRevenue}:${targetDate}`) || 0
    ]);
    
    return {
        date: targetDate,
        newUsers: parseInt(users),
        newListings: parseInt(listings),
        newMessages: parseInt(messages),
        totalViews: parseInt(views),
        revenue: parseInt(revenue)
    };
}

/**
 * Получение статистики за период
 * @param {string} period - период (week, month, year)
 * @returns {Promise<Array>} - массив статистики по дням
 */
async function getPeriodStats(period = 'week') {
    let days = 7;
    if (period === 'month') days = 30;
    if (period === 'year') days = 365;
    
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
 * Получение топ категорий
 * @param {number} limit - количество результатов
 * @returns {Promise<Array>} - топ категорий
 */
async function getTopCategories(limit = 10) {
    const categories = await zrevrange(ANALYTICS_CONFIG.keys.topCategories, 0, limit - 1, true);
    
    const result = [];
    for (const cat of categories) {
        const categoryData = await query(`SELECT id, name FROM categories WHERE id = $1`, [cat.value]);
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
 * Получение топ продавцов
 * @param {number} limit - количество результатов
 * @returns {Promise<Array>} - топ продавцов
 */
async function getTopSellers(limit = 10) {
    const sellers = await zrevrange(ANALYTICS_CONFIG.keys.topSellers, 0, limit - 1, true);
    
    const result = [];
    for (const seller of sellers) {
        const userData = await query(`SELECT id, name, avatar FROM users WHERE id = $1`, [seller.value]);
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
 * Получение популярных поисковых запросов
 * @param {number} limit - количество результатов
 * @returns {Promise<Array>} - популярные запросы
 */
async function getPopularSearches(limit = 10) {
    const queries = await zrevrange(ANALYTICS_CONFIG.keys.searchQueries, 0, limit - 1, true);
    
    return queries.map(q => ({
        query: q.value,
        count: parseInt(q.score)
    }));
}

/**
 * Получение активности пользователей
 * @param {number} days - количество дней
 * @returns {Promise<Array>} - активные пользователи по дням
 */
async function getUserActivity(days = 7) {
    const activity = [];
    for (let i = days - 1; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        
        const activeUsers = await smembers(`${ANALYTICS_CONFIG.keys.userActivity}:${dateStr}`);
        activity.push({
            date: dateStr,
            activeUsers: activeUsers.length
        });
    }
    
    return activity;
}

// ============================================
// ЭКСПОРТ ОТЧЁТОВ
// ============================================

/**
 * Экспорт статистики в CSV
 * @param {string} type - тип отчёта (users, listings, revenue)
 * @param {string} dateFrom - дата начала
 * @param {string} dateTo - дата окончания
 * @returns {Promise<string>} - CSV строка
 */
async function exportToCSV(type, dateFrom, dateTo) {
    let data = [];
    
    switch (type) {
        case 'users':
            const users = await query(`
                SELECT id, name, email, phone, city, role, status, created_at, last_seen
                FROM users
                WHERE created_at BETWEEN $1 AND $2
                ORDER BY created_at DESC
            `, [dateFrom, dateTo]);
            data = users.rows;
            break;
            
        case 'listings':
            const listings = await query(`
                SELECT l.id, l.title, l.price, l.city, l.status, l.views, l.likes, l.created_at, u.name as user_name
                FROM listings l
                JOIN users u ON u.id = l.user_id
                WHERE l.created_at BETWEEN $1 AND $2
                ORDER BY l.created_at DESC
            `, [dateFrom, dateTo]);
            data = listings.rows;
            break;
            
        case 'revenue':
            const revenue = await query(`
                SELECT date, amount, type, description, created_at
                FROM revenue_analytics
                WHERE created_at BETWEEN $1 AND $2
                ORDER BY created_at DESC
            `, [dateFrom, dateTo]);
            data = revenue.rows;
            break;
    }
    
    if (data.length === 0) return '';
    
    const headers = Object.keys(data[0]);
    const csvRows = [headers.join(',')];
    
    for (const row of data) {
        const values = headers.map(header => {
            let value = row[header];
            if (value === null) value = '';
            if (typeof value === 'string') value = `"${value.replace(/"/g, '""')}"`;
            return value;
        });
        csvRows.push(values.join(','));
    }
    
    return csvRows.join('\n');
}

// ============================================
// ОЧИСТКА СТАРЫХ ДАННЫХ
// ============================================

/**
 * Очистка старых аналитических данных
 * @param {number} daysToKeep - количество дней для хранения
 */
async function cleanupOldAnalytics(daysToKeep = 90) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    
    await query(`
        DELETE FROM listing_views WHERE created_at < $1
    `, [cutoffDate]);
    
    await query(`
        DELETE FROM search_analytics WHERE created_at < $1
    `, [cutoffDate]);
    
    await query(`
        DELETE FROM revenue_analytics WHERE created_at < $1
    `, [cutoffDate]);
    
    console.log(`🧹 Аналитические данные старше ${daysToKeep} дней очищены`);
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    // Сбор данных
    trackView,
    trackNewUser,
    trackNewListing,
    trackNewMessage,
    trackSearchQuery,
    trackRevenue,
    
    // Рейтинги
    updateListingScore,
    updateSellerScore,
    
    // Статистика
    getDailyStats,
    getPeriodStats,
    getTopCategories,
    getTopSellers,
    getPopularSearches,
    getUserActivity,
    
    // Экспорт
    exportToCSV,
    
    // Очистка
    cleanupOldAnalytics,
    
    // Конфигурация
    ANALYTICS_CONFIG
};