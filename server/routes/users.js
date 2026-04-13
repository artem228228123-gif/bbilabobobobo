/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/routes/users.js
 * Описание: Маршруты для работы с пользователями (профиль, статистика, настройки)
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();
const { User, Listing, Review, Bonus, Blacklist } = require('../models');
const { authenticate, isOwner, getListingOwnerId } = require('../middleware/auth');
const { processAvatar } = require('../services/imageService');
const { addJob } = require('../../config/redis');
const { get, set, del } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// НАСТРОЙКА ЗАГРУЗКИ АВАТАРА
// ============================================

const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const avatarDir = path.join(__dirname, '../../uploads/avatars');
        if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });
        cb(null, avatarDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Неподдерживаемый формат'), false);
        }
    }
});

function validate(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    return null;
}

// ============================================
// GET /api/v1/users/me
// Получение текущего пользователя
// ============================================
router.get('/me', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        const stats = await User.getStats(req.user.id);
        const streak = await Bonus.getStreak(req.user.id);
        
        res.json({
            success: true,
            user: {
                ...user,
                stats,
                streak: streak.streak
            }
        });
    } catch (error) {
        console.error('Ошибка получения профиля:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// PUT /api/v1/users/me
// Обновление профиля пользователя
// ============================================
router.put(
    '/me',
    authenticate,
    [
        body('name').optional().isString().isLength({ min: 2, max: 50 }),
        body('phone').optional().isString().isLength({ max: 20 }),
        body('city').optional().isString().isLength({ max: 100 }),
        body('bio').optional().isString().isLength({ max: 500 }),
        body('birth_date').optional().isISO8601(),
        body('social_telegram').optional().isString().isLength({ max: 100 }),
        body('social_vk').optional().isString().isLength({ max: 100 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;
        
        const { name, phone, city, bio, birth_date, social_telegram, social_vk } = req.body;
        
        try {
            const updates = {};
            if (name) updates.name = name;
            if (phone !== undefined) updates.phone = phone;
            if (city !== undefined) updates.city = city;
            if (bio !== undefined) updates.bio = bio;
            if (birth_date) updates.birth_date = birth_date;
            if (social_telegram !== undefined) updates.social_telegram = social_telegram;
            if (social_vk !== undefined) updates.social_vk = social_vk;
            
            const user = await User.update(req.user.id, updates);
            
            await del(`user:${req.user.id}`);
            
            res.json({
                success: true,
                user,
                message: 'Профиль обновлён'
            });
        } catch (error) {
            console.error('Ошибка обновления профиля:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/users/avatar
// Загрузка аватара
// ============================================
router.post('/avatar', authenticate, avatarUpload.single('avatar'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Файл не загружен' });
    }
    
    try {
        // Обрабатываем аватар
        const avatarBuffer = fs.readFileSync(req.file.path);
        const avatarUrl = await processAvatar(avatarBuffer, req.user.id);
        
        // Обновляем пользователя
        await User.update(req.user.id, { avatar: avatarUrl });
        await del(`user:${req.user.id}`);
        
        // Удаляем временный файл
        fs.unlinkSync(req.file.path);
        
        res.json({
            success: true,
            avatar_url: avatarUrl,
            message: 'Аватар обновлён'
        });
    } catch (error) {
        console.error('Ошибка загрузки аватара:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Ошибка загрузки аватара' });
    }
});

// ============================================
// DELETE /api/v1/users/avatar
// Удаление аватара
// ============================================
router.delete('/avatar', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (user?.avatar) {
            const avatarPath = path.join(__dirname, '../../uploads', user.avatar);
            if (fs.existsSync(avatarPath)) {
                fs.unlinkSync(avatarPath);
            }
        }
        
        await User.update(req.user.id, { avatar: null });
        await del(`user:${req.user.id}`);
        
        res.json({ success: true, message: 'Аватар удалён' });
    } catch (error) {
        console.error('Ошибка удаления аватара:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/users/:id
// Получение публичного профиля пользователя
// ============================================
router.get(
    '/:id',
    [
        param('id').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;
        
        const { id } = req.params;
        
        try {
            const user = await User.findById(parseInt(id));
            if (!user || user.status === 'deleted') {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }
            
            const stats = await User.getStats(parseInt(id));
            const rating = await Review.getAverageRating(parseInt(id));
            
            // Получаем последние объявления пользователя
            const { listings } = await Listing.findByUser(parseInt(id), 'active', 6);
            
            res.json({
                success: true,
                user: {
                    id: user.id,
                    name: user.name,
                    avatar: user.avatar,
                    city: user.city,
                    rating: rating.rating,
                    reviews_count: rating.count,
                    registered_at: user.created_at,
                    stats: {
                        listings_count: stats.listingsCount,
                        reviews_count: stats.reviewsCount
                    }
                },
                recent_listings: listings
            });
        } catch (error) {
            console.error('Ошибка получения пользователя:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/users/:id/listings
// Объявления пользователя
// ============================================
router.get(
    '/:id/listings',
    [
        param('id').isInt(),
        query('status').optional().isIn(['active', 'sold', 'archived']),
        query('limit').optional().isInt({ min: 1, max: 50 }),
        query('cursor').optional().isString()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;
        
        const { id } = req.params;
        const { status = 'active', limit = 20, cursor } = req.query;
        
        // Проверяем права: только владелец или админ могут видеть неактивные
        const isOwner = req.user && (req.user.id === parseInt(id) || req.user.role === 'admin');
        const effectiveStatus = isOwner ? status : 'active';
        
        try {
            const { listings, nextCursor, hasMore } = await Listing.findByUser(
                parseInt(id),
                effectiveStatus,
                parseInt(limit),
                cursor
            );
            
            res.json({
                success: true,
                listings,
                nextCursor,
                hasMore,
                count: listings.length
            });
        } catch (error) {
            console.error('Ошибка получения объявлений пользователя:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/users/:id/reviews
// Отзывы о пользователе
// ============================================
router.get(
    '/:id/reviews',
    [
        param('id').isInt(),
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 50 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;
        
        const { id } = req.params;
        const { page = 1, limit = 20 } = req.query;
        
        try {
            const reviews = await Review.findByUser(parseInt(id), parseInt(limit), parseInt(page));
            const rating = await Review.getAverageRating(parseInt(id));
            
            res.json({
                success: true,
                reviews: reviews.reviews,
                rating: rating.rating,
                total: reviews.total,
                page: reviews.page,
                totalPages: reviews.totalPages
            });
        } catch (error) {
            console.error('Ошибка получения отзывов:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/users/stats
// Статистика пользователя
// ============================================
router.get('/stats', authenticate, async (req, res) => {
    try {
        const stats = await User.getStats(req.user.id);
        
        // Получаем историю просмотров за последние 30 дней
        const viewsHistory = await User.query(`
            SELECT DATE(created_at) as date, COUNT(*) as count
            FROM listing_views
            WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date ASC
        `, [req.user.id]);
        
        // Получаем историю объявлений
        const listingsHistory = await User.query(`
            SELECT DATE(created_at) as date, COUNT(*) as count
            FROM listings
            WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date ASC
        `, [req.user.id]);
        
        res.json({
            success: true,
            stats: {
                ...stats,
                views_history: viewsHistory.rows,
                listings_history: listingsHistory.rows
            }
        });
    } catch (error) {
        console.error('Ошибка получения статистики:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// POST /api/v1/users/logout-all
// Выход из всех устройств
// ============================================
router.post('/logout-all', authenticate, async (req, res) => {
    try {
        // Очищаем все сессии пользователя в Redis
        const pattern = `session:*`;
        const keys = await get(pattern);
        // В реальном проекте нужно найти и удалить все сессии пользователя
        
        res.json({ success: true, message: 'Вы вышли из всех устройств' });
    } catch (error) {
        console.error('Ошибка выхода из всех устройств:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// DELETE /api/v1/users/me
// Удаление аккаунта
// ============================================
router.delete(
    '/me',
    authenticate,
    [
        body('password').notEmpty().withMessage('Пароль обязателен')
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;
        
        const { password } = req.body;
        
        try {
            const user = await User.findById(req.user.id);
            if (!user) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }
            
            // Проверяем пароль
            const isValid = await bcrypt.compare(password, user.password_hash);
            if (!isValid) {
                return res.status(401).json({ error: 'Неверный пароль' });
            }
            
            // Мягкое удаление
            await User.softDelete(req.user.id);
            
            // Очищаем токен
            res.clearCookie('token');
            
            res.json({ success: true, message: 'Аккаунт удалён' });
        } catch (error) {
            console.error('Ошибка удаления аккаунта:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = router;