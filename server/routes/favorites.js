/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/routes/favorites.js
 * Описание: Маршруты для работы с избранным
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');

const router = express.Router();
const { Favorite, Listing, User } = require('../models');
const { authenticate } = require('../middleware/auth');
const { get, set, del, incr } = require('../../config/redis');
const { addJob } = require('../../config/redis');

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function validate(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    return null;
}

async function clearUserFavoritesCache(userId) {
    await del(`favorites:${userId}`);
    await del(`favorites:count:${userId}`);
}

async function updateFavoriteStats(listingId, action) {
    const change = action === 'add' ? 1 : -1;
    await incr(`analytics:favorites:${listingId}`, change);
}

// ============================================
// GET /api/v1/favorites
// Получение списка избранных объявлений
// ============================================
router.get(
    '/',
    authenticate,
    [
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('cursor').optional().isString(),
        query('sort').optional().isIn(['created_desc', 'created_asc', 'price_asc', 'price_desc', 'title_asc']),
        query('category_id').optional().isInt(),
        query('price_min').optional().isInt({ min: 0 }),
        query('price_max').optional().isInt({ min: 0 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { limit = 20, cursor, sort = 'created_desc', category_id, price_min, price_max } = req.query;

        try {
            const cacheKey = `favorites:${req.user.id}:${sort}:${category_id}:${price_min}:${price_max}`;
            const cached = await get(cacheKey);
            if (cached) {
                return res.json({ success: true, ...cached, fromCache: true });
            }

            let sql = `
                SELECT l.*, u.name as seller_name, u.avatar as seller_avatar, u.rating as seller_rating,
                       f.created_at as favorited_at, f.id as favorite_id
                FROM favorites f
                JOIN listings l ON l.id = f.listing_id
                JOIN users u ON u.id = l.user_id
                WHERE f.user_id = $1 AND l.status != 'deleted'
            `;
            const params = [req.user.id];
            let idx = 2;

            if (category_id) {
                sql += ` AND l.category_id = $${idx}`;
                params.push(parseInt(category_id));
                idx++;
            }
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

            switch (sort) {
                case 'created_asc':
                    sql += ` ORDER BY f.created_at ASC`;
                    break;
                case 'price_asc':
                    sql += ` ORDER BY l.price ASC`;
                    break;
                case 'price_desc':
                    sql += ` ORDER BY l.price DESC`;
                    break;
                case 'title_asc':
                    sql += ` ORDER BY l.title ASC`;
                    break;
                default:
                    sql += ` ORDER BY f.created_at DESC`;
            }

            if (cursor) {
                sql += ` AND f.id < $${idx}`;
                params.push(parseInt(cursor));
                idx++;
            }

            const countSql = sql.replace(/SELECT.*FROM/, 'SELECT COUNT(*) FROM');
            const countResult = await Favorite.query(countSql, params.slice(0, -1));
            const total = parseInt(countResult.rows[0].count);

            sql += ` LIMIT $${idx}`;
            params.push(parseInt(limit) + 1);

            const result = await Favorite.query(sql, params);
            const hasMore = result.rows.length > parseInt(limit);
            const favorites = hasMore ? result.rows.slice(0, -1) : result.rows;
            const nextCursor = hasMore ? favorites[favorites.length - 1]?.favorite_id : null;

            const response = {
                favorites,
                nextCursor,
                hasMore,
                total,
                count: favorites.length
            };

            await set(cacheKey, response, 300);
            res.json({ success: true, ...response });
        } catch (error) {
            console.error('Ошибка получения избранного:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/favorites/:id
// Добавление в избранное
// ============================================
router.post(
    '/:id',
    authenticate,
    [
        param('id').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;

        try {
            const listing = await Listing.findById(parseInt(id));
            if (!listing || listing.status === 'deleted') {
                return res.status(404).json({ error: 'Объявление не найдено' });
            }

            const isFavorite = await Favorite.isFavorite(req.user.id, parseInt(id));
            if (isFavorite) {
                return res.status(400).json({ error: 'Объявление уже в избранном' });
            }

            const favorite = await Favorite.add(req.user.id, parseInt(id));
            
            await incr(`analytics:listing:favorites:${id}`, 1);
            await updateFavoriteStats(id, 'add');
            await clearUserFavoritesCache(req.user.id);
            
            if (listing.user_id !== req.user.id) {
                await addJob('notificationQueue', 'newFavoriteNotification', {
                    userId: listing.user_id,
                    listingId: id,
                    listingTitle: listing.title,
                    favoriterName: req.user.name
                });
            }

            const totalCount = await Favorite.count(parseInt(id));

            res.status(201).json({
                success: true,
                favorite,
                likes_count: totalCount,
                message: 'Объявление добавлено в избранное'
            });
        } catch (error) {
            console.error('Ошибка добавления в избранное:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// DELETE /api/v1/favorites/:id
// Удаление из избранного
// ============================================
router.delete(
    '/:id',
    authenticate,
    [
        param('id').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;

        try {
            const isFavorite = await Favorite.isFavorite(req.user.id, parseInt(id));
            if (!isFavorite) {
                return res.status(400).json({ error: 'Объявление не в избранном' });
            }

            const favorite = await Favorite.remove(req.user.id, parseInt(id));
            
            await incr(`analytics:listing:favorites:${id}`, -1);
            await updateFavoriteStats(id, 'remove');
            await clearUserFavoritesCache(req.user.id);

            const totalCount = await Favorite.count(parseInt(id));

            res.json({
                success: true,
                favorite,
                likes_count: totalCount,
                message: 'Объявление удалено из избранного'
            });
        } catch (error) {
            console.error('Ошибка удаления из избранного:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/favorites/check/:id
// Проверка в избранном
// ============================================
router.get(
    '/check/:id',
    authenticate,
    [
        param('id').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;

        try {
            const isFavorite = await Favorite.isFavorite(req.user.id, parseInt(id));
            res.json({ success: true, isFavorite });
        } catch (error) {
            console.error('Ошибка проверки избранного:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/favorites/count
// Количество избранных объявлений
// ============================================
router.get('/count', authenticate, async (req, res) => {
    try {
        const cacheKey = `favorites:count:${req.user.id}`;
        const cached = await get(cacheKey);
        if (cached !== null) {
            return res.json({ success: true, count: cached });
        }

        const result = await Favorite.query(
            `SELECT COUNT(*) FROM favorites WHERE user_id = $1`,
            [req.user.id]
        );
        const count = parseInt(result.rows[0].count);
        
        await set(cacheKey, count, 300);
        res.json({ success: true, count });
    } catch (error) {
        console.error('Ошибка получения количества избранного:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// DELETE /api/v1/favorites/clear
// Очистка всего избранного
// ============================================
router.delete('/clear', authenticate, async (req, res) => {
    try {
        const favorites = await Favorite.query(
            `SELECT listing_id FROM favorites WHERE user_id = $1`,
            [req.user.id]
        );

        await Favorite.query(`DELETE FROM favorites WHERE user_id = $1`, [req.user.id]);

        for (const fav of favorites.rows) {
            await incr(`analytics:listing:favorites:${fav.listing_id}`, -1);
            await updateFavoriteStats(fav.listing_id, 'remove');
        }

        await clearUserFavoritesCache(req.user.id);

        res.json({ success: true, message: 'Избранное очищено' });
    } catch (error) {
        console.error('Ошибка очистки избранного:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/favorites/export
// Экспорт избранного в CSV
// ============================================
router.get('/export', authenticate, async (req, res) => {
    try {
        const favorites = await Favorite.query(`
            SELECT l.id, l.title, l.price, l.city, u.name as seller_name, f.created_at as favorited_at
            FROM favorites f
            JOIN listings l ON l.id = f.listing_id
            JOIN users u ON u.id = l.user_id
            WHERE f.user_id = $1
            ORDER BY f.created_at DESC
        `, [req.user.id]);

        if (favorites.rows.length === 0) {
            return res.status(404).json({ error: 'Нет избранных объявлений' });
        }

        const headers = ['ID', 'Название', 'Цена', 'Город', 'Продавец', 'Дата добавления'];
        const rows = favorites.rows.map(item => [
            item.id,
            `"${item.title.replace(/"/g, '""')}"`,
            item.price,
            item.city || '',
            `"${item.seller_name.replace(/"/g, '""')}"`,
            new Date(item.favorited_at).toLocaleDateString('ru-RU')
        ]);

        const csvContent = [headers, ...rows].map(row => row.join(';')).join('\n');
        const BOM = '\uFEFF';
        
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=favorites.csv');
        res.send(BOM + csvContent);
    } catch (error) {
        console.error('Ошибка экспорта избранного:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// POST /api/v1/favorites/sync
// Синхронизация избранного (для мобильных приложений)
// ============================================
router.post('/sync', authenticate, async (req, res) => {
    const { favorites } = req.body;

    if (!favorites || !Array.isArray(favorites)) {
        return res.status(400).json({ error: 'Неверный формат данных' });
    }

    try {
        const currentFavorites = await Favorite.query(
            `SELECT listing_id FROM favorites WHERE user_id = $1`,
            [req.user.id]
        );
        const currentIds = new Set(currentFavorites.rows.map(f => f.listing_id));
        const newIds = new Set(favorites);

        const toAdd = [...newIds].filter(id => !currentIds.has(parseInt(id)));
        for (const id of toAdd) {
            const listing = await Listing.findById(parseInt(id));
            if (listing && listing.status !== 'deleted') {
                await Favorite.add(req.user.id, parseInt(id));
                await incr(`analytics:listing:favorites:${id}`, 1);
            }
        }

        const toRemove = [...currentIds].filter(id => !newIds.has(id));
        for (const id of toRemove) {
            await Favorite.remove(req.user.id, id);
            await incr(`analytics:listing:favorites:${id}`, -1);
        }

        await clearUserFavoritesCache(req.user.id);

        res.json({
            success: true,
            added: toAdd.length,
            removed: toRemove.length,
            message: 'Избранное синхронизировано'
        });
    } catch (error) {
        console.error('Ошибка синхронизации избранного:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/favorites/stats
// Статистика избранного
// ============================================
router.get('/stats', authenticate, async (req, res) => {
    try {
        const byCategory = await Favorite.query(`
            SELECT c.name, COUNT(*) as count
            FROM favorites f
            JOIN listings l ON l.id = f.listing_id
            JOIN categories c ON c.id = l.category_id
            WHERE f.user_id = $1
            GROUP BY c.id, c.name
            ORDER BY count DESC
            LIMIT 10
        `, [req.user.id]);

        const byMonth = await Favorite.query(`
            SELECT DATE_TRUNC('month', f.created_at) as month, COUNT(*) as count
            FROM favorites f
            WHERE f.user_id = $1
            GROUP BY DATE_TRUNC('month', f.created_at)
            ORDER BY month DESC
            LIMIT 12
        `, [req.user.id]);

        const avgPrice = await Favorite.query(`
            SELECT AVG(l.price) as avg_price, MIN(l.price) as min_price, MAX(l.price) as max_price
            FROM favorites f
            JOIN listings l ON l.id = f.listing_id
            WHERE f.user_id = $1
        `, [req.user.id]);

        res.json({
            success: true,
            stats: {
                by_category: byCategory.rows,
                by_month: byMonth.rows,
                avg_price: Math.round(avgPrice.rows[0].avg_price || 0),
                min_price: avgPrice.rows[0].min_price || 0,
                max_price: avgPrice.rows[0].max_price || 0
            }
        });
    } catch (error) {
        console.error('Ошибка получения статистики избранного:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

module.exports = router;