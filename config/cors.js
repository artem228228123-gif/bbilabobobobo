/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: config/cors.js
 * Описание: Настройки CORS (Cross-Origin Resource Sharing) для безопасности API
 */

const { config } = require('./env');

// ============================================
// КОНСТАНТЫ
// ============================================

// Допустимые источники (origins) для разных окружений
const ALLOWED_ORIGINS = {
    development: [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:5173',
        'http://localhost:8080',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3001',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:8080',
        'http://192.168.1.*:3000',
        'http://192.168.1.*:3001',
        'https://localhost:3000'
    ],
    production: [
        'https://aida.ru',
        'https://www.aida.ru',
        'https://api.aida.ru',
        'https://admin.aida.ru',
        'https://cdn.aida.ru',
        'https://aida.com',
        'https://www.aida.com',
        'https://api.aida.com',
        'https://aida-market.ru',
        'https://www.aida-market.ru'
    ],
    staging: [
        'https://staging.aida.ru',
        'https://test.aida.ru',
        'https://dev.aida.ru',
        'https://beta.aida.ru'
    ]
};

// Допустимые HTTP методы
const ALLOWED_METHODS = [
    'GET',
    'POST',
    'PUT',
    'DELETE',
    'PATCH',
    'OPTIONS',
    'HEAD'
];

// Допустимые заголовки запроса
const ALLOWED_HEADERS = [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'X-CSRF-Token',
    'X-API-Key',
    'X-User-ID',
    'X-Session-ID',
    'X-Request-ID',
    'X-Forwarded-For',
    'X-Real-IP',
    'User-Agent',
    'Referer',
    'Cookie',
    'X-Lang',
    'X-Timezone',
    'X-App-Version',
    'X-Platform'
];

// Заголовки, которые будут видны клиенту
const EXPOSED_HEADERS = [
    'Content-Disposition',
    'X-Total-Count',
    'X-Page',
    'X-Limit',
    'X-Has-More',
    'X-Request-ID',
    'X-Response-Time',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset'
];

// ============================================
= ОСНОВНЫЕ НАСТРОЙКИ CORS
// ============================================

/**
 * Проверка, разрешён ли источник
 * @param {string} origin - источник запроса
 * @returns {boolean}
 */
function isOriginAllowed(origin) {
    if (!origin) return false;
    
    const env = config.app.env || 'development';
    const allowedOrigins = ALLOWED_ORIGINS[env] || ALLOWED_ORIGINS.development;
    
    // Проверка точного совпадения
    if (allowedOrigins.includes(origin)) {
        return true;
    }
    
    // Проверка для локальных IP с маской (192.168.1.*)
    if (origin.includes('192.168.1.')) {
        const ipPattern = /^http:\/\/192\.168\.1\.\d+:\d+$/;
        if (ipPattern.test(origin)) {
            return true;
        }
    }
    
    // Проверка для localhost с разными портами
    if (origin.includes('localhost') && origin.startsWith('http://localhost:')) {
        const port = parseInt(origin.split(':')[2]);
        if (port >= 3000 && port <= 9999) {
            return true;
        }
    }
    
    return false;
}

/**
 * Получение CORS настроек в зависимости от окружения
 * @returns {Object}
 */
function getCorsOptions() {
    const env = config.app.env || 'development';
    const isProduction = env === 'production';
    
    const options = {
        origin: (origin, callback) => {
            // Разрешаем запросы без origin (например, от мобильных приложений)
            if (!origin) {
                return callback(null, true);
            }
            
            if (isOriginAllowed(origin) || !isProduction) {
                callback(null, true);
            } else {
                callback(new Error(`CORS policy: Origin ${origin} not allowed`));
            }
        },
        methods: ALLOWED_METHODS,
        allowedHeaders: ALLOWED_HEADERS,
        exposedHeaders: EXPOSED_HEADERS,
        credentials: true,              // Разрешаем отправку куки
        maxAge: 86400,                  // Кеширование preflight запроса на 24 часа
        preflightContinue: false,
        optionsSuccessStatus: 204
    };
    
    return options;
}

// ============================================
= ДИНАМИЧЕСКИЕ НАСТРОЙКИ
// ============================================

/**
 * Настройки CORS для статических файлов (CDN)
 */
const staticCorsOptions = {
    origin: (origin, callback) => {
        // Для статики разрешаем все источники
        callback(null, true);
    },
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Range', 'If-Range', 'If-Modified-Since', 'If-None-Match'],
    exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified'],
    credentials: false,
    maxAge: 86400
};

/**
 * Настройки CORS для загрузки файлов (более строгие)
 */
const uploadCorsOptions = {
    origin: isOriginAllowed,
    methods: ['POST', 'PUT', 'OPTIONS'],
    allowedHeaders: [...ALLOWED_HEADERS, 'Content-Range', 'Content-Disposition'],
    exposedHeaders: [...EXPOSED_HEADERS, 'Location', 'Content-Range'],
    credentials: true,
    maxAge: 3600
};

/**
 * Настройки CORS для WebSocket
 */
const websocketCorsOptions = {
    origin: isOriginAllowed,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [...ALLOWED_HEADERS, 'Sec-WebSocket-Protocol', 'Sec-WebSocket-Extensions'],
    credentials: true
};

/**
 * Настройки CORS для публичного API (менее строгие)
 */
const publicApiCorsOptions = {
    origin: (origin, callback) => {
        // Для публичного API разрешаем все источники
        callback(null, true);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
    exposedHeaders: EXPOSED_HEADERS,
    credentials: false,
    maxAge: 3600
};

/**
 * Настройки CORS для админ-панели (самые строгие)
 */
const adminCorsOptions = {
    origin: (origin, callback) => {
        const allowedAdminOrigins = [
            'https://admin.aida.ru',
            'https://admin.aida.com',
            'http://localhost:3000',
            'http://localhost:3001'
        ];
        
        if (allowedAdminOrigins.includes(origin) || !config.app.isProduction) {
            callback(null, true);
        } else {
            callback(new Error('CORS policy: Admin access denied'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [...ALLOWED_HEADERS, 'X-Admin-Key', 'X-Admin-Token'],
    exposedHeaders: EXPOSED_HEADERS,
    credentials: true,
    maxAge: 3600
};

// ============================================
= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

/**
 * Добавление динамических CORS заголовков в ответ
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
function dynamicCorsHandler(req, res, next) {
    const origin = req.headers.origin;
    const path = req.path;
    
    // Определяем тип запроса и выбираем соответствующие настройки
    let corsConfig;
    
    if (path.startsWith('/uploads/') || path.startsWith('/cdn/')) {
        corsConfig = staticCorsOptions;
    } else if (path.startsWith('/api/v1/upload')) {
        corsConfig = uploadCorsOptions;
    } else if (path.startsWith('/socket.io')) {
        corsConfig = websocketCorsOptions;
    } else if (path.startsWith('/api/v1/public')) {
        corsConfig = publicApiCorsOptions;
    } else if (path.startsWith('/admin')) {
        corsConfig = adminCorsOptions;
    } else {
        corsConfig = getCorsOptions();
    }
    
    // Проверяем origin
    if (corsConfig.origin === true || (typeof corsConfig.origin === 'function' && corsConfig.origin(origin, () => {}))) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Access-Control-Allow-Methods', corsConfig.methods.join(','));
        res.setHeader('Access-Control-Allow-Headers', corsConfig.allowedHeaders.join(','));
        
        if (corsConfig.exposedHeaders) {
            res.setHeader('Access-Control-Expose-Headers', corsConfig.exposedHeaders.join(','));
        }
        
        if (corsConfig.credentials) {
            res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
        
        if (corsConfig.maxAge) {
            res.setHeader('Access-Control-Max-Age', corsConfig.maxAge);
        }
    }
    
    // Обработка preflight запросов
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    
    next();
}

/**
 * Добавление security заголовков
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
function securityHeadersHandler(req, res, next) {
    // X-Content-Type-Options
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // X-Frame-Options (защита от clickjacking)
    res.setHeader('X-Frame-Options', 'DENY');
    
    // X-XSS-Protection
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Referrer-Policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    
    // Permissions-Policy
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    
    // Cache-Control для API
    if (req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    }
    
    next();
}

/**
 * Добавление CORS заголовков для конкретного источника
 * @param {Object} res - Express response
 * @param {string} origin - источник
 */
function setCorsHeaders(res, origin) {
    if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
}

/**
 * Получение списка разрешённых источников для текущего окружения
 * @returns {Array}
 */
function getAllowedOrigins() {
    const env = config.app.env || 'development';
    return ALLOWED_ORIGINS[env] || ALLOWED_ORIGINS.development;
}

/**
 * Добавление источника в список разрешённых (динамически)
 * @param {string} origin - источник для добавления
 */
function addAllowedOrigin(origin) {
    const env = config.app.env || 'development';
    if (!ALLOWED_ORIGINS[env].includes(origin)) {
        ALLOWED_ORIGINS[env].push(origin);
    }
}

/**
 * Удаление источника из списка разрешённых
 * @param {string} origin - источник для удаления
 */
function removeAllowedOrigin(origin) {
    const env = config.app.env || 'development';
    const index = ALLOWED_ORIGINS[env].indexOf(origin);
    if (index !== -1) {
        ALLOWED_ORIGINS[env].splice(index, 1);
    }
}

/**
 * Проверка, является ли запрос кросс-доменным
 * @param {Object} req - Express request
 * @returns {boolean}
 */
function isCrossOrigin(req) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    
    if (!origin) return false;
    
    // Извлекаем домен из origin
    const originDomain = origin.replace(/^https?:\/\//, '').split(':')[0];
    const hostDomain = host.split(':')[0];
    
    return originDomain !== hostDomain;
}

/**
 * Логирование CORS ошибок
 * @param {string} origin - источник
 * @param {string} method - HTTP метод
 * @param {string} path - путь
 */
function logCorsError(origin, method, path) {
    console.warn(`⚠️ CORS Error: Origin "${origin}" not allowed. Method: ${method}, Path: ${path}`);
    
    // Здесь можно добавить отправку в систему мониторинга
    // await addJob('analyticsQueue', 'logCorsError', { origin, method, path });
}

// ============================================
= MIDDLEWARE ДЛЯ EXPRESS
// ============================================

/**
 * Глобальный CORS middleware
 */
const corsMiddleware = (req, res, next) => {
    const origin = req.headers.origin;
    
    if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS.join(','));
        res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS.join(','));
        res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS.join(','));
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Max-Age', '86400');
    } else if (origin) {
        logCorsError(origin, req.method, req.path);
    }
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    
    next();
};

/**
 * CORS middleware для WebSocket
 */
const websocketCorsMiddleware = (socket, next) => {
    const origin = socket.handshake.headers.origin;
    
    if (origin && isOriginAllowed(origin)) {
        next();
    } else {
        next(new Error('CORS error: Origin not allowed'));
    }
};

/**
 * CORS middleware для загрузки файлов
 */
const uploadCorsMiddleware = (req, res, next) => {
    const origin = req.headers.origin;
    
    if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, PUT, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', [...ALLOWED_HEADERS, 'Content-Range'].join(','));
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    
    next();
};

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    // Основные настройки
    getCorsOptions,
    corsMiddleware,
    dynamicCorsHandler,
    securityHeadersHandler,
    
    // Специализированные middleware
    websocketCorsMiddleware,
    uploadCorsMiddleware,
    
    // Настройки для разных типов
    staticCorsOptions,
    uploadCorsOptions,
    websocketCorsOptions,
    publicApiCorsOptions,
    adminCorsOptions,
    
    // Утилиты
    isOriginAllowed,
    setCorsHeaders,
    getAllowedOrigins,
    addAllowedOrigin,
    removeAllowedOrigin,
    isCrossOrigin,
    logCorsError,
    
    // Константы
    ALLOWED_ORIGINS,
    ALLOWED_METHODS,
    ALLOWED_HEADERS,
    EXPOSED_HEADERS
};