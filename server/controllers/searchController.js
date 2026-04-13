/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/controllers/searchController.js
 * Описание: Контроллер поиска (полнотекстовый, по фото, автодополнение, история, фильтры)
 */

const { Listing, Category, User } = require('../models');
const { get, set, del, incr, sadd, smembers, srem, zincrby, zrevrange } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { processQuery, cleanText, extractWords } = require('../services/searchService');
const { config } = require('../../config/env');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_TTL = {
    search: 300,           // 5 минут
    suggest: 3600,         // 1 час
    popular: 3600,         // 1 час
    history: 86400         // 24 часа
};

const SEARCH_CONFIG = {
    minQueryLength: 2,
    maxResults: 100,
    defaultLimit: 20,
    weights: {
        title: 5,
        description: 1,
        category: 3,
        city: 2,
        tags: 4
    }
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
    'этой', 'перед', 'иногда', 'лучше', 'чуть', 'том', 'нельзя', 'такой', 'им', 'более'
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
    'кошка': ['кот', 'котенок', 'мейнкун', 'британец'],
    'ремонт': ['отделка', 'евроремонт', 'косметический ремонт'],
    'доставка': ['перевозка', 'транспортировка', 'курьер'],
    'уборка': ['клининг', 'чистка', 'уборка квартир'],
    'маникюр': ['нейл-арт', 'ногти', 'гель-лак'],
    'парикмахер': ['стрижка', 'укладка', 'прическа']
};

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function cleanText(text) {
    if (!text) return '';
    return text
        .toLowerCase()
        .replace(/[^\w\sа-яё]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractWords(text) {
    if (!text) return [];
    return text.split(/\s+/).filter(w => w.length > 0);
}

function processQueryText(query) {
    const clean = cleanText(query);
    const words = extractWords(clean);
    
    const filteredWords = words.filter(w => !STOP_WORDS.has(w) && w.length >= 2);
    
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

// ============================================
// ПОЛНОТЕКСТОВЫЙ ПОИСК
// ============================================

async function searchListings(req, res) {
    const {
        q,
        category_id,
        price_min,
        price_max,
        city,
        radius,
        lat,
        lng,
        seller_type = 'all',
        sort = 'relevance',
        limit = 20,
        page = 1
    } = req.query;

    if (!q || q.trim().length < SEARCH_CONFIG.minQueryLength) {
        return res.json({
            success: true,
            listings: [],
            total: 0,
            message: 'Введите минимум 2 символа для поиска'
        });
    }

    try {
        const cacheKey = `search:${q}:${category_id}:${price_min}:${price_max}:${city}:${radius}:${sort}:${page}:${limit}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }

        const processedQuery = processQueryText(q);
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        let sql = `
            SELECT l.*, u.name as seller_name, u.avatar as seller_avatar, u.rating as seller_rating,
                   ts_rank_cd(to_tsvector('russian', l.title || ' ' || COALESCE(l.description, '')), 
                              plainto_tsquery('russian', $1)) as relevance
            FROM listings l
            JOIN users u ON u.id = l.user_id
            WHERE l.status = 'active'
        `;
        const params = [q];
        let idx = 2;

        // Полнотекстовый поиск
        sql += ` AND (l.title ILIKE $${idx} OR l.description ILIKE $${idx}`;
        params.push(`%${q}%`);
        idx++;
        
        // Поиск по синонимам
        if (processedQuery.synonyms.length > 0) {
            const synonymPatterns = processedQuery.synonyms.map(s => `%${s}%`);
            for (const pattern of synonymPatterns) {
                sql += ` OR l.title ILIKE $${idx} OR l.description ILIKE $${idx}`;
                params.push(pattern);
                idx++;
            }
        }
        sql += `)`;

        // Фильтр по категории
        if (category_id) {
            sql += ` AND l.category_id = $${idx}`;
            params.push(parseInt(category_id));
            idx++;
        }

        // Фильтр по цене
        if (price_min) {
            sql += ` AND l.price >= $${idx}`;
            params.push(parseInt(price_min));
            idx++;
        }
        if (price_max) {
            sql += ` AND l.price <= $${idx}`;
            params.push(parseInt(price_max));
            idx++;
        }

        // Фильтр по городу
        if (city) {
            sql += ` AND l.city ILIKE $${idx}`;
            params.push(`%${city}%`);
            idx++;
        }

        // Фильтр по радиусу
        if (radius && lat && lng) {
            sql += ` AND l.latitude IS NOT NULL AND l.longitude IS NOT NULL`;
            sql += ` AND (6371 * acos(cos(radians($${idx})) * cos(radians(l.latitude)) * 
                          cos(radians(l.longitude) - radians($${idx + 1})) + 
                          sin(radians($${idx})) * sin(radians(l.latitude)))) <= $${idx + 2}`;
            params.push(parseFloat(lat), parseFloat(lng), parseInt(radius));
            idx += 3;
        }

        // Фильтр по типу продавца
        if (seller_type === 'private') {
            sql += ` AND l.user_id NOT IN (SELECT user_id FROM company_profiles)`;
        } else if (seller_type === 'company') {
            sql += ` AND l.user_id IN (SELECT user_id FROM company_profiles)`;
        }

        // Сортировка
        switch (sort) {
            case 'price_asc':
                sql += ` ORDER BY l.price ASC`;
                break;
            case 'price_desc':
                sql += ` ORDER BY l.price DESC`;
                break;
            case 'created_asc':
                sql += ` ORDER BY l.created_at ASC`;
                break;
            case 'created_desc':
                sql += ` ORDER BY l.created_at DESC`;
                break;
            case 'popular':
                sql += ` ORDER BY l.views DESC, l.likes DESC`;
                break;
            default:
                sql += ` ORDER BY relevance DESC, l.created_at DESC`;
        }

        // Подсчёт общего количества
        const countSql = sql.replace(/SELECT.*FROM/, 'SELECT COUNT(*) FROM');
        const countResult = await Listing.query(countSql, params.slice(0, idx - 1));
        const total = parseInt(countResult.rows[0].count);

        // Пагинация
        sql += ` LIMIT $${idx} OFFSET $${idx + 1}`;
        params.push(parseInt(limit), offset);

        const result = await Listing.query(sql, params);

        // Сохраняем поисковый запрос в аналитику
        if (req.user) {
            await addJob('analyticsQueue', 'saveSearchAnalytics', {
                query: q,
                userId: req.user.id,
                resultsCount: total
            });
        }

        const response = {
            listings: result.rows,
            total,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            },
            processed_query: processedQuery
        };

        await set(cacheKey, response, CACHE_TTL.search);
        res.json({ success: true, ...response });
    } catch (error) {
        console.error('Ошибка поиска:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОИСК ПО ФОТО (AI)
// ============================================

async function searchByPhoto(req, res) {
    if (!req.file) {
        return res.status(400).json({ error: 'Фото не загружено' });
    }

    try {
        // Если AI отключён или нет ключей, возвращаем заглушку
        if (!config.ai.yandexVision.enabled) {
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            return res.json({
                success: true,
                mock: true,
                message: 'Поиск по фото временно недоступен. Используйте текстовый поиск.',
                suggestions: [],
                listings: []
            });
        }

        // Здесь будет реальный запрос к Yandex Vision API
        // Для продакшена нужно реализовать:
        // 1. Отправку фото в Yandex Vision
        // 2. Получение описания и тегов
        // 3. Поиск похожих объявлений по тегам
        
        // Пока возвращаем заглушку
        if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.json({
            success: true,
            suggestions: [],
            listings: [],
            message: 'Функция поиска по фото в разработке'
        });
    } catch (error) {
        console.error('Ошибка поиска по фото:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// АВТОДОПОЛНЕНИЕ
// ============================================

async function getAutocomplete(req, res) {
    const { q, limit = 10 } = req.query;
    
    if (!q || q.length < 2) {
        return res.json({ success: true, suggestions: [] });
    }
    
    try {
        const cacheKey = `suggest:${q}:${limit}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, suggestions: cached, fromCache: true });
        }
        
        const suggestions = [];
        const cleanQuery = cleanText(q);
        
        // 1. Поиск по категориям
        const categories = await Category.query(
            `SELECT name, COUNT(*) as count
             FROM categories
             WHERE name ILIKE $1
             GROUP BY name
             LIMIT $2`,
            [`%${cleanQuery}%`, parseInt(limit) / 2]
        );
        
        for (const cat of categories.rows) {
            suggestions.push({
                text: cat.name,
                type: 'category',
                count: parseInt(cat.count)
            });
        }
        
        // 2. Поиск по популярным запросам
        const popularResult = await Listing.query(`
            SELECT search_query, COUNT(*) as count
            FROM search_analytics
            WHERE search_query ILIKE $1
            GROUP BY search_query
            ORDER BY count DESC
            LIMIT $2
        `, [`%${cleanQuery}%`, parseInt(limit) - suggestions.length]);
        
        for (const row of popularResult.rows) {
            suggestions.push({
                text: row.search_query,
                type: 'popular',
                count: parseInt(row.count)
            });
        }
        
        await set(cacheKey, suggestions, CACHE_TTL.suggest);
        res.json({ success: true, suggestions });
    } catch (error) {
        console.error('Ошибка автодополнения:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ИСТОРИЯ ПОИСКА
// ============================================

async function getSearchHistory(req, res) {
    try {
        const history = await smembers(`search:history:${req.user.id}`);
        const historyWithDates = await Promise.all(
            history.map(async (query) => {
                const timestamp = await get(`search:history:${req.user.id}:${query}`);
                return { query, timestamp: parseInt(timestamp) || 0 };
            })
        );
        
        historyWithDates.sort((a, b) => b.timestamp - a.timestamp);
        
        res.json({ success: true, history: historyWithDates });
    } catch (error) {
        console.error('Ошибка получения истории поиска:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function saveSearchHistory(req, res) {
    const { query } = req.body;
    
    if (!query || query.length < 2) {
        return res.status(400).json({ error: 'Запрос слишком короткий' });
    }
    
    try {
        await sadd(`search:history:${req.user.id}`, query);
        await set(`search:history:${req.user.id}:${query}`, Date.now(), CACHE_TTL.history);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка сохранения истории поиска:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function clearSearchHistory(req, res) {
    try {
        const history = await smembers(`search:history:${req.user.id}`);
        for (const query of history) {
            await del(`search:history:${req.user.id}:${query}`);
        }
        await del(`search:history:${req.user.id}`);
        
        res.json({ success: true, message: 'История поиска очищена' });
    } catch (error) {
        console.error('Ошибка очистки истории поиска:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function deleteSearchHistoryItem(req, res) {
    const { query } = req.params;
    
    try {
        await srem(`search:history:${req.user.id}`, query);
        await del(`search:history:${req.user.id}:${query}`);
        
        res.json({ success: true, message: 'Запрос удалён из истории' });
    } catch (error) {
        console.error('Ошибка удаления запроса из истории:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОПУЛЯРНЫЕ ЗАПРОСЫ
// ============================================

async function getPopularSearches(req, res) {
    const { limit = 10 } = req.query;
    
    try {
        const cached = await get('search:popular');
        if (cached) {
            return res.json({ success: true, queries: cached.slice(0, parseInt(limit)), fromCache: true });
        }
        
        const result = await Listing.query(`
            SELECT search_query, COUNT(*) as count
            FROM search_analytics
            WHERE created_at > NOW() - INTERVAL '7 days'
            GROUP BY search_query
            ORDER BY count DESC
            LIMIT 20
        `);
        
        const queries = result.rows.map(row => ({
            query: row.search_query,
            count: parseInt(row.count)
        }));
        
        await set('search:popular', queries, CACHE_TTL.popular);
        
        res.json({ success: true, queries: queries.slice(0, parseInt(limit)) });
    } catch (error) {
        console.error('Ошибка получения популярных запросов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// РАСШИРЕННЫЙ ПОИСК (СОХРАНЁННЫЕ ФИЛЬТРЫ)
// ============================================

async function saveSearchFilter(req, res) {
    const { name, filters } = req.body;
    
    if (!name || !filters) {
        return res.status(400).json({ error: 'Название и фильтры обязательны' });
    }
    
    try {
        const savedFilters = await get(`search:saved:${req.user.id}`) || [];
        const newFilter = {
            id: Date.now(),
            name,
            filters,
            created_at: new Date().toISOString()
        };
        
        savedFilters.unshift(newFilter);
        await set(`search:saved:${req.user.id}`, savedFilters.slice(0, 20), CACHE_TTL.history);
        
        res.json({ success: true, filter: newFilter });
    } catch (error) {
        console.error('Ошибка сохранения фильтра:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function getSavedFilters(req, res) {
    try {
        const savedFilters = await get(`search:saved:${req.user.id}`) || [];
        res.json({ success: true, filters: savedFilters });
    } catch (error) {
        console.error('Ошибка получения сохранённых фильтров:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function deleteSavedFilter(req, res) {
    const { id } = req.params;
    
    try {
        const savedFilters = await get(`search:saved:${req.user.id}`) || [];
        const updated = savedFilters.filter(f => f.id !== parseInt(id));
        await set(`search:saved:${req.user.id}`, updated, CACHE_TTL.history);
        
        res.json({ success: true, message: 'Фильтр удалён' });
    } catch (error) {
        console.error('Ошибка удаления фильтра:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    searchListings,
    searchByPhoto,
    getAutocomplete,
    getSearchHistory,
    saveSearchHistory,
    clearSearchHistory,
    deleteSearchHistoryItem,
    getPopularSearches,
    saveSearchFilter,
    getSavedFilters,
    deleteSavedFilter,
    processQueryText,
    cleanText,
    extractWords,
    STOP_WORDS,
    SYNONYMS,
    SEARCH_CONFIG
};