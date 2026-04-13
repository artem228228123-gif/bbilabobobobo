/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/routes/tiktok.js
 * Описание: Маршруты для TikTok-ленты (получение ленты, лайки, подписки, просмотры)
 */

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');

const router = express.Router();
const { Listing, Favorite, User } = require('../models');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { get, set, del, zadd, zincrby, zrevrange, zrevrank, zscore, zrem, sadd, srem, sismember } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

// Валидация ошибок
function validate(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    return null;
}

// Получение кеша ленты пользователя
async function getUserFeedCache(userId, type = 'for_you') {
    const cacheKey = `tiktok:feed:${type}:${userId}`;
    const cached = await get(cacheKey);
    if (cached) return cached;
    return null;
}

// Сохранение ленты в кеш
async function setUserFeedCache(userId, type, feed, ttl = 3600) {
    const cacheKey = `tiktok:feed:${type}:${userId}`;
    await set(cacheKey, feed, ttl);
}

// Очистка кеша ленты пользователя
async function clearUserFeedCache(userId) {
    await del(`tiktok:feed:for_you:${userId}`);
    await del(`tiktok:feed:subscriptions:${userId}`);
}

// Обновление счёта вовлечённости объявления
async function updateEngagementScore(listingId, action, value = 1) {
    const multipliers = {
        view: 1,
        like: 10,
        share: 15,
        chat: 20,
        save: 12,
        complete_view: 25
    };
    
    const increment = (multipliers[action] || 1) * value;
    await zincrby('tiktok:engagement', increment, listingId);
}

// Получение популярных объявлений для ленты
async function getTrendingListings(limit = 50) {
    const cached = await get('tiktok:trending');
    if (cached) return cached;
    
    const trending = await zrevrange('tiktok:engagement', 0, limit - 1, true);
    await set('tiktok:trending', trending, 300); // кеш на 5 минут
    return trending;
}

// ============================================
// GET /api/v1/tiktok/feed
// Получение TikTok-ленты
// ============================================
router.get(
    '/feed',
    optionalAuth,
    [
        query('type').optional().isIn(['for_you', 'subscriptions']),
        query('limit').optional().isInt({ min: 1, max: 20 }),
        query('cursor').optional().isString()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { type = 'for_you', limit = 10, cursor } = req.query;
        const userId = req.user?.id;

        try {
            // Проверяем кеш
            if (!cursor) {
                const cached = await getUserFeedCache(userId || 'anonymous', type);
                if (cached && cached.listings && cached.listings.length > 0) {
                    return res.json({
                        success: true,
                        listings: cached.listings,
                        nextCursor: cached.nextCursor,
                        hasMore: cached.hasMore,
                        fromCache: true
                    });
                }
            }

            let listings = [];
            let nextCursor = null;
            let hasMore = false;

            if (type === 'subscriptions' && userId) {
                // Лента подписок
                const subscriptions = await get(`user:subscriptions:${userId}`);
                let sellerIds = [];
                
                if (subscriptions) {
                    sellerIds = JSON.parse(subscriptions);
                } else {
                    const result = await require('../models').query(
                        `SELECT seller_id FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
                        [userId]
                    );
                    sellerIds = result.rows.map(r => r.seller_id);
                    await set(`user:subscriptions:${userId}`, JSON.stringify(sellerIds), 300);
                }
                
                if (sellerIds.length > 0) {
                    const params = [sellerIds, parseInt(limit) + 1];
                    let sql = `
                        SELECT l.*, u.name as seller_name, u.avatar as seller_avatar, u.rating as seller_rating
                        FROM listings l
                        JOIN users u ON u.id = l.user_id
                        WHERE l.user_id = ANY($1::int[]) AND l.status = 'active'
                        ORDER BY l.created_at DESC
                        LIMIT $2
                    `;
                    
                    if (cursor) {
                        sql = sql.replace('ORDER BY', 'AND l.id < $3 ORDER BY');
                        params.push(cursor);
                    }
                    
                    const result = await require('../models').query(sql, params);
                    hasMore = result.rows.length > parseInt(limit);
                    listings = hasMore ? result.rows.slice(0, -1) : result.rows;
                    nextCursor = hasMore ? listings[listings.length - 1]?.id : null;
                }
            } else {
                // Лента "Для вас" (алгоритмическая)
                const trending = await getTrendingListings(100);
                const trendingIds = trending.map(t => t.value);
                
                // Берём 60% популярных, 30% из категорий пользователя, 10% новых
                let finalIds = [...trendingIds];
                
                if (userId) {
                    // Получаем предпочтения пользователя
                    const userCategories = await get(`user:categories:${userId}`);
                    if (userCategories) {
                        const cats = JSON.parse(userCategories);
                        if (cats.length > 0) {
                            const catResult = await require('../models').query(
                                `SELECT id FROM listings 
                                 WHERE category_id = ANY($1::int[]) AND status = 'active'
                                 ORDER BY created_at DESC LIMIT 30`,
                                [cats]
                            );
                            const catIds = catResult.rows.map(r => r.id);
                            finalIds = [...new Set([...trendingIds, ...catIds])];
                        }
                    }
                }
                
                // Добавляем новые объявления
                const newResult = await require('../models').query(
                    `SELECT id FROM listings 
                     WHERE status = 'active' AND created_at > NOW() - INTERVAL '2 days'
                     ORDER BY created_at DESC LIMIT 20`
                );
                const newIds = newResult.rows.map(r => r.id);
                finalIds = [...new Set([...finalIds, ...newIds])];
                
                // Перемешиваем
                for (let i = finalIds.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [finalIds[i], finalIds[j]] = [finalIds[j], finalIds[i]];
                }
                
                // Пагинация
                const startIndex = cursor ? parseInt(cursor) : 0;
                const pagedIds = finalIds.slice(startIndex, startIndex + parseInt(limit) + 1);
                hasMore = pagedIds.length > parseInt(limit);
                const displayIds = hasMore ? pagedIds.slice(0, -1) : pagedIds;
                nextCursor = hasMore ? startIndex + parseInt(limit) : null;
                
                if (displayIds.length > 0) {
                    const result = await require('../models').query(
                        `SELECT l.*, u.name as seller_name, u.avatar as seller_avatar, u.rating as seller_rating
                         FROM listings l
                         JOIN users u ON u.id = l.user_id
                         WHERE l.id = ANY($1::int[]) AND l.status = 'active'`,
                        [displayIds]
                    );
                    
                    // Сохраняем порядок
                    const listingMap = new Map(result.rows.map(l => [l.id, l]));
                    listings = displayIds.map(id => listingMap.get(id)).filter(l => l);
                }
            }
            
            // Добавляем информацию для авторизованных пользователей
            if (userId && listings.length > 0) {
                for (const listing of listings) {
                    listing.isLiked = await Favorite.isFavorite(userId, listing.id);
                    listing.isSubscribed = await sismember(`user:subscriptions_set:${userId}`, listing.user_id);
                }
            }
            
            // Кешируем первую страницу
            if (!cursor && listings.length > 0) {
                await setUserFeedCache(userId || 'anonymous', type, {
                    listings,
                    nextCursor,
                    hasMore
                }, 300);
            }
            
            res.json({
                success: true,
                listings,
                nextCursor,
                hasMore,
                count: listings.length
            });
            
        } catch (error) {
            console.error('Ошибка получения TikTok-ленты:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/tiktok/:listingId/like
// Лайк объявления в TikTok-ленте
// ============================================
router.post(
    '/:listingId/like',
    authenticate,
    [
        param('listingId').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { listingId } = req.params;

        try {
            const listing = await Listing.findById(listingId);
            if (!listing || listing.status !== 'active') {
                return res.status(404).json({ error: 'Объявление не найдено' });
            }
            
            const isLiked = await Favorite.isFavorite(req.user.id, listingId);
            
            if (isLiked) {
                await Favorite.remove(req.user.id, listingId);
                await updateEngagementScore(listingId, 'like', -1);
                res.json({ success: true, liked: false, likesCount: listing.likes - 1 });
            } else {
                await Favorite.add(req.user.id, listingId);
                await updateEngagementScore(listingId, 'like', 1);
                const newLikes = await Listing.incrementLikes(listingId);
                res.json({ success: true, liked: true, likesCount: newLikes });
            }
            
        } catch (error) {
            console.error('Ошибка лайка в TikTok-ленте:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/tiktok/subscribe/:sellerId
// Подписка на продавца
// ============================================
router.post(
    '/subscribe/:sellerId',
    authenticate,
    [
        param('sellerId').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { sellerId } = req.params;

        if (req.user.id === parseInt(sellerId)) {
            return res.status(400).json({ error: 'Нельзя подписаться на самого себя' });
        }

        try {
            const seller = await User.findById(sellerId);
            if (!seller) {
                return res.status(404).json({ error: 'Продавец не найден' });
            }
            
            // Проверяем, подписан ли уже
            const isSubscribed = await sismember(`user:subscriptions_set:${req.user.id}`, sellerId);
            
            if (isSubscribed) {
                return res.status(400).json({ error: 'Вы уже подписаны на этого продавца' });
            }
            
            // Добавляем подписку в БД
            await require('../models').query(
                `INSERT INTO subscriptions (user_id, seller_id, created_at)
                 VALUES ($1, $2, NOW())`,
                [req.user.id, sellerId]
            );
            
            // Обновляем Redis
            await sadd(`user:subscriptions_set:${req.user.id}`, sellerId);
            await del(`user:subscriptions:${req.user.id}`);
            await clearUserFeedCache(req.user.id);
            
            // Увеличиваем счётчик подписок продавца
            await zincrby('tiktok:subscribers', 1, sellerId);
            
            res.json({ 
                success: true, 
                subscribed: true,
                message: `Вы подписались на ${seller.name}`
            });
            
        } catch (error) {
            console.error('Ошибка подписки:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// DELETE /api/v1/tiktok/subscribe/:sellerId
// Отписка от продавца
// ============================================
router.delete(
    '/subscribe/:sellerId',
    authenticate,
    [
        param('sellerId').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { sellerId } = req.params;

        try {
            const result = await require('../models').query(
                `DELETE FROM subscriptions WHERE user_id = $1 AND seller_id = $2 RETURNING *`,
                [req.user.id, sellerId]
            );
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Подписка не найдена' });
            }
            
            // Обновляем Redis
            await srem(`user:subscriptions_set:${req.user.id}`, sellerId);
            await del(`user:subscriptions:${req.user.id}`);
            await clearUserFeedCache(req.user.id);
            
            // Уменьшаем счётчик подписок продавца
            await zincrby('tiktok:subscribers', -1, sellerId);
            
            res.json({ 
                success: true, 
                subscribed: false,
                message: 'Вы отписались от продавца'
            });
            
        } catch (error) {
            console.error('Ошибка отписки:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/tiktok/subscriptions
// Список подписок пользователя
// ============================================
router.get(
    '/subscriptions',
    authenticate,
    [
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('offset').optional().isInt({ min: 0 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { limit = 50, offset = 0 } = req.query;

        try {
            const result = await require('../models').query(
                `SELECT s.*, u.name, u.avatar, u.rating, u.city,
                        (SELECT COUNT(*) FROM listings WHERE user_id = s.seller_id AND status = 'active') as active_listings
                 FROM subscriptions s
                 JOIN users u ON u.id = s.seller_id
                 WHERE s.user_id = $1
                 ORDER BY s.created_at DESC
                 LIMIT $2 OFFSET $3`,
                [req.user.id, parseInt(limit), parseInt(offset)]
            );
            
            const countResult = await require('../models').query(
                `SELECT COUNT(*) FROM subscriptions WHERE user_id = $1`,
                [req.user.id]
            );
            
            res.json({
                success: true,
                subscriptions: result.rows,
                total: parseInt(countResult.rows[0].count),
                limit: parseInt(limit),
                offset: parseInt(offset)
            });
            
        } catch (error) {
            console.error('Ошибка получения подписок:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/tiktok/:listingId/view
// Отслеживание просмотра в TikTok-ленте
// ============================================
router.post(
    '/:listingId/view',
    optionalAuth,
    [
        param('listingId').isInt(),
        body('duration').optional().isInt({ min: 0, max: 300 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { listingId } = req.params;
        const { duration = 0 } = req.body;

        try {
            // Увеличиваем счётчик просмотров
            await Listing.incrementViews(listingId);
            
            // Если просмотр больше 3 секунд, считаем качественным
            if (duration >= 3) {
                await updateEngagementScore(listingId, 'complete_view', 1);
            }
            
            // Сохраняем историю просмотров для рекомендаций
            if (req.user) {
                await sadd(`user:viewed:${req.user.id}`, listingId);
                
                // Получаем категорию объявления для рекомендаций
                const listing = await Listing.findById(listingId);
                if (listing && listing.category_id) {
                    await zincrby(`user:category_prefs:${req.user.id}`, 1, listing.category_id);
                }
            }
            
            res.json({ success: true });
            
        } catch (error) {
            console.error('Ошибка отслеживания просмотра:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/tiktok/:listingId/share
// Отслеживание шеринга
// ============================================
router.post(
    '/:listingId/share',
    optionalAuth,
    [
        param('listingId').isInt(),
        body('platform').optional().isString()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { listingId } = req.params;
        const { platform = 'unknown' } = req.body;

        try {
            await updateEngagementScore(listingId, 'share', 1);
            
            // Логируем шеринг
            await require('../models').query(
                `INSERT INTO share_logs (listing_id, user_id, platform, created_at)
                 VALUES ($1, $2, $3, NOW())`,
                [listingId, req.user?.id || null, platform]
            );
            
            res.json({ success: true });
            
        } catch (error) {
            console.error('Ошибка отслеживания шеринга:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/tiktok/trending
// Трендовые объявления (для админки)
// ============================================
router.get(
    '/trending',
    authenticate,
    async (req, res) => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }

        try {
            const trending = await getTrendingListings(100);
            
            // Получаем полные данные объявлений
            const ids = trending.map(t => t.value);
            if (ids.length > 0) {
                const result = await require('../models').query(
                    `SELECT l.*, u.name as seller_name 
                     FROM listings l
                     JOIN users u ON u.id = l.user_id
                     WHERE l.id = ANY($1::int[])`,
                    [ids]
                );
                
                const listingMap = new Map(result.rows.map(l => [l.id, l]));
                const listingsWithScores = trending.map(t => ({
                    ...listingMap.get(t.value),
                    engagementScore: t.score
                })).filter(l => l);
                
                res.json({
                    success: true,
                    trending: listingsWithScores
                });
            } else {
                res.json({ success: true, trending: [] });
            }
            
        } catch (error) {
            console.error('Ошибка получения трендов:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/tiktok/feed/refresh
// Принудительное обновление кеша ленты (для админа)
// ============================================
router.post(
    '/feed/refresh',
    authenticate,
    async (req, res) => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }

        try {
            // Очищаем кеш трендов
            await del('tiktok:trending');
            
            // Пересчитываем рейтинг вовлечённости
            const listings = await require('../models').query(
                `SELECT id, views, likes FROM listings WHERE status = 'active'`
            );
            
            for (const listing of listings.rows) {
                const score = (listing.views || 0) + (listing.likes || 0) * 10;
                await set(`tiktok:engagement:${listing.id}`, score);
            }
            
            res.json({ success: true, message: 'Кеш TikTok-ленты обновлён' });
            
        } catch (error) {
            console.error('Ошибка обновления кеша:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// ЭКСПОРТ
// ============================================
module.exports = router;