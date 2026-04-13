/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/sockets/notificationSocket.js
 * Описание: WebSocket обработчики для уведомлений (реальное время)
 */

const { get, set, del, incr } = require('../../config/redis');
const { addJob } = require('../../config/redis');

// ============================================
// ХРАНИЛИЩА
// ============================================

const notificationSubscribers = new Map(); // userId -> socketId

// ============================================
= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

async function getUnreadNotificationsCount(userId) {
    const cached = await get(`notifications:unread:${userId}`);
    if (cached !== null) {
        return parseInt(cached);
    }
    
    const { query } = require('../../config/database');
    const result = await query(
        `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`,
        [userId]
    );
    const count = parseInt(result.rows[0].count);
    await set(`notifications:unread:${userId}`, count, 3600);
    return count;
}

// ============================================
= ОСНОВНЫЕ ОБРАБОТЧИКИ
// ============================================

function setupNotificationSocket(io, socket) {
    const userId = socket.userId;
    
    // ========================================
    // ПОДПИСКА НА УВЕДОМЛЕНИЯ
    // ========================================
    socket.on('subscribe_notifications', async () => {
        notificationSubscribers.set(userId, socket.id);
        
        // Отправляем количество непрочитанных уведомлений
        const unreadCount = await getUnreadNotificationsCount(userId);
        socket.emit('unread_count', { count: unreadCount });
        
        console.log(`🔔 [NotificationSocket] Пользователь ${userId} подписался на уведомления`);
    });
    
    // ========================================
    // ОТПИСКА ОТ УВЕДОМЛЕНИЙ
    // ========================================
    socket.on('unsubscribe_notifications', () => {
        notificationSubscribers.delete(userId);
        console.log(`🔕 [NotificationSocket] Пользователь ${userId} отписался от уведомлений`);
    });
    
    // ========================================
    // ЗАПРОС КОЛИЧЕСТВА НЕПРОЧИТАННЫХ
    // ========================================
    socket.on('get_unread_count', async () => {
        const unreadCount = await getUnreadNotificationsCount(userId);
        socket.emit('unread_count', { count: unreadCount });
    });
    
    // ========================================
    // ОТМЕТКА УВЕДОМЛЕНИЙ КАК ПРОЧИТАННЫХ
    // ========================================
    socket.on('mark_notifications_read', async (data) => {
        const { ids, all } = data;
        
        const { query } = require('../../config/database');
        
        if (all) {
            await query(
                `UPDATE notifications SET is_read = true, read_at = NOW()
                 WHERE user_id = $1 AND is_read = false`,
                [userId]
            );
        } else if (ids && ids.length > 0) {
            await query(
                `UPDATE notifications SET is_read = true, read_at = NOW()
                 WHERE user_id = $1 AND id = ANY($2::int[])`,
                [userId, ids]
            );
        }
        
        const unreadCount = await getUnreadNotificationsCount(userId);
        socket.emit('unread_count', { count: unreadCount });
        
        // Уведомляем другие вкладки
        socket.broadcast.emit('notifications_updated', { userId });
    });
    
    // ========================================
    // УДАЛЕНИЕ УВЕДОМЛЕНИЯ
    // ========================================
    socket.on('delete_notification', async (data) => {
        const { id } = data;
        
        const { query } = require('../../config/database');
        
        await query(
            `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
            [id, userId]
        );
        
        const unreadCount = await getUnreadNotificationsCount(userId);
        socket.emit('unread_count', { count: unreadCount });
        socket.broadcast.emit('notifications_updated', { userId });
    });
    
    // ========================================
    // ЗАПРОС СПИСКА УВЕДОМЛЕНИЙ
    // ========================================
    socket.on('get_notifications', async (data) => {
        const { limit = 20, offset = 0 } = data;
        
        const { query } = require('../../config/database');
        
        const result = await query(
            `SELECT n.*, 
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
             ORDER BY n.created_at DESC
             LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );
        
        const countResult = await query(
            `SELECT COUNT(*) FROM notifications WHERE user_id = $1`,
            [userId]
        );
        
        socket.emit('notifications_list', {
            notifications: result.rows,
            total: parseInt(countResult.rows[0].count),
            limit,
            offset
        });
    });
    
    // ========================================
    // ОТКЛЮЧЕНИЕ
    // ========================================
    socket.on('disconnect', () => {
        notificationSubscribers.delete(userId);
        console.log(`🔌 [NotificationSocket] Пользователь ${userId} отключился от уведомлений`);
    });
}

// ============================================
= ФУНКЦИИ ДЛЯ ОТПРАВКИ УВЕДОМЛЕНИЙ
// ============================================

/**
 * Отправка уведомления пользователю в реальном времени
 * @param {number} userId - ID пользователя
 * @param {Object} notification - данные уведомления
 */
async function sendRealTimeNotification(userId, notification) {
    const socketId = notificationSubscribers.get(userId);
    if (socketId && global.io) {
        global.io.to(socketId).emit('new_notification', notification);
        
        // Обновляем счётчик непрочитанных
        const unreadCount = await incr(`notifications:unread:${userId}`, 1);
        global.io.to(socketId).emit('unread_count', { count: unreadCount });
        
        return true;
    }
    return false;
}

/**
 * Отправка уведомления всем пользователям (массовая рассылка)
 * @param {string} event - событие
 * @param {Object} data - данные
 */
function broadcastNotification(event, data) {
    if (global.io) {
        global.io.emit(event, data);
    }
}

/**
 * Отправка уведомления в комнату
 * @param {string} roomId - ID комнаты
 * @param {string} event - событие
 * @param {Object} data - данные
 */
function sendToRoom(roomId, event, data) {
    if (global.io) {
        global.io.to(roomId).emit(event, data);
    }
}

/**
 * Получение списка подписанных пользователей
 */
function getNotificationSubscribers() {
    return Array.from(notificationSubscribers.keys());
}

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    setupNotificationSocket,
    sendRealTimeNotification,
    broadcastNotification,
    sendToRoom,
    getNotificationSubscribers,
    notificationSubscribers
};