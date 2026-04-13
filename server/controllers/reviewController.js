/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/controllers/reviewController.js
 * Описание: Контроллер отзывов (создание, редактирование, удаление, ответы, рейтинги)
 */

const { Review, User, Listing, Chat } = require('../models');
const { get, set, del } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { sendNotification } = require('../services/notificationService');
const { config } = require('../../config/env');

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

const CACHE_TTL = {
    userReviews: 300,      // 5 минут
    userRating: 3600,      // 1 час
    listingReviews: 300    // 5 минут
};

async function clearUserRatingCache(userId) {
    await del(`user:rating:${userId}`);
    await del(`user:reviews:${userId}`);
    await del(`user:reviews:${userId}:stats`);
}

async function updateUserRating(userId) {
    const result = await Review.query(
        `SELECT AVG(rating)::numeric(10,1) as avg, COUNT(*) as count
         FROM reviews WHERE to_user_id = $1`,
        [userId]
    );
    
    const avgRating = result.rows[0].avg || 0;
    const reviewsCount = parseInt(result.rows[0].count);
    
    await User.update(userId, { rating: avgRating });
    await set(`user:rating:${userId}`, { rating: avgRating, count: reviewsCount }, CACHE_TTL.userRating);
    
    return { rating: avgRating, count: reviewsCount };
}

// ============================================
// ПОЛУЧЕНИЕ ОТЗЫВОВ О ПОЛЬЗОВАТЕЛЕ
// ============================================

async function getUserReviews(req, res) {
    const { userId } = req.params;
    const { page = 1, limit = 20, rating, sort = 'newest' } = req.query;
    
    try {
        const cacheKey = `user:reviews:${userId}:${page}:${limit}:${rating}:${sort}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }
        
        const user = await User.findById(parseInt(userId));
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        let sql = `
            SELECT r.*, 
                   u.name as from_user_name, u.avatar as from_user_avatar,
                   l.title as listing_title, l.id as listing_id
            FROM reviews r
            JOIN users u ON u.id = r.from_user_id
            JOIN listings l ON l.id = r.listing_id
            WHERE r.to_user_id = $1
        `;
        const params = [parseInt(userId)];
        let idx = 2;
        
        if (rating) {
            sql += ` AND r.rating = $${idx}`;
            params.push(parseInt(rating));
            idx++;
        }
        
        switch (sort) {
            case 'oldest':
                sql += ` ORDER BY r.created_at ASC`;
                break;
            case 'highest':
                sql += ` ORDER BY r.rating DESC, r.created_at DESC`;
                break;
            case 'lowest':
                sql += ` ORDER BY r.rating ASC, r.created_at DESC`;
                break;
            default:
                sql += ` ORDER BY r.created_at DESC`;
        }
        
        const countSql = sql.replace(/SELECT.*FROM/, 'SELECT COUNT(*) FROM');
        const countResult = await Review.query(countSql, params);
        const total = parseInt(countResult.rows[0].count);
        
        const offset = (parseInt(page) - 1) * parseInt(limit);
        sql += ` LIMIT $${idx} OFFSET $${idx + 1}`;
        params.push(parseInt(limit), offset);
        
        const result = await Review.query(sql, params);
        
        // Получаем статистику рейтинга
        const ratingStats = await Review.query(
            `SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) as five_star,
                SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) as four_star,
                SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) as three_star,
                SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) as two_star,
                SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as one_star
             FROM reviews WHERE to_user_id = $1`,
            [parseInt(userId)]
        );
        
        const response = {
            reviews: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / parseInt(limit))
            },
            stats: {
                average_rating: await get(`user:rating:${userId}`) || { rating: 0, count: 0 },
                distribution: ratingStats.rows[0]
            }
        };
        
        await set(cacheKey, response, CACHE_TTL.userReviews);
        res.json({ success: true, ...response });
    } catch (error) {
        console.error('Ошибка получения отзывов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ ОТЗЫВОВ ОБ ОБЪЯВЛЕНИИ
// ============================================

async function getListingReviews(req, res) {
    const { listingId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    
    try {
        const cacheKey = `listing:reviews:${listingId}:${page}:${limit}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }
        
        const listing = await Listing.findById(parseInt(listingId));
        if (!listing) {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }
        
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        const result = await Review.query(`
            SELECT r.*, u.name as from_user_name, u.avatar as from_user_avatar
            FROM reviews r
            JOIN users u ON u.id = r.from_user_id
            WHERE r.listing_id = $1
            ORDER BY r.created_at DESC
            LIMIT $2 OFFSET $3
        `, [parseInt(listingId), parseInt(limit), offset]);
        
        const countResult = await Review.query(
            `SELECT COUNT(*) FROM reviews WHERE listing_id = $1`,
            [parseInt(listingId)]
        );
        const total = parseInt(countResult.rows[0].count);
        
        const response = {
            reviews: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / parseInt(limit))
            }
        };
        
        await set(cacheKey, response, CACHE_TTL.listingReviews);
        res.json({ success: true, ...response });
    } catch (error) {
        console.error('Ошибка получения отзывов об объявлении:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// СОЗДАНИЕ ОТЗЫВА
// ============================================

async function createReview(req, res) {
    const { to_user_id, listing_id, rating, text } = req.body;
    
    if (req.user.id === parseInt(to_user_id)) {
        return res.status(400).json({ error: 'Нельзя оставить отзыв самому себе' });
    }
    
    try {
        const listing = await Listing.findById(listing_id);
        if (!listing) {
            return res.status(404).json({ error: 'Объявление не найдено' });
        }
        
        // Проверяем, что пользователь является участником сделки
        const chat = await Chat.query(
            `SELECT * FROM chats WHERE listing_id = $1 AND ((buyer_id = $2 AND seller_id = $3) OR (buyer_id = $3 AND seller_id = $2))`,
            [listing_id, req.user.id, to_user_id]
        );
        
        if (chat.rows.length === 0 && listing.status !== 'sold') {
            return res.status(403).json({ error: 'Вы можете оставить отзыв только после завершения сделки' });
        }
        
        // Проверяем, не оставлял ли уже отзыв
        const existing = await Review.query(
            `SELECT id FROM reviews WHERE from_user_id = $1 AND listing_id = $2`,
            [req.user.id, listing_id]
        );
        
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Вы уже оставляли отзыв на это объявление' });
        }
        
        const review = await Review.create(
            req.user.id,
            parseInt(to_user_id),
            parseInt(listing_id),
            parseInt(rating),
            text
        );
        
        // Начисляем бонус за отзыв
        await User.addBonus(req.user.id, 5, 'review', review.id);
        
        // Обновляем рейтинг пользователя
        await updateUserRating(parseInt(to_user_id));
        await clearUserRatingCache(parseInt(to_user_id));
        
        // Уведомляем пользователя
        await sendNotification(parseInt(to_user_id), 'review', {
            title: 'Новый отзыв',
            message: `${req.user.name} оставил(а) отзыв с оценкой ${rating}⭐`,
            reviewerName: req.user.name,
            rating,
            listingTitle: listing.title,
            listingId: listing_id,
            reviewId: review.id,
            link: `/profile.html?tab=reviews`
        });
        
        res.status(201).json({
            success: true,
            review,
            message: 'Отзыв успешно опубликован. +5 бонусов!'
        });
    } catch (error) {
        console.error('Ошибка создания отзыва:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ОБНОВЛЕНИЕ ОТЗЫВА
// ============================================

async function updateReview(req, res) {
    const { id } = req.params;
    const { rating, text } = req.body;
    
    try {
        const review = await Review.query(`SELECT * FROM reviews WHERE id = $1`, [id]);
        if (review.rows.length === 0) {
            return res.status(404).json({ error: 'Отзыв не найден' });
        }
        
        const reviewData = review.rows[0];
        
        if (reviewData.from_user_id !== req.user.id) {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }
        
        const updates = [];
        const params = [];
        let idx = 1;
        
        if (rating) {
            updates.push(`rating = $${idx}`);
            params.push(rating);
            idx++;
        }
        if (text) {
            updates.push(`text = $${idx}`);
            params.push(text);
            idx++;
        }
        
        updates.push(`updated_at = NOW()`);
        params.push(id);
        
        const result = await Review.query(
            `UPDATE reviews SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
            params
        );
        
        // Обновляем рейтинг пользователя
        await updateUserRating(reviewData.to_user_id);
        await clearUserRatingCache(reviewData.to_user_id);
        
        res.json({
            success: true,
            review: result.rows[0],
            message: 'Отзыв обновлён'
        });
    } catch (error) {
        console.error('Ошибка обновления отзыва:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= ОТВЕТ НА ОТЗЫВ
// ============================================

async function replyToReview(req, res) {
    const { id } = req.params;
    const { reply } = req.body;
    
    try {
        const review = await Review.query(`SELECT * FROM reviews WHERE id = $1`, [id]);
        if (review.rows.length === 0) {
            return res.status(404).json({ error: 'Отзыв не найден' });
        }
        
        const reviewData = review.rows[0];
        
        if (reviewData.to_user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }
        
        const result = await Review.query(
            `UPDATE reviews SET reply = $1, reply_created_at = NOW() WHERE id = $2 RETURNING *`,
            [reply, id]
        );
        
        // Уведомляем автора отзыва
        await sendNotification(reviewData.from_user_id, 'review', {
            title: 'Ответ на отзыв',
            message: `${req.user.name} ответил(а) на ваш отзыв`,
            reviewId: id,
            link: `/profile.html?tab=reviews`
        });
        
        res.json({
            success: true,
            review: result.rows[0],
            message: 'Ответ добавлен'
        });
    } catch (error) {
        console.error('Ошибка добавления ответа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= УДАЛЕНИЕ ОТЗЫВА
// ============================================

async function deleteReview(req, res) {
    const { id } = req.params;
    
    try {
        const review = await Review.query(`SELECT * FROM reviews WHERE id = $1`, [id]);
        if (review.rows.length === 0) {
            return res.status(404).json({ error: 'Отзыв не найден' });
        }
        
        const reviewData = review.rows[0];
        
        if (reviewData.from_user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }
        
        await Review.query(`DELETE FROM reviews WHERE id = $1`, [id]);
        
        // Обновляем рейтинг пользователя
        await updateUserRating(reviewData.to_user_id);
        await clearUserRatingCache(reviewData.to_user_id);
        
        res.json({
            success: true,
            message: 'Отзыв удалён'
        });
    } catch (error) {
        console.error('Ошибка удаления отзыва:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= ПРОВЕРКА, ОСТАВЛЯЛ ЛИ ПОЛЬЗОВАТЕЛЬ ОТЗЫВ
// ============================================

async function checkUserReview(req, res) {
    const { listingId } = req.params;
    
    try {
        const result = await Review.query(
            `SELECT id, rating, text FROM reviews WHERE from_user_id = $1 AND listing_id = $2`,
            [req.user.id, listingId]
        );
        
        res.json({
            success: true,
            hasReview: result.rows.length > 0,
            review: result.rows[0] || null
        });
    } catch (error) {
        console.error('Ошибка проверки отзыва:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= СТАТИСТИКА ОТЗЫВОВ ПОЛЬЗОВАТЕЛЯ
// ============================================

async function getReviewStatistics(req, res) {
    const { userId } = req.params;
    
    try {
        const cacheKey = `user:reviews:${userId}:stats`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }
        
        const stats = await Review.query(`
            SELECT 
                COUNT(*) as total_reviews,
                AVG(rating)::numeric(10,1) as average_rating,
                SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) as five_star,
                SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) as four_star,
                SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) as three_star,
                SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) as two_star,
                SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as one_star,
                COUNT(CASE WHEN reply IS NOT NULL THEN 1 END) as replied_count,
                MAX(rating) as max_rating,
                MIN(rating) as min_rating
            FROM reviews
            WHERE to_user_id = $1
        `, [parseInt(userId)]);
        
        // Отзывы по месяцам
        const monthlyStats = await Review.query(`
            SELECT 
                DATE_TRUNC('month', created_at) as month,
                COUNT(*) as count,
                AVG(rating)::numeric(10,1) as avg_rating
            FROM reviews
            WHERE to_user_id = $1 AND created_at > NOW() - INTERVAL '12 months'
            GROUP BY DATE_TRUNC('month', created_at)
            ORDER BY month DESC
        `, [parseInt(userId)]);
        
        const response = {
            stats: stats.rows[0],
            monthly: monthlyStats.rows
        };
        
        await set(cacheKey, response, CACHE_TTL.userRating);
        res.json({ success: true, ...response });
    } catch (error) {
        console.error('Ошибка получения статистики отзывов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= ЖАЛОБА НА ОТЗЫВ
// ============================================

async function reportReview(req, res) {
    const { id } = req.params;
    const { reason, description } = req.body;
    
    try {
        const review = await Review.query(`SELECT * FROM reviews WHERE id = $1`, [id]);
        if (review.rows.length === 0) {
            return res.status(404).json({ error: 'Отзыв не найден' });
        }
        
        const reviewData = review.rows[0];
        
        await Review.query(
            `INSERT INTO complaints (user_id, complained_user_id, review_id, reason, description, status, created_at)
             VALUES ($1, $2, $3, $4, $5, 'pending', NOW())`,
            [req.user.id, reviewData.from_user_id, id, reason, description || null]
        );
        
        await addJob('notificationQueue', 'notifyModerators', {
            type: 'review_complaint',
            reviewId: id,
            reason
        });
        
        res.json({ success: true, message: 'Жалоба отправлена' });
    } catch (error) {
        console.error('Ошибка отправки жалобы:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= АДМИН-ФУНКЦИИ
// ============================================

async function getPendingReviews(req, res) {
    const { limit = 20, offset = 0 } = req.query;
    
    try {
        const result = await Review.query(`
            SELECT r.*, u.name as user_name, u.email as user_email,
                   t.name as target_name, t.email as target_email,
                   l.title as listing_title
            FROM reviews r
            JOIN users u ON u.id = r.from_user_id
            JOIN users t ON t.id = r.to_user_id
            LEFT JOIN listings l ON l.id = r.listing_id
            WHERE r.status = 'pending'
            ORDER BY r.created_at ASC
            LIMIT $1 OFFSET $2
        `, [parseInt(limit), parseInt(offset)]);
        
        const countResult = await Review.query(
            `SELECT COUNT(*) FROM reviews WHERE status = 'pending'`
        );
        
        res.json({
            success: true,
            reviews: result.rows,
            total: parseInt(countResult.rows[0].count)
        });
    } catch (error) {
        console.error('Ошибка получения отзывов на модерацию:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function moderateReview(req, res) {
    const { id } = req.params;
    const { action, reason } = req.body;
    
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Неверное действие' });
    }
    
    try {
        const review = await Review.query(`SELECT * FROM reviews WHERE id = $1`, [id]);
        if (review.rows.length === 0) {
            return res.status(404).json({ error: 'Отзыв не найден' });
        }
        
        const reviewData = review.rows[0];
        const newStatus = action === 'approve' ? 'approved' : 'rejected';
        
        await Review.query(
            `UPDATE reviews SET status = $1, moderated_by = $2, moderated_at = NOW(), moderation_reason = $3
             WHERE id = $4`,
            [newStatus, req.user.id, reason || null, id]
        );
        
        if (action === 'reject') {
            await Review.query(`DELETE FROM reviews WHERE id = $1`, [id]);
            await updateUserRating(reviewData.to_user_id);
        }
        
        // Уведомляем автора
        await sendNotification(reviewData.from_user_id, 'system', {
            title: action === 'approve' ? 'Отзыв одобрен' : 'Отзыв отклонён',
            message: action === 'approve' 
                ? 'Ваш отзыв прошёл модерацию и опубликован'
                : `Ваш отзыв отклонён. Причина: ${reason || 'Нарушение правил'}`,
            reviewId: id
        });
        
        res.json({ success: true, message: `Отзыв ${action === 'approve' ? 'одобрен' : 'отклонён'}` });
    } catch (error) {
        console.error('Ошибка модерации отзыва:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    getUserReviews,
    getListingReviews,
    createReview,
    updateReview,
    replyToReview,
    deleteReview,
    checkUserReview,
    getReviewStatistics,
    reportReview,
    getPendingReviews,
    moderateReview
};