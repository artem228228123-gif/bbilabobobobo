/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: config/rateLimit.js
 * Описание: Настройки ограничения частоты запросов (Rate Limiting)
 */

const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const { redis } = require('./redis');
const { config } = require('./env');

// ============================================
// КОНСТАНТЫ
// ============================================

// Стандартные лимиты
const DEFAULT_LIMITS = {
    global: {
        windowMs: 15 * 60 * 1000,  // 15 минут
        max: 100,                   // 100 запросов
        message: 'Слишком много запросов. Попробуйте позже.'
    },
    api: {
        windowMs: 60 * 1000,       // 1 минута
        max: 60,                    // 60 запросов
        message: 'Превышен лимит запросов к API'
    },
    auth: {
        windowMs: 15 * 60 * 1000,  // 15 минут
        max: 5,                     // 5 попыток входа
        message: 'Слишком много попыток входа. Попробуйте через 15 минут.'
    },
    registration: {
        windowMs: 60 * 60 * 1000,  // 1 час
        max: 3,                     // 3 регистрации с одного IP
        message: 'Слишком много регистраций с этого IP'
    },
    passwordReset: {
        windowMs: 60 * 60 * 1000,  // 1 час
        max: 3,                     // 3 запроса на восстановление
        message: 'Слишком много запросов на восстановление пароля'
    },
    listingCreate: {
        windowMs: 60 * 60 * 1000,  // 1 час
        max: 10,                    // 10 объявлений в час
        message: 'Слишком много объявлений. Подождите немного.'
    },
    messageSend: {
        windowMs: 60 * 1000,       // 1 минута
        max: 30,                    // 30 сообщений в минуту
        message: 'Слишком много сообщений. Подождите немного.'
    },
    search: {
        windowMs: 60 * 1000,       // 1 минута
        max: 20,                    // 20 поисковых запросов
        message: 'Слишком много поисковых запросов'
    },
    upload: {
        windowMs: 60 * 60 * 1000,  // 1 час
        max: 50,                    // 50 загрузок файлов
        message: 'Слишком много загрузок файлов'
    },
    like: {
        windowMs: 60 * 1000,       // 1 минута
        max: 30,                    // 30 лайков в минуту
        message: 'Слишком много лайков'
    },
    review: {
        windowMs: 60 * 60 * 1000,  // 1 час
        max: 10,                    // 10 отзывов в час
        message: 'Слишком много отзывов'
    },
    admin: {
        windowMs: 60 * 1000,       // 1 минута
        max: 100,                   // 100 запросов в минуту для админов
        message: 'Превышен лимит запросов к админ-панели'
    }
};

// ============================================
= СОЗДАНИЕ STORE ДЛЯ REDIS
// ============================================

let redisStore = null;

try {
    redisStore = new RedisStore({
        client: redis,
        prefix: 'rl:',
        resetExpiryOnChange: true
    });
} catch (error) {
    console.warn('⚠️ Redis store для rate limiting не доступен, используется memory store');
    redisStore = undefined;
}

// ============================================
= БАЗОВЫЕ ЛИМИТЕРЫ
// ============================================

/**
 * Глобальный лимитер (все запросы)
 */
const globalLimiter = rateLimit({
    store: redisStore,
    windowMs: DEFAULT_LIMITS.global.windowMs,
    max: DEFAULT_LIMITS.global.max,
    message: DEFAULT_LIMITS.global.message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Используем IP + User-Agent для лучшей идентификации
        const ip = req.ip || req.connection.remoteAddress;
        const ua = req.headers['user-agent'] || 'unknown';
        return `${ip}:${ua.substring(0, 50)}`;
    },
    skip: (req) => {
        // Пропускаем health check запросы
        if (req.path === '/health' || req.path === '/ping') return true;
        // Пропускаем запросы от админов с специальным ключом
        if (req.headers['x-admin-key'] === process.env.ADMIN_API_KEY) return true;
        return false;
    },
    handler: (req, res) => {
        res.status(429).json({
            error: DEFAULT_LIMITS.global.message,
            retryAfter: Math.ceil(DEFAULT_LIMITS.global.windowMs / 1000)
        });
    }
});

/**
 * API лимитер (для всех /api/* запросов)
 */
const apiLimiter = rateLimit({
    store: redisStore,
    windowMs: DEFAULT_LIMITS.api.windowMs,
    max: DEFAULT_LIMITS.api.max,
    message: DEFAULT_LIMITS.api.message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const token = req.headers.authorization?.split(' ')[1];
        if (token) return `user:${token.substring(0, 20)}`;
        return req.ip || req.connection.remoteAddress;
    },
    skip: (req) => {
        // Пропускаем запросы от админов
        if (req.user?.role === 'admin') return true;
        return false;
    }
});

/**
 * Лимитер для аутентификации (логин, регистрация)
 */
const authLimiter = rateLimit({
    store: redisStore,
    windowMs: DEFAULT_LIMITS.auth.windowMs,
    max: DEFAULT_LIMITS.auth.max,
    message: DEFAULT_LIMITS.auth.message,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true, // Не считать успешные входы
    keyGenerator: (req) => {
        // Используем email для более точной блокировки
        const email = req.body.email || 'unknown';
        const ip = req.ip || req.connection.remoteAddress;
        return `auth:${email}:${ip}`;
    }
});

/**
 * Лимитер для регистрации
 */
const registrationLimiter = rateLimit({
    store: redisStore,
    windowMs: DEFAULT_LIMITS.registration.windowMs,
    max: DEFAULT_LIMITS.registration.max,
    message: DEFAULT_LIMITS.registration.message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.ip || req.connection.remoteAddress;
    }
});

/**
 * Лимитер для восстановления пароля
 */
const passwordResetLimiter = rateLimit({
    store: redisStore,
    windowMs: DEFAULT_LIMITS.passwordReset.windowMs,
    max: DEFAULT_LIMITS.passwordReset.max,
    message: DEFAULT_LIMITS.passwordReset.message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const email = req.body.email || 'unknown';
        const ip = req.ip || req.connection.remoteAddress;
        return `reset:${email}:${ip}`;
    }
});

// ============================================
= ЛИМИТЕРЫ ДЛЯ БИЗНЕС-ОПЕРАЦИЙ
// ============================================

/**
 * Лимитер для создания объявлений
 */
const listingCreateLimiter = rateLimit({
    store: redisStore,
    windowMs: DEFAULT_LIMITS.listingCreate.windowMs,
    max: DEFAULT_LIMITS.listingCreate.max,
    message: DEFAULT_LIMITS.listingCreate.message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Привязываем к пользователю, если авторизован
        if (req.user?.id) return `user:${req.user.id}`;
        return req.ip || req.connection.remoteAddress;
    }
});

/**
 * Лимитер для отправки сообщений
 */
const messageSendLimiter = rateLimit({
    store: redisStore,
    windowMs: DEFAULT_LIMITS.messageSend.windowMs,
    max: DEFAULT_LIMITS.messageSend.max,
    message: DEFAULT_LIMITS.messageSend.message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user?.id) return `user:${req.user.id}`;
        return req.ip || req.connection.remoteAddress;
    }
});

/**
 * Лимитер для поисковых запросов
 */
const searchLimiter = rateLimit({
    store: redisStore,
    windowMs: DEFAULT_LIMITS.search.windowMs,
    max: DEFAULT_LIMITS.search.max,
    message: DEFAULT_LIMITS.search.message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user?.id) return `user:${req.user.id}`;
        return req.ip || req.connection.remoteAddress;
    },
    skip: (req) => {
        // Пропускаем автодополнение (менее строгий лимит)
        if (req.path.includes('/suggest')) return true;
        return false;
    }
});

/**
 * Лимитер для загрузки файлов
 */
const uploadLimiter = rateLimit({
    store: redisStore,
    windowMs: DEFAULT_LIMITS.upload.windowMs,
    max: DEFAULT_LIMITS.upload.max,
    message: DEFAULT_LIMITS.upload.message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user?.id) return `user:${req.user.id}`;
        return req.ip || req.connection.remoteAddress;
    }
});

/**
 * Лимитер для лайков
 */
const likeLimiter = rateLimit({
    store: redisStore,
    windowMs: DEFAULT_LIMITS.like.windowMs,
    max: DEFAULT_LIMITS.like.max,
    message: DEFAULT_LIMITS.like.message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user?.id) return `user:${req.user.id}`;
        return req.ip || req.connection.remoteAddress;
    }
});

/**
 * Лимитер для отзывов
 */
const reviewLimiter = rateLimit({
    store: redisStore,
    windowMs: DEFAULT_LIMITS.review.windowMs,
    max: DEFAULT_LIMITS.review.max,
    message: DEFAULT_LIMITS.review.message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user?.id) return `user:${req.user.id}`;
        return req.ip || req.connection.remoteAddress;
    }
});

/**
 * Лимитер для админ-панели
 */
const adminLimiter = rateLimit({
    store: redisStore,
    windowMs: DEFAULT_LIMITS.admin.windowMs,
    max: DEFAULT_LIMITS.admin.max,
    message: DEFAULT_LIMITS.admin.message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user?.id) return `admin:${req.user.id}`;
        return req.ip || req.connection.remoteAddress;
    },
    skip: (req) => {
        // Для суперадминов отключаем лимит
        if (req.user?.role === 'superadmin') return true;
        return false;
    }
});

// ============================================
= СПЕЦИАЛЬНЫЕ ЛИМИТЕРЫ
// ============================================

/**
 * Строгий лимитер для чувствительных операций (смена пароля, удаление аккаунта)
 */
const strictLimiter = rateLimit({
    store: redisStore,
    windowMs: 60 * 60 * 1000,  // 1 час
    max: 3,                     // 3 попытки
    message: 'Слишком много попыток. Попробуйте через час.',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user?.id) return `strict:${req.user.id}`;
        return `strict:${req.ip}`;
    }
});

/**
 * Лимитер для API ключей (для партнёров)
 */
const apiKeyLimiter = rateLimit({
    store: redisStore,
    windowMs: 60 * 1000,       // 1 минута
    max: 300,                   // 300 запросов в минуту
    message: 'Превышен лимит запросов для вашего API ключа',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const apiKey = req.headers['x-api-key'];
        return `apikey:${apiKey}`;
    },
    skip: (req) => {
        return !req.headers['x-api-key'];
    }
});

/**
 * Лимитер для вебхуков (низкий приоритет)
 */
const webhookLimiter = rateLimit({
    store: redisStore,
    windowMs: 60 * 1000,       // 1 минута
    max: 10,                    // 10 вебхуков в минуту
    message: 'Слишком много вебхуков',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const provider = req.body?.provider || 'unknown';
        return `webhook:${provider}`;
    }
});

// ============================================
= КАСТОМНЫЙ ОБРАБОТЧИК С IP БАЗОЙ
// ============================================

// База заблокированных IP (для расширенной защиты)
const blockedIPs = new Set();

/**
 * Добавление IP в чёрный список
 * @param {string} ip - IP адрес
 * @param {number} duration - длительность блокировки в секундах
 */
function addToBlocklist(ip, duration = 3600) {
    blockedIPs.add(ip);
    setTimeout(() => {
        blockedIPs.delete(ip);
    }, duration * 1000);
}

/**
 * Проверка IP в чёрном списке
 * @param {string} ip - IP адрес
 * @returns {boolean}
 */
function isIPBlocked(ip) {
    return blockedIPs.has(ip);
}

/**
 * Кастомный лимитер с проверкой по IP базе
 */
const ipBlocklistLimiter = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    
    if (isIPBlocked(ip)) {
        return res.status(403).json({
            error: 'Ваш IP адрес заблокирован за нарушение правил'
        });
    }
    
    next();
};

// ============================================
= УТИЛИТЫ
// ============================================

/**
 * Сброс лимитов для пользователя
 * @param {string} identifier - идентификатор (IP или user ID)
 */
async function resetLimits(identifier) {
    if (redisStore && redisStore.client) {
        const pattern = `rl:*${identifier}*`;
        const keys = await redisStore.client.keys(pattern);
        for (const key of keys) {
            await redisStore.client.del(key);
        }
    }
}

/**
 * Получение текущего количества запросов
 * @param {string} identifier - идентификатор
 * @returns {Promise<number>}
 */
async function getCurrentCount(identifier) {
    if (redisStore && redisStore.client) {
        const key = `rl:${identifier}`;
        const count = await redisStore.client.get(key);
        return parseInt(count) || 0;
    }
    return 0;
}

/**
 * Динамическое изменение лимита
 * @param {string} limiterType - тип лимитера
 * @param {number} newMax - новый лимит
 */
function updateLimiter(limiterType, newMax) {
    const limiters = {
        global: globalLimiter,
        api: apiLimiter,
        auth: authLimiter,
        registration: registrationLimiter,
        listingCreate: listingCreateLimiter
    };
    
    if (limiters[limiterType]) {
        limiters[limiterType].max = newMax;
    }
}

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    // Базовые лимитеры
    globalLimiter,
    apiLimiter,
    authLimiter,
    registrationLimiter,
    passwordResetLimiter,
    
    // Бизнес-лимитеры
    listingCreateLimiter,
    messageSendLimiter,
    searchLimiter,
    uploadLimiter,
    likeLimiter,
    reviewLimiter,
    adminLimiter,
    
    // Специальные лимитеры
    strictLimiter,
    apiKeyLimiter,
    webhookLimiter,
    
    // Middleware для IP блокировки
    ipBlocklistLimiter,
    
    // Утилиты
    resetLimits,
    getCurrentCount,
    updateLimiter,
    addToBlocklist,
    isIPBlocked,
    
    // Константы
    DEFAULT_LIMITS
};