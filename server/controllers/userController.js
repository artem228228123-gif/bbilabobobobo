/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/controllers/userController.js
 * Описание: Контроллер пользователей (профиль, настройки, статистика, чёрный список)
 */

const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { User, Listing, Review, Bonus, Blacklist } = require('../models');
const { config } = require('../../config/env');
const { get, set, del, flushPattern } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { processAvatar } = require('../services/imageService');

// ============================================
// ПОЛУЧЕНИЕ ПРОФИЛЯ ТЕКУЩЕГО ПОЛЬЗОВАТЕЛЯ
// ============================================

async function getProfile(req, res) {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        const stats = await User.getStats(req.user.id);
        const streak = await Bonus.getStreak(req.user.id);
        const notificationSettings = await get(`notifications:settings:${req.user.id}`) || {
            email: true,
            push: false,
            telegram: false,
            sound: true
        };

        res.json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                city: user.city,
                avatar: user.avatar,
                bio: user.bio,
                birth_date: user.birth_date,
                role: user.role,
                status: user.status,
                bonus_balance: user.bonus_balance,
                referral_code: user.referral_code,
                social_telegram: user.social_telegram,
                social_vk: user.social_vk,
                email_verified: user.email_verified,
                created_at: user.created_at,
                last_seen: user.last_seen,
                stats,
                streak: streak.streak,
                notification_settings: notificationSettings
            }
        });
    } catch (error) {
        console.error('Ошибка получения профиля:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ОБНОВЛЕНИЕ ПРОФИЛЯ
// ============================================

async function updateProfile(req, res) {
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
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                city: user.city,
                avatar: user.avatar,
                bio: user.bio,
                birth_date: user.birth_date,
                social_telegram: user.social_telegram,
                social_vk: user.social_vk
            },
            message: 'Профиль обновлён'
        });
    } catch (error) {
        console.error('Ошибка обновления профиля:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЗАГРУЗКА АВАТАРА
// ============================================

async function uploadAvatar(req, res) {
    if (!req.file) {
        return res.status(400).json({ error: 'Файл не загружен' });
    }

    try {
        const avatarBuffer = fs.readFileSync(req.file.path);
        const avatarUrl = await processAvatar(avatarBuffer, req.user.id);

        const oldUser = await User.findById(req.user.id);
        if (oldUser?.avatar) {
            const oldAvatarPath = path.join(__dirname, '../../uploads', oldUser.avatar);
            if (fs.existsSync(oldAvatarPath)) {
                fs.unlinkSync(oldAvatarPath);
            }
        }

        await User.update(req.user.id, { avatar: avatarUrl });
        await del(`user:${req.user.id}`);

        if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

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
}

// ============================================
// УДАЛЕНИЕ АВАТАРА
// ============================================

async function deleteAvatar(req, res) {
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
}

// ============================================
// ПУБЛИЧНЫЙ ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ
// ============================================

async function getPublicProfile(req, res) {
    const { id } = req.params;

    try {
        const user = await User.findById(parseInt(id));
        if (!user || user.status === 'deleted') {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        const stats = await User.getStats(parseInt(id));
        const rating = await Review.getAverageRating(parseInt(id));
        const { listings } = await Listing.findByUser(parseInt(id), 'active', 6);

        // Проверяем, подписан ли текущий пользователь
        let isSubscribed = false;
        if (req.user) {
            const subResult = await User.query(
                `SELECT 1 FROM subscriptions WHERE user_id = $1 AND seller_id = $2`,
                [req.user.id, parseInt(id)]
            );
            isSubscribed = subResult.rows.length > 0;
        }

        res.json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                avatar: user.avatar,
                city: user.city,
                bio: user.bio,
                rating: rating.rating,
                reviews_count: rating.count,
                registered_at: user.created_at,
                is_subscribed: isSubscribed,
                stats: {
                    listings_count: stats.listingsCount,
                    reviews_count: stats.reviewsCount,
                    sales_count: stats.salesCount || 0
                }
            },
            recent_listings: listings
        });
    } catch (error) {
        console.error('Ошибка получения публичного профиля:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// СТАТИСТИКА ПОЛЬЗОВАТЕЛЯ
// ============================================

async function getUserStats(req, res) {
    try {
        const stats = await User.getStats(req.user.id);

        // История просмотров за 30 дней
        const viewsHistory = await User.query(`
            SELECT DATE(created_at) as date, COUNT(*) as count
            FROM listing_views
            WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date ASC
        `, [req.user.id]);

        // История объявлений за 30 дней
        const listingsHistory = await User.query(`
            SELECT DATE(created_at) as date, COUNT(*) as count
            FROM listings
            WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date ASC
        `, [req.user.id]);

        // История лайков за 30 дней
        const likesHistory = await User.query(`
            SELECT DATE(f.created_at) as date, COUNT(*) as count
            FROM favorites f
            JOIN listings l ON l.id = f.listing_id
            WHERE l.user_id = $1 AND f.created_at > NOW() - INTERVAL '30 days'
            GROUP BY DATE(f.created_at)
            ORDER BY date ASC
        `, [req.user.id]);

        // Топ городов откуда смотрят
        const topCities = await User.query(`
            SELECT city, COUNT(*) as count
            FROM listing_views lv
            JOIN listings l ON l.id = lv.listing_id
            WHERE l.user_id = $1 AND lv.ip_address IS NOT NULL
            GROUP BY city
            ORDER BY count DESC
            LIMIT 5
        `, [req.user.id]);

        res.json({
            success: true,
            stats: {
                ...stats,
                views_history: viewsHistory.rows,
                listings_history: listingsHistory.rows,
                likes_history: likesHistory.rows,
                top_cities: topCities.rows
            }
        });
    } catch (error) {
        console.error('Ошибка получения статистики:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ОБЪЯВЛЕНИЯ ПОЛЬЗОВАТЕЛЯ
// ============================================

async function getUserListings(req, res) {
    const { id } = req.params;
    const { status = 'active', limit = 20, cursor } = req.query;

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

// ============================================
// ОТЗЫВЫ О ПОЛЬЗОВАТЕЛЕ
// ============================================

async function getUserReviews(req, res) {
    const { id } = req.params;
    const { page = 1, limit = 20, rating } = req.query;

    try {
        let sql = `
            SELECT r.*, 
                   u.name as from_user_name, u.avatar as from_user_avatar,
                   l.title as listing_title, l.id as listing_id
            FROM reviews r
            JOIN users u ON u.id = r.from_user_id
            JOIN listings l ON l.id = r.listing_id
            WHERE r.to_user_id = $1
        `;
        const params = [parseInt(id)];
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
        const ratingResult = await Review.getAverageRating(parseInt(id));

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

// ============================================
// ЧЁРНЫЙ СПИСОК
// ============================================

async function getBlacklist(req, res) {
    try {
        const { blocked, total } = await Blacklist.getUserBlacklist(req.user.id, 100, 0);
        res.json({ success: true, blocked, total });
    } catch (error) {
        console.error('Ошибка получения чёрного списка:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function addToBlacklist(req, res) {
    const { blocked_user_id, reason } = req.body;

    if (req.user.id === parseInt(blocked_user_id)) {
        return res.status(400).json({ error: 'Нельзя добавить себя в чёрный список' });
    }

    try {
        const result = await Blacklist.add(req.user.id, parseInt(blocked_user_id), reason || 'Не указана');
        res.json({ success: true, block: result });
    } catch (error) {
        console.error('Ошибка добавления в чёрный список:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function removeFromBlacklist(req, res) {
    const { id } = req.params;

    try {
        const result = await Blacklist.remove(req.user.id, parseInt(id));
        if (!result) {
            return res.status(404).json({ error: 'Запись не найдена' });
        }
        res.json({ success: true, message: 'Пользователь удалён из чёрного списка' });
    } catch (error) {
        console.error('Ошибка удаления из чёрного списка:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ВЫХОД ИЗ ВСЕХ УСТРОЙСТВ
// ============================================

async function logoutAllDevices(req, res) {
    try {
        await flushPattern(`session:*`);
        await flushPattern(`user:socket:${req.user.id}`);
        res.json({ success: true, message: 'Вы вышли из всех устройств' });
    } catch (error) {
        console.error('Ошибка выхода из всех устройств:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// УДАЛЕНИЕ АККАУНТА
// ============================================

async function deleteAccount(req, res) {
    const { password } = req.body;

    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ error: 'Неверный пароль' });
        }

        // Удаляем аватар
        if (user.avatar) {
            const avatarPath = path.join(__dirname, '../../uploads', user.avatar);
            if (fs.existsSync(avatarPath)) fs.unlinkSync(avatarPath);
        }

        await User.softDelete(req.user.id);
        await flushPattern(`user:${req.user.id}`);
        await flushPattern(`session:*`);
        res.clearCookie('token');

        res.json({ success: true, message: 'Аккаунт удалён' });
    } catch (error) {
        console.error('Ошибка удаления аккаунта:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОДПИСКА НА ПОЛЬЗОВАТЕЛЯ
// ============================================

async function subscribeToUser(req, res) {
    const { id } = req.params;

    if (req.user.id === parseInt(id)) {
        return res.status(400).json({ error: 'Нельзя подписаться на себя' });
    }

    try {
        const existing = await User.query(
            `SELECT 1 FROM subscriptions WHERE user_id = $1 AND seller_id = $2`,
            [req.user.id, parseInt(id)]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Вы уже подписаны' });
        }

        await User.query(
            `INSERT INTO subscriptions (user_id, seller_id, created_at) VALUES ($1, $2, NOW())`,
            [req.user.id, parseInt(id)]
        );

        await del(`user:subscriptions:${req.user.id}`);
        await addJob('notificationQueue', 'newSubscriptionNotification', {
            userId: parseInt(id),
            subscriberName: req.user.name
        });

        res.json({ success: true, subscribed: true });
    } catch (error) {
        console.error('Ошибка подписки:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function unsubscribeFromUser(req, res) {
    const { id } = req.params;

    try {
        await User.query(
            `DELETE FROM subscriptions WHERE user_id = $1 AND seller_id = $2`,
            [req.user.id, parseInt(id)]
        );

        await del(`user:subscriptions:${req.user.id}`);
        res.json({ success: true, subscribed: false });
    } catch (error) {
        console.error('Ошибка отписки:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function getSubscriptions(req, res) {
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
// ЭКСПОРТ
// ============================================

module.exports = {
    getProfile,
    updateProfile,
    uploadAvatar,
    deleteAvatar,
    getPublicProfile,
    getUserStats,
    getUserListings,
    getUserReviews,
    getBlacklist,
    addToBlacklist,
    removeFromBlacklist,
    logoutAllDevices,
    deleteAccount,
    subscribeToUser,
    unsubscribeFromUser,
    getSubscriptions
};