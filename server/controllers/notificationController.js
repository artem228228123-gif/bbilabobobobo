/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/controllers/notificationController.js
 * Описание: Контроллер уведомлений (список, настройки, push-подписки, массовая рассылка)
 */

const { User } = require('../models');
const { get, set, del, incr, sadd, smembers, srem } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { sendNotification, sendMassNotification } = require('../services/notificationService');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_TTL = {
    list: 300,           // 5 минут
    unread: 300,         // 5 минут
    settings: 86400      // 24 часа
};

const NOTIFICATION_TYPES = {
    MESSAGE: 'message',
    LIKE: 'like',
    SALE: 'sale',
    REVIEW: 'review',
    LOTTERY: 'lottery',
    SYSTEM: 'system',
    LISTING_APPROVED: 'listing_approved',
    LISTING_REJECTED: 'listing_rejected',
    ACCOUNT_BLOCKED: 'account_blocked',
    AUCTION_BID: 'auction_bid',
    AUCTION_WIN: 'auction_win',
    SUBSCRIPTION: 'subscription',
    PROMOTION: 'promotion'
};

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

async function getUserNotificationSettings(userId) {
    const cacheKey = `notifications:settings:${userId}`;
    const cached = await get(cacheKey);
    if (cached) {
        return cached;
    }
    
    const defaultSettings = {
        email: true,
        push: false,
        telegram: false,
        sound: true,
        types: {
            [NOTIFICATION_TYPES.MESSAGE]: true,
            [NOTIFICATION_TYPES.LIKE]: true,
            [NOTIFICATION_TYPES.SALE]: true,
            [NOTIFICATION_TYPES.REVIEW]: true,
            [NOTIFICATION_TYPES.LOTTERY]: true,
            [NOTIFICATION_TYPES.SYSTEM]: true,
            [NOTIFICATION_TYPES.LISTING_APPROVED]: true,
            [NOTIFICATION_TYPES.LISTING_REJECTED]: true,
            [NOTIFICATION_TYPES.AUCTION_BID]: true,
            [NOTIFICATION_TYPES.AUCTION_WIN]: true,
            [NOTIFICATION_TYPES.SUBSCRIPTION]: true,
            [NOTIFICATION_TYPES.PROMOTION]: false
        }
    };
    
    await set(cacheKey, defaultSettings, CACHE_TTL.settings);
    return defaultSettings;
}

async function updateUnreadCount(userId) {
    const result = await User.query(
        `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`,
        [userId]
    );
    const count = parseInt(result.rows[0].count);
    await set(`notifications:unread:${userId}`, count, CACHE_TTL.unread);
    return count;
}

// ============================================
// ПОЛУЧЕНИЕ СПИСКА УВЕДОМЛЕНИЙ
// ============================================

async function getNotifications(req, res) {
    const { limit = 20, page = 1, type, unread_only } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    try {
        const cacheKey = `notifications:list:${req.user.id}:${page}:${limit}:${type}:${unread_only}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }
        
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
                       WHEN n.type = 'auction_bid' THEN '💰'
                       WHEN n.type = 'auction_win' THEN '🏆'
                       WHEN n.type = 'subscription' THEN '👤'
                       WHEN n.type = 'promotion' THEN '🎉'
                       ELSE '📢'
                   END as icon
            FROM notifications n
            WHERE n.user_id = $1
        `;
        const params = [req.user.id];
        
        if (type) {
            sql += ` AND n.type = $2`;
            params.push(type);
        }
        
        if (unread_only === 'true') {
            sql += ` AND n.is_read = false`;
        }
        
        const countSql = sql.replace(/SELECT.*FROM/, 'SELECT COUNT(*) FROM');
        const countResult = await User.query(countSql, params);
        const total = parseInt(countResult.rows[0].count);
        
        sql += ` ORDER BY n.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(parseInt(limit), offset);
        
        const result = await User.query(sql, params);
        const unreadCount = await updateUnreadCount(req.user.id);
        
        const response = {
            notifications: result.rows,
            unread_count: unreadCount,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / parseInt(limit))
            }
        };
        
        await set(cacheKey, response, CACHE_TTL.list);
        res.json({ success: true, ...response });
    } catch (error) {
        console.error('Ошибка получения уведомлений:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= ОТМЕТКА ПРОЧИТАННЫХ
// ============================================

async function markAsRead(req, res) {
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
        
        const unreadCount = await updateUnreadCount(req.user.id);
        
        // Очищаем кеш
        await del(`notifications:list:${req.user.id}:*`);
        
        res.json({ success: true, unread_count: unreadCount });
    } catch (error) {
        console.error('Ошибка отметки прочитанных:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= УДАЛЕНИЕ УВЕДОМЛЕНИЯ
// ============================================

async function deleteNotification(req, res) {
    const { id } = req.params;
    
    try {
        await User.query(
            `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
            [id, req.user.id]
        );
        
        await updateUnreadCount(req.user.id);
        await del(`notifications:list:${req.user.id}:*`);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка удаления уведомления:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= ПОЛУЧЕНИЕ НАСТРОЕК УВЕДОМЛЕНИЙ
// ============================================

async function getNotificationSettings(req, res) {
    try {
        const settings = await getUserNotificationSettings(req.user.id);
        res.json({ success: true, settings });
    } catch (error) {
        console.error('Ошибка получения настроек:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= ОБНОВЛЕНИЕ НАСТРОЕК УВЕДОМЛЕНИЙ
// ============================================

async function updateNotificationSettings(req, res) {
    const { email, push, telegram, sound, types } = req.body;
    
    try {
        const currentSettings = await getUserNotificationSettings(req.user.id);
        
        const newSettings = {
            ...currentSettings,
            ...(email !== undefined && { email }),
            ...(push !== undefined && { push }),
            ...(telegram !== undefined && { telegram }),
            ...(sound !== undefined && { sound }),
            ...(types && { types: { ...currentSettings.types, ...types } })
        };
        
        await set(`notifications:settings:${req.user.id}`, newSettings, CACHE_TTL.settings);
        
        // Если включены push, проверяем подписку
        if (push && !currentSettings.push) {
            const subscription = await get(`push:subscription:${req.user.id}`);
            if (!subscription) {
                return res.json({
                    success: true,
                    settings: newSettings,
                    warning: 'Для получения push-уведомлений необходимо разрешить их в браузере'
                });
            }
        }
        
        res.json({ success: true, settings: newSettings });
    } catch (error) {
        console.error('Ошибка обновления настроек:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= PUSH-ПОДПИСКА
// ============================================

async function subscribeToPush(req, res) {
    const { subscription } = req.body;
    
    if (!subscription) {
        return res.status(400).json({ error: 'Subscription data required' });
    }
    
    try {
        await set(`push:subscription:${req.user.id}`, subscription, 86400 * 30);
        
        // Отправляем тестовое уведомление
        const webpush = require('web-push');
        if (config.push.vapid.publicKey && config.push.vapid.privateKey) {
            webpush.setVapidDetails(
                config.push.vapid.subject,
                config.push.vapid.publicKey,
                config.push.vapid.privateKey
            );
            
            const testPayload = JSON.stringify({
                title: 'АЙДА',
                body: 'Push-уведомления успешно включены!',
                icon: '/icons/icon-192.png',
                badge: '/icons/badge.png'
            });
            
            await webpush.sendNotification(subscription, testPayload).catch(e => console.log('Test push error:', e));
        }
        
        res.json({ success: true, message: 'Подписка на push-уведомления оформлена' });
    } catch (error) {
        console.error('Ошибка подписки на push:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function unsubscribeFromPush(req, res) {
    try {
        await del(`push:subscription:${req.user.id}`);
        res.json({ success: true, message: 'Отписка от push-уведомлений выполнена' });
    } catch (error) {
        console.error('Ошибка отписки от push:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= НЕПРОЧИТАННЫЕ УВЕДОМЛЕНИЯ
// ============================================

async function getUnreadCount(req, res) {
    try {
        const cached = await get(`notifications:unread:${req.user.id}`);
        if (cached !== null) {
            return res.json({ success: true, count: cached });
        }
        
        const count = await updateUnreadCount(req.user.id);
        res.json({ success: true, count });
    } catch (error) {
        console.error('Ошибка получения количества уведомлений:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= АДМИН-ФУНКЦИИ (МАССОВАЯ РАССЫЛКА)
// ============================================

async function sendMassNotification(req, res) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }
    
    const { title, message, type = 'promotion', link, user_filter = 'all' } = req.body;
    
    if (!title || !message) {
        return res.status(400).json({ error: 'Заголовок и сообщение обязательны' });
    }
    
    try {
        let userIds = [];
        
        if (user_filter === 'all') {
            const result = await User.query(`SELECT id FROM users WHERE status = 'active'`);
            userIds = result.rows.map(u => u.id);
        } else if (user_filter === 'active') {
            const result = await User.query(`SELECT id FROM users WHERE last_seen > NOW() - INTERVAL '7 days'`);
            userIds = result.rows.map(u => u.id);
        } else if (user_filter === 'new') {
            const result = await User.query(`SELECT id FROM users WHERE created_at > NOW() - INTERVAL '30 days'`);
            userIds = result.rows.map(u => u.id);
        } else if (user_filter === 'email') {
            const { emails } = req.body;
            if (emails && emails.length > 0) {
                const result = await User.query(`SELECT id FROM users WHERE email = ANY($1::text[])`, [emails]);
                userIds = result.rows.map(u => u.id);
            }
        }
        
        if (userIds.length === 0) {
            return res.status(400).json({ error: 'Нет получателей' });
        }
        
        // Отправляем в фоне
        await addJob('notificationQueue', 'massNotification', {
            userIds,
            type,
            title,
            message,
            link
        });
        
        res.json({
            success: true,
            message: `Рассылка запущена для ${userIds.length} пользователей`,
            recipientCount: userIds.length
        });
    } catch (error) {
        console.error('Ошибка массовой рассылки:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

async function getNotificationStats(req, res) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }
    
    try {
        // Статистика по типам уведомлений за последние 30 дней
        const stats = await User.query(`
            SELECT 
                type,
                COUNT(*) as total,
                COUNT(CASE WHEN is_read = true THEN 1 END) as read_count,
                COUNT(CASE WHEN is_read = false THEN 1 END) as unread_count,
                AVG(EXTRACT(EPOCH FROM (read_at - created_at))) as avg_read_time
            FROM notifications
            WHERE created_at > NOW() - INTERVAL '30 days'
            GROUP BY type
            ORDER BY total DESC
        `);
        
        // Ежедневная статистика
        const dailyStats = await User.query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as total,
                COUNT(DISTINCT user_id) as unique_users
            FROM notifications
            WHERE created_at > NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `);
        
        res.json({
            success: true,
            stats: stats.rows,
            dailyStats: dailyStats.rows
        });
    } catch (error) {
        console.error('Ошибка получения статистики уведомлений:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    getNotifications,
    markAsRead,
    deleteNotification,
    getNotificationSettings,
    updateNotificationSettings,
    subscribeToPush,
    unsubscribeFromPush,
    getUnreadCount,
    sendMassNotification,
    getNotificationStats,
    NOTIFICATION_TYPES
};