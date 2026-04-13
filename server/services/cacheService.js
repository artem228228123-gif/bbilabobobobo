/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/cacheService.js
 * Описание: Сервис кеширования (управление Redis, инвалидация,预热, TTL)
 */

const { get, set, del, incr, expire, ttl, keys, flushPattern } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_KEYS = {
    // Пользователи
    user: (id) => `user:${id}`,
    userProfile: (id) => `user:profile:${id}`,
    userStats: (id) => `user:stats:${id}`,
    userListings: (id, page) => `user:listings:${id}:${page}`,
    
    // Объявления
    listing: (id) => `listing:${id}`,
    listingFull: (id) => `listing:full:${id}`,
    listingsList: (params) => `listings:${JSON.stringify(params)}`,
    similarListings: (id) => `similar:${id}`,
    
    // Категории
    categories: 'categories:list',
    categoriesTree: 'categories:tree',
    category: (id) => `category:${id}`,
    categoryPath: (id) => `category:path:${id}`,
    
    // Поиск
    search: (query, params) => `search:${query}:${JSON.stringify(params)}`,
    autocomplete: (query) => `suggest:${query}`,
    
    // Карта
    mapMarkers: (params) => `map:markers:${JSON.stringify(params)}`,
    geocode: (address) => `geocode:${address}`,
    reverseGeocode: (lat, lng) => `reverse:${lat}:${lng}`,
    
    // Чаты
    chat: (id) => `chat:${id}`,
    chatMessages: (id) => `chat:${id}:messages`,
    userChats: (id) => `chats:user:${id}`,
    unreadCount: (userId, chatId) => `chat:unread:${userId}:${chatId}`,
    
    // TikTok
    tiktokFeed: (userId, type) => `tiktok:feed:${type}:${userId}`,
    tiktokTrending: 'tiktok:trending',
    
    // Бонусы
    bonusBalance: (id) => `bonus:balance:${id}`,
    bonusHistory: (id, page) => `bonus:history:${id}:${page}`,
    bonusStreak: (id) => `bonus:streak:${id}`,
    
    // Лотерея
    lotteryCurrent: 'lottery:current',
    lotteryWinners: 'lottery:winners',
    lotteryStats: 'lottery:stats',
    
    // Рефералы
    referralInfo: (id) => `referral:info:${id}`,
    referralStats: (id) => `referral:stats:${id}`,
    
    // Админка
    adminStats: 'admin:dashboard:stats',
    adminCharts: (period) => `admin:charts:${period}`,
    
    // Системные
    systemConfig: 'system:config',
    systemMaintenance: 'system:maintenance',
    healthCheck: 'system:health'
};

const DEFAULT_TTL = {
    SHORT: 60,          // 1 минута
    MEDIUM: 300,        // 5 минут
    LONG: 3600,         // 1 час
    VERY_LONG: 86400,   // 24 часа
    WEEK: 604800        // 7 дней
};

// ============================================
// ОСНОВНЫЕ ОПЕРАЦИИ
// ============================================

/**
 * Получение значения из кеша
 * @param {string} key - ключ
 * @returns {Promise<any>}
 */
async function getCached(key) {
    try {
        const value = await get(key);
        if (!value) return null;
        
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    } catch (error) {
        console.error(`Ошибка получения кеша по ключу ${key}:`, error);
        return null;
    }
}

/**
 * Установка значения в кеш
 * @param {string} key - ключ
 * @param {any} value - значение
 * @param {number} ttl - время жизни в секундах
 * @returns {Promise<boolean>}
 */
async function setCached(key, value, ttl = DEFAULT_TTL.MEDIUM) {
    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        await set(key, serialized, ttl);
        return true;
    } catch (error) {
        console.error(`Ошибка установки кеша по ключу ${key}:`, error);
        return false;
    }
}

/**
 * Удаление значения из кеша
 * @param {string} key - ключ
 * @returns {Promise<boolean>}
 */
async function deleteCached(key) {
    try {
        await del(key);
        return true;
    } catch (error) {
        console.error(`Ошибка удаления кеша по ключу ${key}:`, error);
        return false;
    }
}

/**
 * Проверка существования ключа
 * @param {string} key - ключ
 * @returns {Promise<boolean>}
 */
async function existsCached(key) {
    try {
        const result = await get(key);
        return result !== null;
    } catch (error) {
        return false;
    }
}

/**
 * Получение TTL ключа
 * @param {string} key - ключ
 * @returns {Promise<number>}
 */
async function getTTL(key) {
    try {
        return await ttl(key);
    } catch (error) {
        return -2;
    }
}

// ============================================
// МАССОВЫЕ ОПЕРАЦИИ
// ============================================

/**
 * Получение нескольких значений
 * @param {Array<string>} keys - массив ключей
 * @returns {Promise<Array>}
 */
async function getMultipleCached(keys) {
    const results = [];
    for (const key of keys) {
        results.push(await getCached(key));
    }
    return results;
}

/**
 * Установка нескольких значений
 * @param {Object} keyValuePairs - объект {ключ: значение}
 * @param {number} ttl - время жизни
 * @returns {Promise<boolean>}
 */
async function setMultipleCached(keyValuePairs, ttl = DEFAULT_TTL.MEDIUM) {
    try {
        for (const [key, value] of Object.entries(keyValuePairs)) {
            await setCached(key, value, ttl);
        }
        return true;
    } catch (error) {
        console.error('Ошибка массовой установки кеша:', error);
        return false;
    }
}

/**
 * Удаление по паттерну
 * @param {string} pattern - паттерн (например, "user:*")
 * @returns {Promise<number>}
 */
async function deleteByPattern(pattern) {
    try {
        const count = await flushPattern(pattern);
        return count;
    } catch (error) {
        console.error(`Ошибка удаления по паттерну ${pattern}:`, error);
        return 0;
    }
}

// ============================================
= СПЕЦИАЛИЗИРОВАННЫЕ ФУНКЦИИ
// ============================================

/**
 * Инвалидация кеша пользователя
 * @param {number} userId - ID пользователя
 */
async function invalidateUserCache(userId) {
    await Promise.all([
        deleteCached(CACHE_KEYS.user(userId)),
        deleteCached(CACHE_KEYS.userProfile(userId)),
        deleteCached(CACHE_KEYS.userStats(userId)),
        deleteByPattern(`user:listings:${userId}:*`),
        deleteCached(CACHE_KEYS.bonusBalance(userId)),
        deleteCached(CACHE_KEYS.bonusStreak(userId)),
        deleteCached(CACHE_KEYS.referralInfo(userId)),
        deleteCached(CACHE_KEYS.referralStats(userId))
    ]);
}

/**
 * Инвалидация кеша объявления
 * @param {number} listingId - ID объявления
 */
async function invalidateListingCache(listingId) {
    await Promise.all([
        deleteCached(CACHE_KEYS.listing(listingId)),
        deleteCached(CACHE_KEYS.listingFull(listingId)),
        deleteCached(CACHE_KEYS.similarListings(listingId)),
        deleteByPattern(`listings:*`),
        deleteByPattern(`search:*`)
    ]);
}

/**
 * Инвалидация кеша категорий
 */
async function invalidateCategoriesCache() {
    await Promise.all([
        deleteCached(CACHE_KEYS.categories),
        deleteCached(CACHE_KEYS.categoriesTree),
        deleteByPattern(`category:*`)
    ]);
}

/**
 * Инвалидация кеша поиска
 * @param {string} query - поисковый запрос (опционально)
 */
async function invalidateSearchCache(query = null) {
    if (query) {
        await deleteByPattern(`search:${query}:*`);
        await deleteCached(CACHE_KEYS.autocomplete(query));
    } else {
        await deleteByPattern(`search:*`);
        await deleteByPattern(`suggest:*`);
    }
}

/**
 * Инвалидация кеша карты
 */
async function invalidateMapCache() {
    await deleteByPattern(`map:markers:*`);
    await deleteByPattern(`geocode:*`);
    await deleteByPattern(`reverse:*`);
}

// ============================================
= ПРЕДВАРИТЕЛЬНОЕ ЗАГРУЗКА (WARM UP)
// ============================================

/**
 * Предварительная загрузка популярных данных в кеш
 */
async function warmUpCache() {
    console.log('🔥 Предварительная загрузка кеша...');
    
    try {
        // Загружаем категории
        const { Category } = require('../models');
        const categories = await Category.findAll();
        await setCached(CACHE_KEYS.categories, categories, DEFAULT_TTL.VERY_LONG);
        
        const categoriesTree = await Category.getTree();
        await setCached(CACHE_KEYS.categoriesTree, categoriesTree, DEFAULT_TTL.VERY_LONG);
        
        // Загружаем популярные объявления
        const popularListings = await require('../models').Listing.query(`
            SELECT id, title, price, views, likes
            FROM listings
            WHERE status = 'active'
            ORDER BY views DESC
            LIMIT 100
        `);
        await setCached('listings:popular', popularListings.rows, DEFAULT_TTL.LONG);
        
        console.log('✅ Предварительная загрузка кеша завершена');
    } catch (error) {
        console.error('Ошибка предварительной загрузки кеша:', error);
    }
}

// ============================================
= СТАТИСТИКА КЕША
// ============================================

/**
 * Получение статистики использования кеша
 * @returns {Promise<Object>}
 */
async function getCacheStats() {
    try {
        const keys = await require('../../config/redis').client.keys('*');
        const keyCount = keys.length;
        
        // Подсчёт по паттернам
        const patterns = {
            user: keys.filter(k => k.startsWith('user:')).length,
            listing: keys.filter(k => k.startsWith('listing:')).length,
            category: keys.filter(k => k.startsWith('category:')).length,
            search: keys.filter(k => k.startsWith('search:')).length,
            chat: keys.filter(k => k.startsWith('chat:')).length,
            tiktok: keys.filter(k => k.startsWith('tiktok:')).length,
            bonus: keys.filter(k => k.startsWith('bonus:')).length,
            admin: keys.filter(k => k.startsWith('admin:')).length
        };
        
        return {
            totalKeys: keyCount,
            patterns,
            memory: await require('../../config/redis').client.info('memory').then(info => {
                const match = info.match(/used_memory_human:(\d+\.\d+[KMGT]?)/);
                return match ? match[1] : 'unknown';
            })
        };
    } catch (error) {
        console.error('Ошибка получения статистики кеша:', error);
        return { error: error.message };
    }
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    // Основные операции
    getCached,
    setCached,
    deleteCached,
    existsCached,
    getTTL,
    
    // Массовые операции
    getMultipleCached,
    setMultipleCached,
    deleteByPattern,
    
    // Инвалидация
    invalidateUserCache,
    invalidateListingCache,
    invalidateCategoriesCache,
    invalidateSearchCache,
    invalidateMapCache,
    
    // Предзагрузка
    warmUpCache,
    
    // Статистика
    getCacheStats,
    
    // Константы
    CACHE_KEYS,
    DEFAULT_TTL
};