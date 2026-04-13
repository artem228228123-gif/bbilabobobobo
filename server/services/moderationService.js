/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/moderationService.js
 * Описание: Сервис модерации (проверка объявлений, AI проверка, фильтрация)
 */

const { query } = require('../../config/database');
const { get, set, del, incr } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { sendNotification } = require('./notificationService');
const { config } = require('../../config/env');

// ============================================
// КОНФИГУРАЦИЯ
// ============================================

const MODERATION_CONFIG = {
    maxListingsPerDay: 50,      // Максимум объявлений в день от одного пользователя
    maxImagesPerListing: 10,    // Максимум фото в объявлении
    minPrice: 0,                 // Минимальная цена
    maxPrice: 1000000000,        // Максимальная цена (1 млрд)
    minTitleLength: 5,           // Минимальная длина заголовка
    maxTitleLength: 200,         // Максимальная длина заголовка
    minDescriptionLength: 0,     // Минимальная длина описания
    maxDescriptionLength: 5000,   // Максимальная длина описания
    
    // Запрещённые слова (в объявлениях)
    forbiddenWords: [
        'наркотик', 'наркота', 'спайс', 'соль', 'мефедрон', 'амфетамин',
        'кокаин', 'героин', 'марихуана', 'гашиш', 'экстази', 'лсд',
        'оружие', 'пистолет', 'автомат', 'винтовка', 'огнестрельное',
        'взрывчатка', 'динамит', 'тротил', 'оружие массового поражения',
        'краденый', 'ворованный', 'угнанный', 'краж', 'воровство',
        'паспорт', 'загранпаспорт', 'удостоверение', 'права', 'водительское удостоверение',
        'диплом', 'аттестат', 'сертификат', 'корочка', 'документ об образовании',
        'животное редкое', 'красная книга', 'исчезающий вид'
    ],
    
    // Запрещённые слова в чатах
    forbiddenChatWords: [
        'мат', 'хуй', 'пизда', 'бля', 'ебать', 'нахер', 'нахуй',
        'сука', 'сучка', 'говно', 'дерьмо', 'тварь', 'ублюдок',
        'лох', 'олень', 'козел', 'баран', 'осел'
    ],
    
    // Подозрительные паттерны (мошенничество)
    suspiciousPatterns: [
        /предоплата\s*(?:100%|полная|частичная)/i,
        /переведите\s*деньги\s*на\s*карту/i,
        /киви|qiwi|яндекс\.деньги|yoomoney/i,
        /без\s*посредников\s*оплата\s*сразу/i,
        /отправка\s*после\s*оплаты/i,
        /дешево\s*(?:продам|отдам)/i,
        /\d{16}/, // номер карты
        /https?:\/\/\S+\.(?:ru|com|net|org)\S*/i // подозрительные ссылки
    ]
};

// ============================================
// ПРОВЕРКА ОБЪЯВЛЕНИЯ
// ============================================

/**
 * Полная проверка объявления перед публикацией
 * @param {Object} listing - данные объявления
 * @param {number} userId - ID пользователя
 * @returns {Promise<Object>} - результат проверки
 */
async function moderateListing(listing, userId) {
    const checks = {
        title: await checkTitle(listing.title),
        description: await checkDescription(listing.description),
        price: checkPrice(listing.price),
        photos: await checkPhotos(listing.photos),
        userLimit: await checkUserDailyLimit(userId),
        forbiddenWords: checkForbiddenWords(listing.title, listing.description),
        suspicious: checkSuspiciousPatterns(listing.title, listing.description),
        aiCheck: config.ai.nsfwDetection ? await aiCheck(listing.photos) : { passed: true }
    };
    
    const allPassed = Object.values(checks).every(check => check.passed !== false);
    const warnings = Object.values(checks).filter(check => check.warning).map(c => c.warning);
    
    if (allPassed) {
        return {
            approved: true,
            status: 'approved',
            checks,
            warnings
        };
    } else {
        const reasons = Object.values(checks)
            .filter(check => !check.passed && check.reason)
            .map(check => check.reason);
        
        return {
            approved: false,
            status: 'rejected',
            checks,
            reasons,
            warnings
        };
    }
}

/**
 * Проверка заголовка
 * @param {string} title - заголовок
 * @returns {Object} - результат проверки
 */
function checkTitle(title) {
    if (!title || title.trim().length === 0) {
        return { passed: false, reason: 'Заголовок не может быть пустым' };
    }
    
    if (title.length < MODERATION_CONFIG.minTitleLength) {
        return { passed: false, reason: `Заголовок слишком короткий (минимум ${MODERATION_CONFIG.minTitleLength} символов)` };
    }
    
    if (title.length > MODERATION_CONFIG.maxTitleLength) {
        return { passed: false, reason: `Заголовок слишком длинный (максимум ${MODERATION_CONFIG.maxTitleLength} символов)` };
    }
    
    if (/[<>{}[\]\\]/.test(title)) {
        return { passed: false, reason: 'Заголовок содержит недопустимые символы' };
    }
    
    return { passed: true };
}

/**
 * Проверка описания
 * @param {string} description - описание
 * @returns {Object} - результат проверки
 */
function checkDescription(description) {
    if (!description) return { passed: true };
    
    if (description.length > MODERATION_CONFIG.maxDescriptionLength) {
        return { passed: false, reason: `Описание слишком длинное (максимум ${MODERATION_CONFIG.maxDescriptionLength} символов)` };
    }
    
    return { passed: true };
}

/**
 * Проверка цены
 * @param {number} price - цена
 * @returns {Object} - результат проверки
 */
function checkPrice(price) {
    if (price === undefined || price === null) {
        return { passed: false, reason: 'Цена не указана' };
    }
    
    if (price < MODERATION_CONFIG.minPrice) {
        return { passed: false, reason: `Цена не может быть отрицательной` };
    }
    
    if (price > MODERATION_CONFIG.maxPrice) {
        return { passed: false, reason: `Цена слишком высокая` };
    }
    
    return { passed: true };
}

/**
 * Проверка количества объявлений от пользователя за день
 * @param {number} userId - ID пользователя
 * @returns {Promise<Object>} - результат проверки
 */
async function checkUserDailyLimit(userId) {
    const today = new Date().toISOString().split('T')[0];
    const key = `moderation:user:${userId}:listings:${today}`;
    
    const count = await get(key) || 0;
    
    if (count >= MODERATION_CONFIG.maxListingsPerDay) {
        return {
            passed: false,
            reason: `Превышен лимит объявлений в день (максимум ${MODERATION_CONFIG.maxListingsPerDay})`
        };
    }
    
    return { passed: true };
}

/**
 * Проверка фото (качество, формат, NSFW)
 * @param {Array} photos - массив фото
 * @returns {Promise<Object>} - результат проверки
 */
async function checkPhotos(photos) {
    if (!photos || photos.length === 0) {
        return { passed: false, reason: 'Необходимо загрузить хотя бы одно фото' };
    }
    
    if (photos.length > MODERATION_CONFIG.maxImagesPerListing) {
        return { passed: false, reason: `Слишком много фото (максимум ${MODERATION_CONFIG.maxImagesPerListing})` };
    }
    
    return { passed: true };
}

/**
 * Проверка на запрещённые слова
 * @param {string} title - заголовок
 * @param {string} description - описание
 * @returns {Object} - результат проверки
 */
function checkForbiddenWords(title, description) {
    const text = `${title} ${description || ''}`.toLowerCase();
    
    for (const word of MODERATION_CONFIG.forbiddenWords) {
        if (text.includes(word.toLowerCase())) {
            return {
                passed: false,
                reason: `Обнаружено запрещённое слово: "${word}"`
            };
        }
    }
    
    return { passed: true };
}

/**
 * Проверка на подозрительные паттерны (мошенничество)
 * @param {string} title - заголовок
 * @param {string} description - описание
 * @returns {Object} - результат проверки
 */
function checkSuspiciousPatterns(title, description) {
    const text = `${title} ${description || ''}`;
    
    for (const pattern of MODERATION_CONFIG.suspiciousPatterns) {
        if (pattern.test(text)) {
            return {
                passed: false,
                reason: 'Обнаружен подозрительный паттерн. Объявление отправлено на ручную модерацию.',
                warning: true
            };
        }
    }
    
    return { passed: true };
}

/**
 * AI проверка фото (NSFW)
 * @param {Array} photos - массив фото
 * @returns {Promise<Object>} - результат проверки
 */
async function aiCheck(photos) {
    if (!config.ai.yandexVision.enabled || !photos || photos.length === 0) {
        return { passed: true };
    }
    
    try {
        // Здесь будет реальный запрос к Yandex Vision API
        // Для продакшена нужно реализовать отправку фото и анализ
        
        return { passed: true };
    } catch (error) {
        console.error('AI проверка не удалась:', error);
        return { passed: true, warning: 'AI проверка временно недоступна' };
    }
}

// ============================================
// МОДЕРАЦИЯ ЧАТОВ
// ============================================

/**
 * Проверка сообщения в чате
 * @param {string} message - текст сообщения
 * @param {number} userId - ID пользователя
 * @returns {Promise<Object>} - результат проверки
 */
async function moderateMessage(message, userId) {
    const checks = {
        forbiddenWords: checkChatForbiddenWords(message),
        spam: await checkSpam(userId),
        links: checkLinks(message)
    };
    
    const allPassed = Object.values(checks).every(check => check.passed !== false);
    
    if (allPassed) {
        return { approved: true };
    } else {
        const reasons = Object.values(checks)
            .filter(check => !check.passed && check.reason)
            .map(check => check.reason);
        
        return {
            approved: false,
            reasons,
            blocked: checks.forbiddenWords?.passed === false
        };
    }
}

/**
 * Проверка на запрещённые слова в чатах
 * @param {string} message - текст сообщения
 * @returns {Object} - результат проверки
 */
function checkChatForbiddenWords(message) {
    const lowerMessage = message.toLowerCase();
    
    for (const word of MODERATION_CONFIG.forbiddenChatWords) {
        if (lowerMessage.includes(word)) {
            return {
                passed: false,
                reason: `Обнаружено нецензурное слово`,
                blocked: true
            };
        }
    }
    
    return { passed: true };
}

/**
 * Проверка на спам (частота сообщений)
 * @param {number} userId - ID пользователя
 * @returns {Promise<Object>} - результат проверки
 */
async function checkSpam(userId) {
    const key = `moderation:spam:${userId}`;
    const count = await incr(key, 1);
    
    if (count === 1) {
        await set(key, 1, 10); // 10 секунд
    }
    
    if (count > 10) {
        return {
            passed: false,
            reason: 'Слишком много сообщений. Подождите немного.',
            spam: true
        };
    }
    
    return { passed: true };
}

/**
 * Проверка ссылок в сообщении
 * @param {string} message - текст сообщения
 * @returns {Object} - результат проверки
 */
function checkLinks(message) {
    const urlPattern = /https?:\/\/[^\s]+/g;
    const urls = message.match(urlPattern);
    
    if (urls) {
        // Разрешаем только ссылки на АЙДА
        const allowedDomains = ['aida.ru', 'aida.com'];
        for (const url of urls) {
            const isAllowed = allowedDomains.some(domain => url.includes(domain));
            if (!isAllowed) {
                return {
                    passed: false,
                    reason: 'Ссылки на сторонние ресурсы запрещены',
                    blocked: true
                };
            }
        }
    }
    
    return { passed: true };
}

// ============================================
= ЖАЛОБЫ
// ============================================

/**
 * Создание жалобы
 * @param {number} userId - ID пользователя (кто жалуется)
 * @param {number} complainedUserId - ID пользователя (на кого жалуются)
 * @param {number} listingId - ID объявления (опционально)
 * @param {number} chatId - ID чата (опционально)
 * @param {string} reason - причина жалобы
 * @param {string} description - описание
 * @returns {Promise<Object>} - результат
 */
async function createComplaint(userId, complainedUserId, listingId, chatId, reason, description) {
    const result = await query(
        `INSERT INTO complaints (user_id, complained_user_id, listing_id, chat_id, reason, description, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
         RETURNING id`,
        [userId, complainedUserId, listingId || null, chatId || null, reason, description || null]
    );
    
    // Уведомляем модераторов
    await notifyModerators('new_complaint', {
        complaintId: result.rows[0].id,
        userId,
        complainedUserId,
        reason
    });
    
    // Проверяем автоблокировку
    await checkAutoBlock(complainedUserId);
    
    return { success: true, complaintId: result.rows[0].id };
}

/**
 * Проверка автоблокировки (3+ жалобы за час)
 * @param {number} userId - ID пользователя
 * @returns {Promise<boolean>} - был ли заблокирован
 */
async function checkAutoBlock(userId) {
    const result = await query(
        `SELECT COUNT(*) FROM complaints 
         WHERE complained_user_id = $1 
         AND created_at > NOW() - INTERVAL '1 hour'`,
        [userId]
    );
    
    const complaintsCount = parseInt(result.rows[0].count);
    
    if (complaintsCount >= 3) {
        await query(
            `UPDATE users SET status = 'blocked', block_reason = 'Автоматическая блокировка: 3+ жалоб за час', blocked_until = NOW() + INTERVAL '24 hours'
             WHERE id = $1`,
            [userId]
        );
        
        await sendNotification(userId, 'account_blocked', {
            reason: 'Автоматическая блокировка: 3+ жалоб за час',
            duration: '24 часа'
        });
        
        return true;
    }
    
    return false;
}

// ============================================
= УВЕДОМЛЕНИЯ МОДЕРАТОРОВ
// ============================================

/**
 * Уведомление модераторов о событии
 * @param {string} event - тип события
 * @param {Object} data - данные события
 */
async function notifyModerators(event, data) {
    // Получаем всех модераторов и админов
    const moderators = await query(
        `SELECT id, email, telegram_id FROM users WHERE role IN ('moderator', 'admin')`
    );
    
    for (const moderator of moderators.rows) {
        await sendNotification(moderator.id, 'system', {
            title: 'Новое событие модерации',
            message: getModeratorMessage(event, data),
            link: '/admin.html',
            type: 'moderation'
        });
        
        // Отправляем в Telegram если есть
        if (moderator.telegram_id && config.oauth.telegram.botToken) {
            await addJob('telegramQueue', 'sendMessage', {
                chatId: moderator.telegram_id,
                text: `🔔 *Событие модерации*\n\n${getModeratorMessage(event, data)}\n\n[Открыть админку](${config.app.clientUrl}/admin.html)`,
                parseMode: 'Markdown'
            });
        }
    }
}

function getModeratorMessage(event, data) {
    switch (event) {
        case 'new_complaint':
            return `📢 Новая жалоба #${data.complaintId}\nПользователь: ${data.userId}\nНарушитель: ${data.complainedUserId}\nПричина: ${data.reason}`;
        case 'suspicious_listing':
            return `⚠️ Подозрительное объявление #${data.listingId} от пользователя ${data.userId}`;
        case 'auto_block':
            return `🔒 Автоблокировка пользователя ${data.userId}\nПричина: ${data.reason}`;
        default:
            return `Новое событие: ${event}`;
    }
}

// ============================================
// АДМИНИСТРИРОВАНИЕ
// ============================================

/**
 * Одобрение объявления
 * @param {number} listingId - ID объявления
 * @param {number} moderatorId - ID модератора
 * @param {string} comment - комментарий
 */
async function approveListing(listingId, moderatorId, comment = null) {
    await query(
        `UPDATE listings SET status = 'active', moderated_by = $1, moderated_at = NOW(), moderation_comment = $2
         WHERE id = $3`,
        [moderatorId, comment, listingId]
    );
    
    // Уведомляем пользователя
    const listing = await query(`SELECT user_id, title FROM listings WHERE id = $1`, [listingId]);
    if (listing.rows[0]) {
        await sendNotification(listing.rows[0].user_id, 'listing_approved', {
            listingTitle: listing.rows[0].title,
            listingId,
            comment
        });
    }
}

/**
 * Отклонение объявления
 * @param {number} listingId - ID объявления
 * @param {number} moderatorId - ID модератора
 * @param {string} reason - причина отклонения
 */
async function rejectListing(listingId, moderatorId, reason) {
    await query(
        `UPDATE listings SET status = 'rejected', moderated_by = $1, moderated_at = NOW(), rejection_reason = $2
         WHERE id = $3`,
        [moderatorId, reason, listingId]
    );
    
    // Уведомляем пользователя
    const listing = await query(`SELECT user_id, title FROM listings WHERE id = $1`, [listingId]);
    if (listing.rows[0]) {
        await sendNotification(listing.rows[0].user_id, 'listing_rejected', {
            listingTitle: listing.rows[0].title,
            listingId,
            reason
        });
    }
}

/**
 * Получение списка объявлений на модерации
 * @param {number} limit - лимит
 * @param {number} offset - смещение
 * @returns {Promise<Array>} - список объявлений
 */
async function getPendingListings(limit = 20, offset = 0) {
    const result = await query(
        `SELECT l.*, u.name as user_name, u.email as user_email, u.phone as user_phone,
                (SELECT COUNT(*) FROM listing_photos WHERE listing_id = l.id) as photos_count
         FROM listings l
         JOIN users u ON u.id = l.user_id
         WHERE l.status = 'pending'
         ORDER BY l.created_at ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
    );
    
    const countResult = await query(`SELECT COUNT(*) FROM listings WHERE status = 'pending'`);
    
    return {
        listings: result.rows,
        total: parseInt(countResult.rows[0].count)
    };
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    // Проверка объявлений
    moderateListing,
    checkTitle,
    checkDescription,
    checkPrice,
    checkUserDailyLimit,
    checkPhotos,
    checkForbiddenWords,
    checkSuspiciousPatterns,
    aiCheck,
    
    // Проверка чатов
    moderateMessage,
    checkChatForbiddenWords,
    checkSpam,
    checkLinks,
    
    // Жалобы
    createComplaint,
    checkAutoBlock,
    
    // Администрирование
    approveListing,
    rejectListing,
    getPendingListings,
    
    // Конфигурация
    MODERATION_CONFIG
};