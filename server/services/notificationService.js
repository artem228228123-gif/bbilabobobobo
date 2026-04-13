/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/notificationService.js
 * Описание: Сервис уведомлений (email, push, telegram, WebSocket)
 */

const { addJob } = require('../../config/redis');
const { get, set, del } = require('../../config/redis');
const { sendEmail } = require('./emailService');
const { config } = require('../../config/env');

// ============================================
// КОНФИГУРАЦИЯ
// ============================================

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

// Шаблоны уведомлений
const NOTIFICATION_TEMPLATES = {
    [NOTIFICATION_TYPES.MESSAGE]: {
        title: 'Новое сообщение',
        emailSubject: 'Новое сообщение на АЙДА',
        pushTitle: 'Новое сообщение'
    },
    [NOTIFICATION_TYPES.LIKE]: {
        title: 'Нравится',
        emailSubject: 'Ваше объявление понравилось',
        pushTitle: '❤️ Новый лайк'
    },
    [NOTIFICATION_TYPES.SALE]: {
        title: 'Товар продан!',
        emailSubject: 'Поздравляем с продажей!',
        pushTitle: '💰 Товар продан'
    },
    [NOTIFICATION_TYPES.REVIEW]: {
        title: 'Новый отзыв',
        emailSubject: 'Вам оставили отзыв',
        pushTitle: '⭐ Новый отзыв'
    },
    [NOTIFICATION_TYPES.LOTTERY]: {
        title: 'Результаты лотереи',
        emailSubject: 'Результаты лотереи АЙДА',
        pushTitle: '🎰 Результаты лотереи'
    },
    [NOTIFICATION_TYPES.LISTING_APPROVED]: {
        title: 'Объявление одобрено',
        emailSubject: 'Ваше объявление опубликовано',
        pushTitle: '✅ Объявление одобрено'
    },
    [NOTIFICATION_TYPES.LISTING_REJECTED]: {
        title: 'Объявление отклонено',
        emailSubject: 'Ваше объявление отклонено',
        pushTitle: '❌ Объявление отклонено'
    },
    [NOTIFICATION_TYPES.ACCOUNT_BLOCKED]: {
        title: 'Аккаунт заблокирован',
        emailSubject: 'Ваш аккаунт заблокирован',
        pushTitle: '🔒 Аккаунт заблокирован'
    },
    [NOTIFICATION_TYPES.AUCTION_BID]: {
        title: 'Новая ставка',
        emailSubject: 'Вас перебили на аукционе',
        pushTitle: '💰 Вас перебили'
    },
    [NOTIFICATION_TYPES.AUCTION_WIN]: {
        title: 'Вы выиграли аукцион!',
        emailSubject: 'Поздравляем с победой на аукционе!',
        pushTitle: '🏆 Вы выиграли аукцион'
    },
    [NOTIFICATION_TYPES.SUBSCRIPTION]: {
        title: 'Новый подписчик',
        emailSubject: 'У вас новый подписчик',
        pushTitle: '👤 Новый подписчик'
    },
    [NOTIFICATION_TYPES.PROMOTION]: {
        title: 'Акция',
        emailSubject: 'Специальное предложение на АЙДА',
        pushTitle: '🎉 Специальное предложение'
    }
};

// ============================================
// ОСНОВНЫЕ ФУНКЦИИ
// ============================================

/**
 * Отправка уведомления пользователю
 * @param {number} userId - ID пользователя
 * @param {string} type - тип уведомления
 * @param {Object} data - данные уведомления
 * @returns {Promise<Object>} - результат отправки
 */
async function sendNotification(userId, type, data) {
    const template = NOTIFICATION_TEMPLATES[type];
    if (!template) {
        console.error(`Неизвестный тип уведомления: ${type}`);
        return { success: false, error: 'Unknown notification type' };
    }
    
    try {
        // Получаем настройки пользователя
        const settings = await getUserNotificationSettings(userId);
        
        // Сохраняем в БД
        const notificationId = await saveToDatabase(userId, type, data, template);
        
        // Отправка по каналам
        const results = {
            database: true,
            email: false,
            push: false,
            telegram: false,
            websocket: false
        };
        
        // Email
        if (settings.email && data.email !== false) {
            results.email = await sendEmailNotification(userId, type, data, template);
        }
        
        // Push
        if (settings.push) {
            results.push = await sendPushNotification(userId, type, data, template);
        }
        
        // Telegram
        if (settings.telegram) {
            results.telegram = await sendTelegramNotification(userId, type, data, template);
        }
        
        // WebSocket
        results.websocket = await sendWebSocketNotification(userId, notificationId, type, data, template);
        
        return {
            success: true,
            notificationId,
            results
        };
    } catch (error) {
        console.error('Ошибка отправки уведомления:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Массовая рассылка уведомлений
 * @param {Array<number>} userIds - массив ID пользователей
 * @param {string} type - тип уведомления
 * @param {Object} data - данные уведомления
 * @returns {Promise<Array>} - результаты отправки
 */
async function sendMassNotification(userIds, type, data) {
    const results = [];
    
    for (const userId of userIds) {
        const result = await sendNotification(userId, type, data);
        results.push({ userId, ...result });
        
        // Задержка между отправками (чтобы не перегружать)
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return results;
}

// ============================================
// СОХРАНЕНИЕ В БАЗУ ДАННЫХ
// ============================================

/**
 * Сохранение уведомления в БД
 * @param {number} userId - ID пользователя
 * @param {string} type - тип уведомления
 * @param {Object} data - данные
 * @param {Object} template - шаблон
 * @returns {Promise<number>} - ID уведомления
 */
async function saveToDatabase(userId, type, data, template) {
    const title = data.title || template.title;
    const message = data.message || generateMessage(type, data);
    const link = data.link || null;
    const image = data.image || null;
    
    const result = await require('../models').query(
        `INSERT INTO notifications (user_id, type, title, message, data, link, image, created_at, is_read)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), false)
         RETURNING id`,
        [userId, type, title, message, JSON.stringify(data), link, image]
    );
    
    // Обновляем кеш непрочитанных
    await incrementUnreadCount(userId);
    
    return result.rows[0].id;
}

// ============================================
// EMAIL УВЕДОМЛЕНИЯ
// ============================================

/**
 * Отправка email уведомления
 * @param {number} userId - ID пользователя
 * @param {string} type - тип уведомления
 * @param {Object} data - данные
 * @param {Object} template - шаблон
 * @returns {Promise<boolean>} - результат
 */
async function sendEmailNotification(userId, type, data, template) {
    try {
        const user = await require('../models').User.findById(userId);
        if (!user || !user.email) return false;
        
        const subject = template.emailSubject;
        const html = generateEmailHtml(type, data, user.name);
        
        await addJob('emailQueue', 'sendEmail', {
            to: user.email,
            subject,
            html
        });
        
        return true;
    } catch (error) {
        console.error('Ошибка отправки email:', error);
        return false;
    }
}

// ============================================
// PUSH УВЕДОМЛЕНИЯ
// ============================================

/**
 * Отправка push уведомления
 * @param {number} userId - ID пользователя
 * @param {string} type - тип уведомления
 * @param {Object} data - данные
 * @param {Object} template - шаблон
 * @returns {Promise<boolean>} - результат
 */
async function sendPushNotification(userId, type, data, template) {
    try {
        const subscription = await get(`push:subscription:${userId}`);
        if (!subscription) return false;
        
        const webpush = require('web-push');
        
        const payload = JSON.stringify({
            title: data.pushTitle || template.pushTitle,
            body: data.message || generateMessage(type, data),
            icon: data.icon || '/icons/icon-192.png',
            badge: '/icons/badge.png',
            data: {
                url: data.link || '/',
                type: type,
                notificationId: data.notificationId
            },
            vibrate: [200, 100, 200],
            tag: `aida-${type}-${Date.now()}`
        });
        
        await webpush.sendNotification(subscription, payload);
        return true;
    } catch (error) {
        if (error.statusCode === 410) {
            // Подписка невалидна, удаляем
            await del(`push:subscription:${userId}`);
        }
        return false;
    }
}

// ============================================
// TELEGRAM УВЕДОМЛЕНИЯ
// ============================================

/**
 * Отправка Telegram уведомления
 * @param {number} userId - ID пользователя
 * @param {string} type - тип уведомления
 * @param {Object} data - данные
 * @param {Object} template - шаблон
 * @returns {Promise<boolean>} - результат
 */
async function sendTelegramNotification(userId, type, data, template) {
    try {
        const telegramId = await get(`telegram:user:${userId}`);
        if (!telegramId || !config.oauth.telegram.botToken) return false;
        
        const message = generateTelegramMessage(type, data);
        
        await addJob('telegramQueue', 'sendMessage', {
            chatId: telegramId,
            text: message,
            parseMode: 'HTML'
        });
        
        return true;
    } catch (error) {
        console.error('Ошибка отправки Telegram:', error);
        return false;
    }
}

// ============================================
// WEBSOCKET УВЕДОМЛЕНИЯ
// ============================================

/**
 * Отправка WebSocket уведомления
 * @param {number} userId - ID пользователя
 * @param {number} notificationId - ID уведомления
 * @param {string} type - тип уведомления
 * @param {Object} data - данные
 * @param {Object} template - шаблон
 * @returns {Promise<boolean>} - результат
 */
async function sendWebSocketNotification(userId, notificationId, type, data, template) {
    try {
        const socketId = await get(`user:socket:${userId}`);
        if (socketId && global.io) {
            global.io.to(socketId).emit('new_notification', {
                id: notificationId,
                type,
                title: data.title || template.title,
                message: data.message || generateMessage(type, data),
                link: data.link,
                image: data.image,
                created_at: new Date().toISOString(),
                is_read: false
            });
            return true;
        }
        return false;
    } catch (error) {
        console.error('Ошибка отправки WebSocket:', error);
        return false;
    }
}

// ============================================
// ГЕНЕРАЦИЯ СООБЩЕНИЙ
// ============================================

/**
 * Генерация текста сообщения
 * @param {string} type - тип уведомления
 * @param {Object} data - данные
 * @returns {string} - текст сообщения
 */
function generateMessage(type, data) {
    switch (type) {
        case NOTIFICATION_TYPES.MESSAGE:
            return `${data.senderName} написал(а) вам сообщение: "${data.messagePreview}"`;
        case NOTIFICATION_TYPES.LIKE:
            return `${data.userName} понравилось ваше объявление "${data.listingTitle}"`;
        case NOTIFICATION_TYPES.SALE:
            return `Ваше объявление "${data.listingTitle}" было продано за ${data.price.toLocaleString()} ₽`;
        case NOTIFICATION_TYPES.REVIEW:
            return `${data.reviewerName} оставил(а) отзыв с оценкой ${data.rating}⭐`;
        case NOTIFICATION_TYPES.LOTTERY:
            return data.isWin 
                ? `Поздравляем! Вы выиграли ${data.prize} бонусов в лотерее!`
                : `Лотерея завершена. Спасибо за участие!`;
        case NOTIFICATION_TYPES.LISTING_APPROVED:
            return `Ваше объявление "${data.listingTitle}" прошло модерацию и опубликовано`;
        case NOTIFICATION_TYPES.LISTING_REJECTED:
            return `Ваше объявление "${data.listingTitle}" отклонено. Причина: ${data.reason}`;
        case NOTIFICATION_TYPES.ACCOUNT_BLOCKED:
            return `Ваш аккаунт заблокирован. Причина: ${data.reason}`;
        case NOTIFICATION_TYPES.AUCTION_BID:
            return `${data.bidderName} сделал(а) ставку ${data.amount.toLocaleString()} ₽ на "${data.listingTitle}"`;
        case NOTIFICATION_TYPES.AUCTION_WIN:
            return `Вы выиграли аукцион "${data.listingTitle}" со ставкой ${data.amount.toLocaleString()} ₽`;
        case NOTIFICATION_TYPES.SUBSCRIPTION:
            return `${data.subscriberName} подписался(ась) на ваши обновления`;
        case NOTIFICATION_TYPES.PROMOTION:
            return data.message || 'Специальное предложение для вас!';
        default:
            return data.message || 'Новое уведомление';
    }
}

/**
 * Генерация HTML для email
 * @param {string} type - тип уведомления
 * @param {Object} data - данные
 * @param {string} userName - имя пользователя
 * @returns {string} - HTML письма
 */
function generateEmailHtml(type, data, userName) {
    const message = generateMessage(type, data);
    const buttonText = getButtonText(type);
    const buttonLink = data.link || '/';
    
    return `
        <h2>Здравствуйте, ${userName}!</h2>
        <p>${message}</p>
        ${buttonText ? `<a href="${buttonLink}" style="display: inline-block; background-color: #10b981; color: white; padding: 12px 24px; border-radius: 44px; text-decoration: none; margin-top: 16px;">${buttonText}</a>` : ''}
        <hr style="margin-top: 32px;">
        <p style="font-size: 12px; color: #8e8e93;">
            Это автоматическое сообщение. Пожалуйста, не отвечайте на него.<br>
            <a href="${config.app.clientUrl}/notifications/settings">Настройки уведомлений</a>
        </p>
    `;
}

/**
 * Генерация сообщения для Telegram
 * @param {string} type - тип уведомления
 * @param {Object} data - данные
 * @returns {string} - сообщение для Telegram
 */
function generateTelegramMessage(type, data) {
    const message = generateMessage(type, data);
    const buttonText = getButtonText(type);
    const buttonLink = data.link || '/';
    
    let result = `🔔 *${NOTIFICATION_TEMPLATES[type]?.title || 'Уведомление'}*\n\n${message}`;
    
    if (buttonText) {
        result += `\n\n👉 [${buttonText}](${config.app.clientUrl}${buttonLink})`;
    }
    
    return result;
}

function getButtonText(type) {
    const buttons = {
        [NOTIFICATION_TYPES.MESSAGE]: 'Перейти в чат',
        [NOTIFICATION_TYPES.LIKE]: 'Посмотреть объявление',
        [NOTIFICATION_TYPES.SALE]: 'Детали продажи',
        [NOTIFICATION_TYPES.REVIEW]: 'Посмотреть отзыв',
        [NOTIFICATION_TYPES.LISTING_APPROVED]: 'Посмотреть объявление',
        [NOTIFICATION_TYPES.AUCTION_BID]: 'Сделать ставку',
        [NOTIFICATION_TYPES.AUCTION_WIN]: 'Детали'
    };
    return buttons[type] || 'Открыть';
}

// ============================================
// НАСТРОЙКИ ПОЛЬЗОВАТЕЛЯ
// ============================================

/**
 * Получение настроек уведомлений пользователя
 * @param {number} userId - ID пользователя
 * @returns {Promise<Object>} - настройки
 */
async function getUserNotificationSettings(userId) {
    const cached = await get(`notifications:settings:${userId}`);
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
            [NOTIFICATION_TYPES.SYSTEM]: true
        }
    };
    
    await set(`notifications:settings:${userId}`, defaultSettings, 86400);
    return defaultSettings;
}

/**
 * Обновление настроек уведомлений
 * @param {number} userId - ID пользователя
 * @param {Object} settings - новые настройки
 * @returns {Promise<Object>} - обновлённые настройки
 */
async function updateUserNotificationSettings(userId, settings) {
    const current = await getUserNotificationSettings(userId);
    const updated = { ...current, ...settings };
    
    await set(`notifications:settings:${userId}`, updated, 86400);
    return updated;
}

// ============================================
// СЧЁТЧИКИ
// ============================================

/**
 * Инкремент счётчика непрочитанных уведомлений
 * @param {number} userId - ID пользователя
 */
async function incrementUnreadCount(userId) {
    const count = await get(`notifications:unread:${userId}`) || 0;
    await set(`notifications:unread:${userId}`, parseInt(count) + 1, 3600);
}

/**
 * Получение количества непрочитанных уведомлений
 * @param {number} userId - ID пользователя
 * @returns {Promise<number>} - количество
 */
async function getUnreadCount(userId) {
    const cached = await get(`notifications:unread:${userId}`);
    if (cached !== null) {
        return parseInt(cached);
    }
    
    const result = await require('../models').query(
        `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`,
        [userId]
    );
    
    const count = parseInt(result.rows[0].count);
    await set(`notifications:unread:${userId}`, count, 3600);
    
    return count;
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    // Основные
    sendNotification,
    sendMassNotification,
    
    // Типы
    NOTIFICATION_TYPES,
    
    // Настройки
    getUserNotificationSettings,
    updateUserNotificationSettings,
    
    // Счётчики
    getUnreadCount,
    incrementUnreadCount
};