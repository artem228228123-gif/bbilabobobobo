/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/middleware/rateLimit.js
 * Описание: Middleware для ограничения частоты запросов
 */

const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const { redis } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// НАСТРОЙКА STORE
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
}

// ============================================
= ЛИМИТЕРЫ
// ============================================

/**
 * Глобальный лимитер (все запросы)
 */
const globalLimiter = rateLimit({
    store: redisStore,
    windowMs: 15 * 60 * 1000,  // 15 минут
    max: 100,                   // 100 запросов
    message: {
        error: 'Слишком много запросов. Попробуйте позже.',
        retryAfter: 15 * 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const ip = req.ip || req.connection.remoteAddress;
        const ua = req.headers['user-agent'] || 'unknown';
        return `${ip}:${ua.substring(0, 50)}`;
    },
    skip: (req) => {
        // Пропускаем health check
        if (req.path === '/health' || req.path === '/ping') return true;
        // Пропускаем запросы от админов с специальным ключом
        if (req.headers['x-admin-key'] === process.env.ADMIN_API_KEY) return true;
        return false;
    }
});

/**
 * API лимитер (для /api/*)
 */
const apiLimiter = rateLimit({
    store: redisStore,
    windowMs: 60 * 1000,       // 1 минута
    max: 60,                    // 60 запросов
    message: {
        error: 'Превышен лимит запросов к API',
        retryAfter: 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const token = req.headers.authorization?.split(' ')[1];
        if (token) return `user:${token.substring(0, 20)}`;
        return req.ip || req.connection.remoteAddress;
    },
    skip: (req) => {
        if (req.user?.role === 'admin') return true;
        return false;
    }
});

/**
 * Лимитер для аутентификации (логин, регистрация)
 */
const authLimiter = rateLimit({
    store: redisStore,
    windowMs: 15 * 60 * 1000,  // 15 минут
    max: 5,                     // 5 попыток
    message: {
        error: 'Слишком много попыток входа. Попробуйте через 15 минут.',
        retryAfter: 15 * 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
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
    windowMs: 60 * 60 * 1000,  // 1 час
    max: 3,                     // 3 регистрации с одного IP
    message: {
        error: 'Слишком много регистраций с этого IP',
        retryAfter: 60 * 60
    },
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
    windowMs: 60 * 60 * 1000,  // 1 час
    max: 3,                     // 3 запроса
    message: {
        error: 'Слишком много запросов на восстановление пароля',
        retryAfter: 60 * 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const email = req.body.email || 'unknown';
        const ip = req.ip || req.connection.remoteAddress;
        return `reset:${email}:${ip}`;
    }
});

/**
 * Лимитер для создания объявлений
 */
const listingCreateLimiter = rateLimit({
    store: redisStore,
    windowMs: 60 * 60 * 1000,  // 1 час
    max: 10,                    // 10 объявлений
    message: {
        error: 'Слишком много объявлений. Подождите немного.',
        retryAfter: 60 * 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user?.id) return `user:${req.user.id}`;
        return req.ip || req.connection.remoteAddress;
    }
});

/**
 * Лимитер для отправки сообщений
 */
const messageSendLimiter = rateLimit({
    store: redisStore,
    windowMs: 60 * 1000,       // 1 минута
    max: 30,                    // 30 сообщений
    message: {
        error: 'Слишком много сообщений. Подождите немного.',
        retryAfter: 60
    },
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
    windowMs: 60 * 1000,       // 1 минута
    max: 20,                    // 20 поисковых запросов
    message: {
        error: 'Слишком много поисковых запросов',
        retryAfter: 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user?.id) return `user:${req.user.id}`;
        return req.ip || req.connection.remoteAddress;
    },
    skip: (req) => {
        if (req.path.includes('/suggest')) return true;
        return false;
    }
});

/**
 * Лимитер для загрузки файлов
 */
const uploadLimiter = rateLimit({
    store: redisStore,
    windowMs: 60 * 60 * 1000,  // 1 час
    max: 50,                    // 50 загрузок
    message: {
        error: 'Слишком много загрузок файлов',
        retryAfter: 60 * 60
    },
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
    windowMs: 60 * 1000,       // 1 минута
    max: 30,                    // 30 лайков
    message: {
        error: 'Слишком много лайков',
        retryAfter: 60
    },
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
    windowMs: 60 * 60 * 1000,  // 1 час
    max: 10,                    // 10 отзывов
    message: {
        error: 'Слишком много отзывов',
        retryAfter: 60 * 60
    },
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
    windowMs: 60 * 1000,       // 1 минута
    max: 100,                   // 100 запросов
    message: {
        error: 'Превышен лимит запросов к админ-панели',
        retryAfter: 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user?.id) return `admin:${req.user.id}`;
        return req.ip || req.connection.remoteAddress;
    },
    skip: (req) => {
        if (req.user?.role === 'superadmin') return true;
        return false;
    }
});

/**
 * Строгий лимитер (для чувствительных операций)
 */
const strictLimiter = rateLimit({
    store: redisStore,
    windowMs: 60 * 60 * 1000,  // 1 час
    max: 3,                     // 3 попытки
    message: {
        error: 'Слишком много попыток. Попробуйте через час.',
        retryAfter: 60 * 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user?.id) return `strict:${req.user.id}`;
        return `strict:${req.ip}`;
    }
});

/**
 * Лимитер для API ключей (партнёры)
 */
const apiKeyLimiter = rateLimit({
    store: redisStore,
    windowMs: 60 * 1000,       // 1 минута
    max: 300,                   // 300 запросов
    message: {
        error: 'Превышен лимит запросов для вашего API ключа',
        retryAfter: 60
    },
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
 * Лимитер для вебхуков
 */
const webhookLimiter = rateLimit({
    store: redisStore,
    windowMs: 60 * 1000,       // 1 минута
    max: 10,                    // 10 вебхуков
    message: {
        error: 'Слишком много вебхуков',
        retryAfter: 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const provider = req.body?.provider || 'unknown';
        return `webhook:${provider}`;
    }
});

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    globalLimiter,
    apiLimiter,
    authLimiter,
    registrationLimiter,
    passwordResetLimiter,
    listingCreateLimiter,
    messageSendLimiter,
    searchLimiter,
    uploadLimiter,
    likeLimiter,
    reviewLimiter,
    adminLimiter,
    strictLimiter,
    apiKeyLimiter,
    webhookLimiter
};