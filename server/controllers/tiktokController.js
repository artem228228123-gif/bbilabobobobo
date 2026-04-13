/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/controllers/tiktokController.js
 * Описание: Контроллер TikTok-ленты (алгоритмическая лента, подписки, вовлечённость)
 */

const { Listing, User, Favorite, Blacklist } = require('../models');
const { get, set, del, incr, zincrby, zrevrange, zadd, sadd, sismember, srem } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_TTL = {
    feed: 300,           // 5 минут
    trending: 300,       // 5 минут
    subscriptions: 300,  // 5 минут
    engagement: 3600     // 1 час
};

const FEED_CONFIG = {
    feedSize: 50,
    weights: {
        view: 1,
        like: 10,
        share: 15,
        chat: 20,
        completeView: 25,
        save: 12
    },
    distribution: {
        trending: 0.5,    // 50% популярные
        categories: 0.3,  // 30% из категорий пользователя
        new: 0.15,        // 15% новые
        subscriptions: 0.05 // 5% подписки
    }
};

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

async function updateEngagementScore(listingId, action, value = 1) {
    const multiplier = FEED_CONFIG.weights[action] || 1;
    const increment = multiplier * value;
    await zincrby('tiktok:engagement', increment, listingId.toString());
}

async function getUserCategoryPreferences(userId) {
    const cached = await get(`user:category_prefs:${userId}`);
    if (cached) {
        return cached;
    }
    
    const result = await Listing.query(`
        SELECT l.category_id, COUNT(*) as count
        FROM listing_views lv
        JOIN listings l ON l.id = lv.listing_id
        WHERE lv.user_id = $1 AND lv.created_at > NOW() - INTERVAL '30 days'
        GROUP BY l.category_id
        ORDER BY count DESC
        LIMIT 10
    `, [userId]);
    
    const preferences = result.rows.map(r => r.category_id);
    await set(`user:category_prefs:${userId}`, preferences, 3600);
    return preferences;
}

async function getUserSubscriptions(userId) {
    const cached = await get(`user:subscriptions:${userId}`);
    if (cached) {
        return cached;
    }
    
    const result = await User.query(
        `SELECT seller_id FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [userId]
    );
    const sellerIds = result.rows.map(r => r.seller_id);
    await set(`user:subscriptions:${userId}`, sellerIds, CACHE_TTL.subscriptions);
    return sellerIds;
}

async function getTrendingListings(limit = 100) {
    const cached = await get('tiktok:trending');
    if (cached) {
        return cached;
    }
    
    const trending = await zrevrange('tiktok:engagement', 0, limit - 1, true);
    const listings = [];
    
    for (const item of trending) {
        const listing = await Listing.findById(parseInt(item.value));
        if (listing && listing.status === 'active') {
            listings.push({
                ...listing,
                engagementScore: parseFloat(item.score)
            });
        }
    }
    
    await set('tiktok:trending', listings, CACHE_TTL.trending);
    return listings;
}

async function clearUserFeedCache(userId) {
    await del(`tiktok:feed:for_you:${userId}`);
    await del(`tiktok:feed:subscriptions:${userId}`);
}

// ============================================
// ПОЛУЧЕНИЕ ЛЕНТЫ "ДЛЯ ВАС"
// ============================================

async function getForYouFeed(req, res) {
    const { limit = 10, cursor } = req.query;
    const userId = req.user?.id;

    try {
        const cacheKey = `tiktok:feed:for_you:${userId || 'anonymous'}`;
        
        if (!cursor) {
            const cached = await get(cacheKey);
            if (cached) {
                return res.json({ success: true, ...cached, fromCache: true });
            }
        }
        
        let feed = [];
        
        // 1. Получаем популярные объявления (50%)
        const trending = await getTrendingListings(100);
        const trendingCount = Math.floor(parseInt(limit) * FEED_CONFIG.distribution.trending);
        feed.push(...trending.slice(0, trendingCount));
        
        // 2. Получаем объявления из категорий пользователя (30%)
        if (userId) {
            const userCategories = await getUserCategoryPreferences(userId);
            if (userCategories.length > 0) {
                const categoriesCount = Math.floor(parseInt(limit) * FEED_CONFIG.distribution.categories);
                const categoryListings = await Listing.search({
                    categoryId: userCategories,
                    limit: categoriesCount * 2
                });
                feed.push(...categoryListings.listings);
            }
        }
        
        // 3. Добавляем новые объявления (15%)
        const newCount = Math.floor(parseInt(limit) * FEED_CONFIG.distribution.new);
        const newListings = await Listing.search({
            limit: newCount * 2,
            sort: 'created_desc'
        });
        feed.push(...newListings.listings);
        
        // 4. Добавляем объявления из подписок (5%)
        if (userId) {
            const subscriptions = await getUserSubscriptions(userId);
            if (subscriptions.length > 0) {
                const subsCount = Math.floor(parseInt(limit) * FEED_CONFIG.distribution.subscriptions);
                const subsListings = await Listing.search({
                    sellerIds: subscriptions,
                    limit: subsCount * 2
                });
                feed.push(...subsListings.listings);
            }
        }
        
        // Убираем дубликаты
        const uniqueFeed = [];
        const seenIds = new Set();
        for (const item of feed) {
            if (!seenIds.has(item.id)) {
                seenIds.add(item.id);
                uniqueFeed.push(item);
            }
        }
        
        // Перемешиваем
        for (let i = uniqueFeed.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [uniqueFeed[i], uniqueFeed[j]] = [uniqueFeed[j], uniqueFeed[i]];
        }
        
        // Пагинация
        const startIndex = cursor ? parseInt(cursor) : 0;
        const pagedFeed = uniqueFeed.slice(startIndex, startIndex + parseInt(limit) + 1);
        const hasMore = pagedFeed.length > parseInt(limit);
        const listings = hasMore ? pagedFeed.slice(0, -1) : pagedFeed;
        const nextCursor = hasMore ? startIndex + parseInt(limit) : null;
        
        // Добавляем информацию для авторизованных пользователей
        if (userId && listings.length > 0) {
            for (const listing of listings) {
                listing.isLiked = await Favorite.isFavorite(userId, listing.id);
                listing.isSubscribed = await sismember(`user:subscriptions_set:${userId}`, listing.user_id);
            }
        }
        
        const response = { listings, nextCursor, hasMore };
        
        if (!cursor) {
            await set(cacheKey, response, CACHE_TTL.feed);
        }
        
        res.json({ success: true, ...response });
    } catch (error) {
        console.error('Ошибка получения ленты "Для вас":', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ ЛЕНТЫ ПОДПИСОК
// ============================================

async function getSubscriptionsFeed(req, res) {
    const { limit = 10, cursor } = req.query;
    const userId = req.user?.id;

    if (!userId) {
        return res.status(401).json({ error: 'Авторизация обязательна для просмотра ленты подписок' });
    }

    try {
        const cacheKey = `tiktok:feed:subscriptions:${userId}`;
        
        if (!cursor) {
            const cached = await get(cacheKey);
            if (cached) {
                return res.json({ success: true, ...cached, fromCache: true });
            }
        }
        
        const subscriptions = await getUserSubscriptions(userId);
        
        if (subscriptions.length === 0) {
            return res.json({
                success: true,
                listings: [],
                nextCursor: null,
                hasMore: false,
                message: 'Вы ещё не подписаны ни на одного продавца'
            });
        }
        
        const { listings, nextCursor, hasMore } = await Listing.search({
            sellerIds: subscriptions,
            limit: parseInt(limit),
            cursor,
            sort: 'created_desc'
        });
        
        // Добавляем информацию о лайках и подписках
        for (const listing of listings) {
            listing.isLiked = await Favorite.isFavorite(userId, listing.id);
            listing.isSubscribed = true;
        }
        
        const response = { listings, nextCursor, hasMore };
        
        if (!cursor) {
            await set(cacheKey, response, CACHE_TTL.feed);
        }
        
        res.json({ success: true, ...response });
    } catch (error) {
        console.error('Ошибка получения ленты подписок:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЛАЙК В TIKTOK-ЛЕНТЕ
// ============================================

async function likeListing(req, res) {
    const { listingId } = req.params;

    try {
        const listing = await Listing.findById(parseInt(listingId));
        if (!listing || listing.status !== 'active') {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }
        
        const isLiked = await Favorite.isFavorite(req.user.id, parseInt(listingId));
        
        if (isLiked) {
            await Favorite.remove(req.user.id, parseInt(listingId));
            await updateEngagementScore(listingId, 'like', -1);
            await incr(`analytics:listing:likes:${listingId}`, -1);
            res.json({ success: true, liked: false, likesCount: listing.likes - 1 });
        } else {
            await Favorite.add(req.user.id, parseInt(listingId));
            await updateEngagementScore(listingId, 'like', 1);
            const newLikes = await Listing.incrementLikes(listingId);
            
            await addJob('notificationQueue', 'newLikeNotification', {
                userId: listing.user_id,
                listingId,
                listingTitle: listing.title,
                likerName: req.user.name
            });
            
            res.json({ success: true, liked: true, likesCount: newLikes });
        }
    } catch (error) {
        console.error('Ошибка лайка в TikTok-ленте:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОДПИСКА НА ПРОДАВЦА
// ============================================

async function subscribeToSeller(req, res) {
    const { sellerId } = req.params;

    if (req.user.id === parseInt(sellerId)) {
        return res.status(400).json({ error: 'Нельзя подписаться на самого себя' });
    }

    try {
        const seller = await User.findById(parseInt(sellerId));
        if (!seller) {
            return res.status(404).json({ error: 'Продавец не найден' });
        }
        
        const isSubscribed = await sismember(`user:subscriptions_set:${req.user.id}`, sellerId);
        
        if (isSubscribed) {
            return res.status(400).json({ error: 'Вы уже подписаны на этого продавца' });
        }
        
        await User.query(
            `INSERT INTO subscriptions (user_id, seller_id, created_at) VALUES ($1, $2, NOW())`,
            [req.user.id, sellerId]
        );
        
        await sadd(`user:subscriptions_set:${req.user.id}`, sellerId);
        await del(`user:subscriptions:${req.user.id}`);
        await clearUserFeedCache(req.user.id);
        
        await zincrby('tiktok:subscribers', 1, sellerId);
        
        await addJob('notificationQueue', 'newSubscriptionNotification', {
            userId: sellerId,
            subscriberName: req.user.name
        });
        
        res.json({ success: true, subscribed: true, message: `Вы подписались на ${seller.name}` });
    } catch (error) {
        console.error('Ошибка подписки:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ОТПИСКА ОТ ПРОДАВЦА
// ============================================

async function unsubscribeFromSeller(req, res) {
    const { sellerId } = req.params;

    try {
        const result = await User.query(
            `DELETE FROM subscriptions WHERE user_id = $1 AND seller_id = $2 RETURNING *`,
            [req.user.id, sellerId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Подписка не найдена' });
        }
        
        await srem(`user:subscriptions_set:${req.user.id}`, sellerId);
        await del(`user:subscriptions:${req.user.id}`);
        await clearUserFeedCache(req.user.id);
        
        await zincrby('tiktok:subscribers', -1, sellerId);
        
        res.json({ success: true, subscribed: false, message: 'Вы отписались от продавца' });
    } catch (error) {
        console.error('Ошибка отписки:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= ПОЛУЧЕНИЕ СПИСКА ПОДПИСОК
// ============================================

async function getSubscriptionsList(req, res) {
    const { limit = 50, offset = 0 } = req.query;

    try {
        const result = await User.query(`
            SELECT s.*, u.name, u.avatar, u.rating, u.city,
                   (SELECT COUNT(*) FROM listings WHERE user_id = s.seller_id AND status = 'active') as active_listings
            FROM subscriptions s
            JOIN users u ON u.id = s.seller_id
            WHERE s.user_id = $1
            ORDER BY s.created_at DESC
            LIMIT $2 OFFSET $3
        `, [req.user.id, parseInt(limit), parseInt(offset)]);
        
        const countResult = await User.query(
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

// ============================================
= ОТСЛЕЖИВАНИЕ ПРОСМОТРА
// ============================================

async function trackView(req, res) {
    const { listingId } = req.params;
    const { duration = 0 } = req.body;

    try {
        await Listing.incrementViews(parseInt(listingId));
        
        if (duration >= 3) {
            await updateEngagementScore(listingId, 'completeView', 1);
        }
        
        if (req.user) {
            await incr(`analytics:user:${req.user.id}:views`, 1);
            await sadd(`user:viewed:${req.user.id}`, listingId);
            
            const listing = await Listing.findById(parseInt(listingId));
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

// ============================================
= ОТСЛЕЖИВАНИЕ ШЕРИНГА
// ============================================

async function trackShare(req, res) {
    const { listingId } = req.params;
    const { platform = 'unknown' } = req.body;

    try {
        await updateEngagementScore(listingId, 'share', 1);
        
        await Listing.query(
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

// ============================================
= ПОЛУЧЕНИЕ ТРЕНДОВЫХ ОБЪЯВЛЕНИЙ (АДМИН)
// ============================================

async function getTrendingListingsAdmin(req, res) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }

    try {
        const trending = await getTrendingListings(100);
        res.json({ success: true, trending });
    } catch (error) {
        console.error('Ошибка получения трендовых объявлений:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ КЕША (АДМИН)
// ============================================

async function refreshFeedCache(req, res) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }

    try {
        await del('tiktok:trending');
        
        const listings = await Listing.query(
            `SELECT id, views, likes FROM listings WHERE status = 'active'`
        );
        
        for (const listing of listings.rows) {
            const score = (listing.views || 0) + (listing.likes || 0) * 10;
            await zadd('tiktok:engagement', score, listing.id);
        }
        
        res.json({ success: true, message: 'Кеш TikTok-ленты обновлён' });
    } catch (error) {
        console.error('Ошибка обновления кеша:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= СТАТИСТИКА ВОВЛЕЧЁННОСТИ
// ============================================

async function getEngagementStats(req, res) {
    const { listingId } = req.params;

    try {
        const listing = await Listing.findById(parseInt(listingId));
        if (!listing) {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }
        
        const engagementScore = await get(`tiktok:engagement:${listingId}`) || 0;
        const views = listing.views || 0;
        const likes = listing.likes || 0;
        
        const engagementRate = views > 0 ? ((likes / views) * 100).toFixed(1) : 0;
        
        res.json({
            success: true,
            stats: {
                views,
                likes,
                engagementScore: parseInt(engagementScore),
                engagementRate: parseFloat(engagementRate)
            }
        });
    } catch (error) {
        console.error('Ошибка получения статистики вовлечённости:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    getForYouFeed,
    getSubscriptionsFeed,
    likeListing,
    subscribeToSeller,
    unsubscribeFromSeller,
    getSubscriptionsList,
    trackView,
    trackShare,
    getTrendingListingsAdmin,
    refreshFeedCache,
    getEngagementStats,
    updateEngagementScore,
    getUserCategoryPreferences,
    getUserSubscriptions
};