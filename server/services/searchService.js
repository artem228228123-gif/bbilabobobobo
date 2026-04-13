/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/searchService.js
 * Описание: Сервис поиска (индексация, полнотекстовый поиск, ранжирование, синонимы)
 */

const { query } = require('../../config/database');
const { get, set, del, sadd, smembers } = require('../../config/redis');
const { addJob } = require('../../config/redis');

// ============================================
// КОНФИГУРАЦИЯ
// ============================================

const SEARCH_CONFIG = {
    minWordLength: 3,
    maxResults: 100,
    defaultLimit: 20,
    cacheTTL: 300, // 5 минут
    fuzzyThreshold: 0.7, // Порог нечёткого поиска
    weightTitle: 5,      // Вес заголовка
    weightDescription: 1, // Вес описания
    weightCategory: 3,    // Вес категории
    weightCity: 2,        // Вес города
    weightTags: 4         // Вес тегов
};

// Стоп-слова (игнорируются при поиске)
const STOP_WORDS = new Set([
    'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то', 'все', 'она',
    'так', 'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по', 'только', 'ее',
    'мне', 'было', 'вот', 'от', 'меня', 'еще', 'нет', 'о', 'из', 'ему', 'теперь', 'когда',
    'даже', 'ну', 'вдруг', 'ли', 'если', 'уже', 'или', 'ни', 'быть', 'был', 'него', 'до',
    'вас', 'нибудь', 'опять', 'уж', 'вам', 'ведь', 'там', 'потом', 'себя', 'ничего', 'ей',
    'может', 'они', 'тут', 'где', 'есть', 'надо', 'ней', 'для', 'мы', 'тебя', 'их', 'чем',
    'была', 'сам', 'чтоб', 'без', 'будто', 'человек', 'чего', 'раз', 'тоже', 'себе', 'под',
    'жизнь', 'будет', 'ж', 'тогда', 'кто', 'этот', 'того', 'потому', 'этого', 'какой',
    'совсем', 'ним', 'здесь', 'этом', 'один', 'почти', 'мой', 'тем', 'чтобы', 'нее', 'сейчас',
    'были', 'куда', 'зачем', 'всех', 'никогда', 'можно', 'при', 'наконец', 'два', 'об', 'другой',
    'хоть', 'после', 'над', 'больше', 'тот', 'через', 'эти', 'нас', 'про', 'всего', 'них',
    'какая', 'много', 'разве', 'сказал', 'три', 'эту', 'моя', 'впрочем', 'хорошо', 'свою',
    'этой', 'перед', 'иногда', 'лучше', 'чуть', 'том', 'нельзя', 'такой', 'им', 'более',
    'всегда', 'конечно', 'всю', 'между'
]);

// Словарь синонимов
const SYNONYMS = {
    'авто': ['автомобиль', 'машина', 'транспорт', 'легковушка'],
    'квартира': ['жилье', 'апартаменты', 'недвижимость', 'комната'],
    'телефон': ['смартфон', 'мобильник', 'айфон', 'андроид'],
    'ноутбук': ['компьютер', 'лэптоп', 'ноут', 'макбук'],
    'планшет': ['таблет', 'айпад', 'андроид', 'гаджет'],
    'холодильник': ['морозилка', 'рефрижератор', 'холод'],
    'стиралка': ['стиральная машина', 'автомат', 'машинка'],
    'диван': ['софа', 'кушетка', 'тахта', 'кресло'],
    'стул': ['табурет', 'кресло', 'пуфик'],
    'стол': ['парта', 'тумба', 'журнальный'],
    'игрушка': ['кукла', 'машинка', 'конструктор', 'робот'],
    'одежда': ['вещи', 'шмотки', 'гардероб', 'футболка'],
    'обувь': ['туфли', 'ботинки', 'кроссовки', 'сапоги'],
    'собака': ['пес', 'щенок', 'корги', 'лабрадор', 'овчарка'],
    'кошка': ['кот', 'котенок', 'мейнкун', 'британец']
};

// ============================================
// ИНДЕКСАЦИЯ ОБЪЯВЛЕНИЯ
// ============================================

/**
 * Индексация объявления для полнотекстового поиска
 * @param {number} listingId - ID объявления
 * @param {Object} data - данные объявления
 */
async function indexListing(listingId, data) {
    try {
        const {
            title,
            description,
            category_name,
            city,
            tags = []
        } = data;
        
        // Очищаем текст
        const cleanTitle = cleanText(title);
        const cleanDescription = cleanText(description || '');
        const cleanCategory = cleanText(category_name || '');
        const cleanCity = cleanText(city || '');
        const cleanTags = tags.map(t => cleanText(t)).join(' ');
        
        // Создаём поисковый документ
        const searchDocument = {
            id: listingId,
            title: cleanTitle,
            description: cleanDescription,
            category: cleanCategory,
            city: cleanCity,
            tags: cleanTags,
            fulltext: `${cleanTitle} ${cleanDescription} ${cleanCategory} ${cleanCity} ${cleanTags}`
        };
        
        // Сохраняем в Redis (для быстрого поиска)
        await set(`search:doc:${listingId}`, searchDocument, 86400 * 7);
        
        // Добавляем в индекс категории
        if (cleanCategory) {
            await sadd(`search:index:category:${cleanCategory}`, listingId);
        }
        
        // Добавляем в индекс города
        if (cleanCity) {
            await sadd(`search:index:city:${cleanCity}`, listingId);
        }
        
        // Добавляем в индекс по словам (для автодополнения)
        const words = extractWords(searchDocument.fulltext);
        for (const word of words) {
            if (word.length >= SEARCH_CONFIG.minWordLength) {
                await sadd(`search:index:word:${word}`, listingId);
            }
        }
        
        return true;
    } catch (error) {
        console.error('Ошибка индексации объявления:', error);
        return false;
    }
}

/**
 * Удаление объявления из индекса
 * @param {number} listingId - ID объявления
 */
async function removeFromIndex(listingId) {
    try {
        const doc = await get(`search:doc:${listingId}`);
        if (doc) {
            const words = extractWords(doc.fulltext);
            for (const word of words) {
                if (word.length >= SEARCH_CONFIG.minWordLength) {
                    await del(`search:index:word:${word}`);
                }
            }
        }
        
        await del(`search:doc:${listingId}`);
        return true;
    } catch (error) {
        console.error('Ошибка удаления из индекса:', error);
        return false;
    }
}

// ============================================
// ПОИСК
// ============================================

/**
 * Полнотекстовый поиск объявлений
 * @param {string} queryText - поисковый запрос
 * @param {Object} filters - фильтры
 * @returns {Promise<Array>} - результаты поиска
 */
async function search(queryText, filters = {}) {
    const {
        limit = SEARCH_CONFIG.defaultLimit,
        offset = 0,
        category_id = null,
        city = null,
        price_min = null,
        price_max = null,
        sort = 'relevance'
    } = filters;
    
    if (!queryText || queryText.trim().length < SEARCH_CONFIG.minWordLength) {
        return { listings: [], total: 0 };
    }
    
    // Кеш-ключ
    const cacheKey = `search:result:${queryText}:${JSON.stringify(filters)}`;
    const cached = await get(cacheKey);
    if (cached) {
        return cached;
    }
    
    try {
        // Обрабатываем запрос
        const processedQuery = processQuery(queryText);
        const searchTerms = processedQuery.terms;
        const synonyms = processedQuery.synonyms;
        
        // Ищем объявления
        let sql = `
            SELECT l.*, u.name as seller_name, u.avatar as seller_avatar, u.rating as seller_rating,
                   ts_rank_cd(to_tsvector('russian', l.title || ' ' || COALESCE(l.description, '')), plainto_tsquery('russian', $1)) as relevance
            FROM listings l
            JOIN users u ON u.id = l.user_id
            WHERE l.status = 'active'
            AND (l.title ILIKE $2 OR l.description ILIKE $2)
        `;
        
        const params = [queryText, `%${queryText}%`];
        let idx = 3;
        
        // Фильтр по категории
        if (category_id) {
            sql += ` AND l.category_id = $${idx}`;
            params.push(category_id);
            idx++;
        }
        
        // Фильтр по городу
        if (city) {
            sql += ` AND l.city ILIKE $${idx}`;
            params.push(`%${city}%`);
            idx++;
        }
        
        // Фильтр по цене
        if (price_min !== null) {
            sql += ` AND l.price >= $${idx}`;
            params.push(price_min);
            idx++;
        }
        if (price_max !== null) {
            sql += ` AND l.price <= $${idx}`;
            params.push(price_max);
            idx++;
        }
        
        // Сортировка
        if (sort === 'relevance') {
            sql += ` ORDER BY relevance DESC, l.created_at DESC`;
        } else if (sort === 'price_asc') {
            sql += ` ORDER BY l.price ASC`;
        } else if (sort === 'price_desc') {
            sql += ` ORDER BY l.price DESC`;
        } else {
            sql += ` ORDER BY l.created_at DESC`;
        }
        
        // Подсчёт общего количества
        const countSql = sql.replace(/SELECT.*FROM/, 'SELECT COUNT(*) FROM');
        const countResult = await query(countSql, params.slice(0, idx - 1));
        const total = parseInt(countResult.rows[0].count);
        
        // Пагинация
        sql += ` LIMIT $${idx} OFFSET $${idx + 1}`;
        params.push(limit, offset);
        
        const result = await query(sql, params);
        
        const response = {
            listings: result.rows,
            total,
            query: queryText,
            processedQuery: searchTerms
        };
        
        // Кешируем результат
        await set(cacheKey, response, SEARCH_CONFIG.cacheTTL);
        
        return response;
    } catch (error) {
        console.error('Ошибка поиска:', error);
        return { listings: [], total: 0 };
    }
}

// ============================================
// АВТОДОПОЛНЕНИЕ
// ============================================

/**
 * Автодополнение поискового запроса
 * @param {string} prefix - начало запроса
 * @param {number} limit - количество результатов
 * @returns {Promise<Array>} - варианты автодополнения
 */
async function autocomplete(prefix, limit = 10) {
    if (!prefix || prefix.length < 2) {
        return [];
    }
    
    const cacheKey = `search:autocomplete:${prefix}:${limit}`;
    const cached = await get(cacheKey);
    if (cached) {
        return cached;
    }
    
    try {
        const suggestions = [];
        const cleanPrefix = cleanText(prefix);
        
        // Поиск популярных запросов
        const popularResult = await query(`
            SELECT search_query, COUNT(*) as count
            FROM search_analytics
            WHERE search_query ILIKE $1
            GROUP BY search_query
            ORDER BY count DESC
            LIMIT $2
        `, [`%${cleanPrefix}%`, limit]);
        
        for (const row of popularResult.rows) {
            suggestions.push({
                text: row.search_query,
                type: 'popular',
                count: parseInt(row.count)
            });
        }
        
        // Поиск по категориям
        if (suggestions.length < limit) {
            const categoryResult = await query(`
                SELECT name, COUNT(*) as count
                FROM categories
                WHERE name ILIKE $1
                GROUP BY name
                LIMIT $2
            `, [`%${cleanPrefix}%`, limit - suggestions.length]);
            
            for (const row of categoryResult.rows) {
                suggestions.push({
                    text: row.name,
                    type: 'category',
                    count: parseInt(row.count)
                });
            }
        }
        
        await set(cacheKey, suggestions, 3600);
        
        return suggestions;
    } catch (error) {
        console.error('Ошибка автодополнения:', error);
        return [];
    }
}

// ============================================
// РАСШИРЕННЫЙ ПОИСК (НЕЧЁТКИЙ)
// ============================================

/**
 * Нечёткий поиск (поиск с учётом опечаток)
 * @param {string} queryText - поисковый запрос
 * @param {number} limit - количество результатов
 * @returns {Promise<Array>} - результаты поиска
 */
async function fuzzySearch(queryText, limit = 20) {
    if (!queryText || queryText.length < 3) {
        return [];
    }
    
    const words = extractWords(cleanText(queryText));
    const candidates = new Map();
    
    for (const word of words) {
        if (word.length < SEARCH_CONFIG.minWordLength) continue;
        
        // Ищем похожие слова в индексе
        const keys = await get(`search:index:word:${word}*`);
        // В реальном проекте нужно использовать более сложный алгоритм
    }
    
    return Array.from(candidates.values()).slice(0, limit);
}

// ============================================
// ОБРАБОТКА ЗАПРОСА
// ============================================

/**
 * Обработка поискового запроса (очистка, стоп-слова, синонимы)
 * @param {string} query - исходный запрос
 * @returns {Object} - обработанный запрос
 */
function processQuery(query) {
    const clean = cleanText(query);
    const words = extractWords(clean);
    
    // Удаляем стоп-слова
    const filteredWords = words.filter(w => !STOP_WORDS.has(w) && w.length >= SEARCH_CONFIG.minWordLength);
    
    // Добавляем синонимы
    const synonymsList = [];
    for (const word of filteredWords) {
        if (SYNONYMS[word]) {
            synonymsList.push(...SYNONYMS[word]);
        }
    }
    
    return {
        original: query,
        cleaned: clean,
        terms: filteredWords,
        synonyms: synonymsList,
        allTerms: [...new Set([...filteredWords, ...synonymsList])]
    };
}

/**
 * Очистка текста (приведение к нижнему регистру, удаление пунктуации)
 * @param {string} text - исходный текст
 * @returns {string} - очищенный текст
 */
function cleanText(text) {
    if (!text) return '';
    return text
        .toLowerCase()
        .replace(/[^\w\sа-яё]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Извлечение слов из текста
 * @param {string} text - текст
 * @returns {Array} - массив слов
 */
function extractWords(text) {
    if (!text) return [];
    return text.split(/\s+/).filter(w => w.length > 0);
}

// ============================================
// АНАЛИТИКА ПОИСКА
// ============================================

/**
 * Сохранение поискового запроса для аналитики
 * @param {string} query - поисковый запрос
 * @param {number} userId - ID пользователя (опционально)
 * @param {number} resultsCount - количество результатов
 */
async function saveSearchAnalytics(query, userId = null, resultsCount = 0) {
    try {
        await query(`
            INSERT INTO search_analytics (search_query, user_id, results_count, created_at)
            VALUES ($1, $2, $3, NOW())
        `, [query, userId, resultsCount]);
        
        // Обновляем популярность запроса в кеше
        await sadd(`search:popular:queries`, query);
    } catch (error) {
        console.error('Ошибка сохранения аналитики поиска:', error);
    }
}

/**
 * Получение популярных поисковых запросов
 * @param {number} limit - количество запросов
 * @returns {Promise<Array>} - популярные запросы
 */
async function getPopularQueries(limit = 10) {
    const cached = await get('search:popular:queries_list');
    if (cached) {
        return cached.slice(0, limit);
    }
    
    try {
        const result = await query(`
            SELECT search_query, COUNT(*) as count
            FROM search_analytics
            WHERE created_at > NOW() - INTERVAL '7 days'
            GROUP BY search_query
            ORDER BY count DESC
            LIMIT $1
        `, [limit * 2]);
        
        const queries = result.rows.map(row => ({
            query: row.search_query,
            count: parseInt(row.count)
        }));
        
        await set('search:popular:queries_list', queries, 3600);
        
        return queries.slice(0, limit);
    } catch (error) {
        console.error('Ошибка получения популярных запросов:', error);
        return [];
    }
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    // Индексация
    indexListing,
    removeFromIndex,
    
    // Поиск
    search,
    autocomplete,
    fuzzySearch,
    
    // Обработка запросов
    processQuery,
    cleanText,
    extractWords,
    
    // Аналитика
    saveSearchAnalytics,
    getPopularQueries,
    
    // Конфигурация
    SEARCH_CONFIG,
    STOP_WORDS,
    SYNONYMS
};