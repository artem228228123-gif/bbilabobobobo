/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/routes/notifications.js
 * Описание: Маршруты для уведомлений (список, настройки, push-подписки)
 */

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const webpush = require('web-push');

const router = express.Router();
const { User } = require('../models');
const { authenticate } = require('../middleware/auth');
const { get, set, del, incr, sadd, smembers } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// НАСТРОЙКА PUSH-УВЕДОМЛЕНИЙ
// ============================================

if (config.push.vapid.publicKey && config.push.vapid.privateKey) {
    webpush.setVapidDetails(
        config.push.vapid.subject,
        config.push.vapid.publicKey,
        config.push.vapid.privateKey
    );
}

function validate(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    return null;
}

// ============================================
// GET /api/v1/notifications
// Получение списка уведомлений пользователя
// ============================================
router.get(
    '/',
    authenticate,
    [
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('page').optional().isInt({ min: 1 }),
        query('type').optional().isString(),
        query('unread_only').optional().isBoolean()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { limit = 20, page = 1, type, unread_only } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        try {
            let sql = `
                SELECT n.*, 
                       CASE 
                           WHEN n.type = 'message' THEN '💬'
                           WHEN n.type = 'like' THEN '❤️'
                           WHEN n.type = 'sale' THEN '💰'
                           WHEN n.type = 'review' THEN '⭐'
                           WHEN n.type = 'lottery' THEN '🎰'
                           WHEN n.type = 'listing_approved' THEN '✅'
                           WHEN n.type = 'listing_rejected' THEN '❌'
                           WHEN n.type = 'account_blocked' THEN '🔒'
                           ELSE '📢'
                       END as icon
                FROM notifications n
                WHERE n.user_id = $1
            `;
            const params = [req.user.id];
            let idx = 2;

            if (type) {
                sql += ` AND n.type = $${idx}`;
                params.push(type);
                idx++;
            }

            if (unread_only === 'true') {
                sql += ` AND n.is_read = false`;
            }

            const countSql = sql.replace(/SELECT.*FROM/, 'SELECT COUNT(*) FROM');
            const countResult = await User.query(countSql, params);
            const total = parseInt(countResult.rows[0].count);

            sql += ` ORDER BY n.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
            params.push(parseInt(limit), offset);

            const result = await User.query(sql, params);

            // Получаем количество непрочитанных
            const unreadResult = await User.query(
                `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`,
                [req.user.id]
            );
            const unreadCount = parseInt(unreadResult.rows[0].count);

            res.json({
                success: true,
                notifications: result.rows,
                unread_count: unreadCount,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    totalPages: Math.ceil(total / parseInt(limit))
                }
            });
        } catch (error) {
            console.error('Ошибка получения уведомлений:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/notifications/mark-read
// Отметить уведомления как прочитанные
// ============================================
router.post(
    '/mark-read',
    authenticate,
    [
        body('ids').optional().isArray(),
        body('all').optional().isBoolean()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { ids, all } = req.body;

        try {
            if (all) {
                await User.query(
                    `UPDATE notifications SET is_read = true, read_at = NOW()
                     WHERE user_id = $1 AND is_read = false`,
                    [req.user.id]
                );
            } else if (ids && ids.length > 0) {
                await User.query(
                    `UPDATE notifications SET is_read = true, read_at = NOW()
                     WHERE user_id = $1 AND id = ANY($2::int[])`,
                    [req.user.id, ids]
                );
            }

            // Обновляем кеш непрочитанных
            const unreadResult = await User.query(
                `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`,
                [req.user.id]
            );
            const unreadCount = parseInt(unreadResult.rows[0].count);
            await set(`notifications:unread:${req.user.id}`, unreadCount, 3600);

            res.json({ success: true, unread_count: unreadCount });
        } catch (error) {
            console.error('Ошибка отметки прочитанных:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// DELETE /api/v1/notifications/:id
// Удаление уведомления
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
            await User.query(
                `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
                [id, req.user.id]
            );

            // Обновляем кеш непрочитанных
            const unreadResult = await User.query(
                `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`,
                [req.user.id]
            );
            const unreadCount = parseInt(unreadResult.rows[0].count);
            await set(`notifications:unread:${req.user.id}`, unreadCount, 3600);

            res.json({ success: true });
        } catch (error) {
            console.error('Ошибка удаления уведомления:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/notifications/unread/count
// Получение количества непрочитанных уведомлений
// ============================================
router.get('/unread/count', authenticate, async (req, res) => {
    try {
        const cached = await get(`notifications:unread:${req.user.id}`);
        if (cached !== null) {
            return res.json({ success: true, count: parseInt(cached) });
        }

        const result = await User.query(
            `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`,
            [req.user.id]
        );
        const count = parseInt(result.rows[0].count);
        
        await set(`notifications:unread:${req.user.id}`, count, 3600);
        
        res.json({ success: true, count });
    } catch (error) {
        console.error('Ошибка получения количества уведомлений:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// POST /api/v1/notifications/subscribe
// Подписка на push-уведомления
// ============================================
router.post(
    '/subscribe',
    authenticate,
    [
        body('subscription').isObject()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { subscription } = req.body;

        try {
            // Сохраняем подписку
            await set(`push:subscription:${req.user.id}`, subscription, 86400 * 30);
            
            res.json({ success: true, message: 'Подписка на push-уведомления оформлена' });
        } catch (error) {
            console.error('Ошибка подписки на push:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// DELETE /api/v1/notifications/unsubscribe
// Отписка от push-уведомлений
// ============================================
router.delete('/unsubscribe', authenticate, async (req, res) => {
    try {
        await del(`push:subscription:${req.user.id}`);
        res.json({ success: true, message: 'Отписка от push-уведомлений выполнена' });
    } catch (error) {
        console.error('Ошибка отписки от push:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/notifications/settings
// Получение настроек уведомлений пользователя
// ============================================
router.get('/settings', authenticate, async (req, res) => {
    try {
        const settings = await get(`notifications:settings:${req.user.id}`);
        
        const defaultSettings = {
            email: true,
            push: false,
            telegram: false,
            sound: true,
            types: {
                message: true,
                like: true,
                sale: true,
                review: true,
                lottery: true,
                system: true
            }
        };
        
        res.json({
            success: true,
            settings: settings || defaultSettings
        });
    } catch (error) {
        console.error('Ошибка получения настроек:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// PUT /api/v1/notifications/settings
// Обновление настроек уведомлений
// ============================================
router.put(
    '/settings',
    authenticate,
    [
        body('email').optional().isBoolean(),
        body('push').optional().isBoolean(),
        body('telegram').optional().isBoolean(),
        body('sound').optional().isBoolean(),
        body('types').optional().isObject()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { email, push, telegram, sound, types } = req.body;

        try {
            const currentSettings = await get(`notifications:settings:${req.user.id}`) || {};
            
            const newSettings = {
                ...currentSettings,
                ...(email !== undefined && { email }),
                ...(push !== undefined && { push }),
                ...(telegram !== undefined && { telegram }),
                ...(sound !== undefined && { sound }),
                ...(types && { types: { ...currentSettings.types, ...types } })
            };
            
            await set(`notifications:settings:${req.user.id}`, newSettings, 86400 * 30);
            
            res.json({
                success: true,
                settings: newSettings,
                message: 'Настройки сохранены'
            });
        } catch (error) {
            console.error('Ошибка сохранения настроек:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ОТПРАВКИ УВЕДОМЛЕНИЙ
// ============================================

// Отправка уведомления пользователю
async function sendNotification(userId, type, title, message, data = null, link = null) {
    try {
        // Сохраняем в БД
        const result = await User.query(
            `INSERT INTO notifications (user_id, type, title, message, data, link, created_at, is_read)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), false)
             RETURNING id`,
            [userId, type, title, message, data ? JSON.stringify(data) : null, link]
        );
        
        const notificationId = result.rows[0].id;
        
        // Обновляем кеш непрочитанных
        await incr(`notifications:unread:${userId}`, 1);
        
        // Отправляем push-уведомление если включено
        const settings = await get(`notifications:settings:${userId}`);
        if (settings?.push) {
            await sendPushNotification(userId, title, message, link);
        }
        
        // Отправляем email если включено
        if (settings?.email) {
            await addJob('emailQueue', 'sendNotificationEmail', {
                userId,
                type,
                title,
                message,
                link
            });
        }
        
        // Отправляем через WebSocket если пользователь онлайн
        const socketId = await get(`user:socket:${userId}`);
        if (socketId && global.io) {
            global.io.to(socketId).emit('new_notification', {
                id: notificationId,
                type,
                title,
                message,
                data,
                link,
                created_at: new Date().toISOString(),
                is_read: false
            });
        }
        
        return notificationId;
    } catch (error) {
        console.error('Ошибка отправки уведомления:', error);
        return null;
    }
}

// Отправка push-уведомления
async function sendPushNotification(userId, title, message, link) {
    try {
        const subscription = await get(`push:subscription:${userId}`);
        if (!subscription) return;
        
        const payload = JSON.stringify({
            title,
            body: message,
            icon: '/icons/icon-192.png',
            badge: '/icons/badge.png',
            data: { url: link || '/' }
        });
        
        await webpush.sendNotification(subscription, payload);
    } catch (error) {
        console.error('Ошибка отправки push-уведомления:', error);
        // Если подписка невалидна, удаляем её
        if (error.statusCode === 410) {
            await del(`push:subscription:${userId}`);
        }
    }
}

// Отправка массовых уведомлений (для админа)
async function sendMassNotification(userIds, type, title, message, data = null, link = null) {
    const results = [];
    for (const userId of userIds) {
        const result = await sendNotification(userId, type, title, message, data, link);
        results.push({ userId, success: !!result });
        // Задержка между отправками
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return results;
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = router;
module.exports.sendNotification = sendNotification;
module.exports.sendPushNotification = sendPushNotification;
module.exports.sendMassNotification = sendMassNotification;