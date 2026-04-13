/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/routes/reviews.js
 * Описание: Маршруты для работы с отзывами (создание, редактирование, удаление, ответы)
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');

const router = express.Router();
const { Review, User, Listing, Chat } = require('../models');
const { authenticate } = require('../middleware/auth');
const { addJob } = require('../../config/redis');
const { get, set, del } = require('../../config/redis');

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

// ============================================
// GET /api/v1/reviews/user/:userId
// Получение отзывов о пользователе
// ============================================
router.get(
    '/user/:userId',
    [
        param('userId').isInt(),
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 50 }),
        query('rating').optional().isInt({ min: 1, max: 5 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { userId } = req.params;
        const { page = 1, limit = 20, rating } = req.query;

        try {
            // Проверяем существование пользователя
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

            const countSql = sql.replace(/SELECT.*FROM/, 'SELECT COUNT(*) FROM');
            const countResult = await Review.query(countSql, params);
            const total = parseInt(countResult.rows[0].count);

            sql += ` ORDER BY r.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
            params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

            const result = await Review.query(sql, params);

            // Получаем средний рейтинг
            const ratingResult = await Review.getAverageRating(parseInt(userId));

            res.json({
                success: true,
                reviews: result.rows,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    totalPages: Math.ceil(total / parseInt(limit))
                },
                stats: {
                    average_rating: ratingResult.rating,
                    total_reviews: ratingResult.count
                }
            });
        } catch (error) {
            console.error('Ошибка получения отзывов:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/reviews/listing/:listingId
// Получение отзывов об объявлении
// ============================================
router.get(
    '/listing/:listingId',
    [
        param('listingId').isInt(),
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 50 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { listingId } = req.params;
        const { page = 1, limit = 20 } = req.query;

        try {
            const listing = await Listing.findById(parseInt(listingId));
            if (!listing) {
                return res.status(404).json({ error: 'Объявление не найдено' });
            }

            const offset = (parseInt(page) - 1) * parseInt(limit);

            const result = await Review.query(
                `SELECT r.*, u.name as from_user_name, u.avatar as from_user_avatar
                 FROM reviews r
                 JOIN users u ON u.id = r.from_user_id
                 WHERE r.listing_id = $1
                 ORDER BY r.created_at DESC
                 LIMIT $2 OFFSET $3`,
                [parseInt(listingId), parseInt(limit), offset]
            );

            const countResult = await Review.query(
                `SELECT COUNT(*) FROM reviews WHERE listing_id = $1`,
                [parseInt(listingId)]
            );
            const total = parseInt(countResult.rows[0].count);

            res.json({
                success: true,
                reviews: result.rows,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    totalPages: Math.ceil(total / parseInt(limit))
                }
            });
        } catch (error) {
            console.error('Ошибка получения отзывов об объявлении:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/reviews
// Создание отзыва
// ============================================
router.post(
    '/',
    authenticate,
    [
        body('to_user_id').isInt().withMessage('ID пользователя обязателен'),
        body('listing_id').isInt().withMessage('ID объявления обязателен'),
        body('rating').isInt({ min: 1, max: 5 }).withMessage('Оценка от 1 до 5'),
        body('text').isString().isLength({ min: 10, max: 1000 }).withMessage('Текст отзыва от 10 до 1000 символов')
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { to_user_id, listing_id, rating, text } = req.body;

        // Нельзя оставить отзыв самому себе
        if (req.user.id === parseInt(to_user_id)) {
            return res.status(400).json({ error: 'Нельзя оставить отзыв самому себе' });
        }

        try {
            // Проверяем существование объявления
            const listing = await Listing.findById(listing_id);
            if (!listing) {
                return res.status(404).json({ error: 'Объявление не найдено' });
            }

            // Проверяем, что пользователь является участником сделки
            // (можно оставить отзыв только если есть чат или объявление продано)
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

            // Создаём отзыв
            const review = await Review.create(
                req.user.id,
                parseInt(to_user_id),
                parseInt(listing_id),
                parseInt(rating),
                text
            );

            // Начисляем бонус за отзыв
            await User.addBonus(req.user.id, 5, 'review', review.id);

            // Уведомляем пользователя
            await addJob('notificationQueue', 'newReviewNotification', {
                userId: to_user_id,
                reviewId: review.id,
                reviewerName: req.user.name,
                rating,
                listingTitle: listing.title
            });

            res.status(201).json({
                success: true,
                review,
                message: 'Отзыв успешно опубликован'
            });
        } catch (error) {
            console.error('Ошибка создания отзыва:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// PUT /api/v1/reviews/:id
// Обновление отзыва (только автор)
// ============================================
router.put(
    '/:id',
    authenticate,
    [
        param('id').isInt(),
        body('rating').optional().isInt({ min: 1, max: 5 }),
        body('text').optional().isString().isLength({ min: 10, max: 1000 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;
        const { rating, text } = req.body;

        try {
            // Получаем отзыв
            const review = await Review.query(
                `SELECT * FROM reviews WHERE id = $1`,
                [id]
            );

            if (review.rows.length === 0) {
                return res.status(404).json({ error: 'Отзыв не найден' });
            }

            const reviewData = review.rows[0];

            // Проверяем права (только автор)
            if (reviewData.from_user_id !== req.user.id) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }

            // Обновляем
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
            const avgRating = await Review.query(
                `SELECT AVG(rating)::numeric(10,1) as avg FROM reviews WHERE to_user_id = $1`,
                [reviewData.to_user_id]
            );
            await User.update(reviewData.to_user_id, { rating: avgRating.rows[0].avg });

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
);

// ============================================
// POST /api/v1/reviews/:id/reply
// Ответ на отзыв (только владелец)
// ============================================
router.post(
    '/:id/reply',
    authenticate,
    [
        param('id').isInt(),
        body('reply').isString().isLength({ min: 2, max: 500 }).withMessage('Ответ от 2 до 500 символов')
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { id } = req.params;
        const { reply } = req.body;

        try {
            // Получаем отзыв
            const review = await Review.query(
                `SELECT * FROM reviews WHERE id = $1`,
                [id]
            );

            if (review.rows.length === 0) {
                return res.status(404).json({ error: 'Отзыв не найден' });
            }

            const reviewData = review.rows[0];

            // Проверяем права (только тот, кому адресован отзыв)
            if (reviewData.to_user_id !== req.user.id) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }

            const result = await Review.query(
                `UPDATE reviews SET reply = $1, reply_created_at = NOW() WHERE id = $2 RETURNING *`,
                [reply, id]
            );

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
);

// ============================================
// DELETE /api/v1/reviews/:id
// Удаление отзыва (только автор или админ)
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
            // Получаем отзыв
            const review = await Review.query(
                `SELECT * FROM reviews WHERE id = $1`,
                [id]
            );

            if (review.rows.length === 0) {
                return res.status(404).json({ error: 'Отзыв не найден' });
            }

            const reviewData = review.rows[0];

            // Проверяем права (автор или админ)
            if (reviewData.from_user_id !== req.user.id && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }

            await Review.query(`DELETE FROM reviews WHERE id = $1`, [id]);

            // Обновляем рейтинг пользователя
            const avgRating = await Review.query(
                `SELECT AVG(rating)::numeric(10,1) as avg FROM reviews WHERE to_user_id = $1`,
                [reviewData.to_user_id]
            );
            await User.update(reviewData.to_user_id, { rating: avgRating.rows[0].avg || 0 });

            res.json({
                success: true,
                message: 'Отзыв удалён'
            });
        } catch (error) {
            console.error('Ошибка удаления отзыва:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/reviews/check/:listingId
// Проверка, оставлял ли пользователь отзыв
// ============================================
router.get(
    '/check/:listingId',
    authenticate,
    [
        param('listingId').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

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
);

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = router;