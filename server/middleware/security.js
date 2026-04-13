/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/middleware/security.js
 * Описание: Middleware для безопасности (защита от XSS, CSRF, SQL инъекций, DDoS)
 */

const helmet = require('helmet');
const crypto = require('crypto');
const { get, set, incr } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const CSRF_TOKEN_HEADER = 'X-CSRF-Token';
const CSRF_TOKEN_COOKIE = 'csrf-token';
const CSRF_TOKEN_TTL = 3600; // 1 час

// ============================================
= HELMET НАСТРОЙКИ
// ============================================

/**
 * Настройки Helmet для безопасности HTTP заголовков
 */
const helmetConfig = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.socket.io"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'", "wss:", "https:"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: []
        }
    },
    hsts: {
        maxAge: 31536000, // 1 год
        includeSubDomains: true,
        preload: true
    },
    xFrameOptions: { action: 'deny' },
    xContentTypeOptions: true,
    xXssProtection: { action: 'block' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
});

// ============================================
= CSRF ЗАЩИТА
// ============================================

/**
 * Генерация CSRF токена
 * @returns {string}
 */
function generateCSRFToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Middleware для генерации CSRF токена
 */
function csrfTokenMiddleware(req, res, next) {
    // Пропускаем GET, HEAD, OPTIONS запросы
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const token = generateCSRFToken();
        res.cookie(CSRF_TOKEN_COOKIE, token, {
            httpOnly: false,
            secure: config.app.isProduction,
            sameSite: 'lax',
            maxAge: CSRF_TOKEN_TTL * 1000
        });
        res.locals.csrfToken = token;
        return next();
    }
    next();
}

/**
 * Middleware для проверки CSRF токена
 */
function csrfProtectionMiddleware(req, res, next) {
    // Пропускаем GET, HEAD, OPTIONS запросы
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }
    
    const tokenFromCookie = req.cookies[CSRF_TOKEN_COOKIE];
    const tokenFromHeader = req.headers[CSRF_TOKEN_HEADER];
    
    if (!tokenFromCookie || !tokenFromHeader || tokenFromCookie !== tokenFromHeader) {
        return res.status(403).json({
            error: 'CSRF token validation failed',
            message: 'Неверный или отсутствующий CSRF токен'
        });
    }
    
    next();
}

// ============================================
= ЗАЩИТА ОТ SQL ИНЪЕКЦИЙ
// ============================================

/**
 * Базовое экранирование для предотвращения SQL инъекций
 * @param {string} input - входная строка
 * @returns {string}
 */
function sanitizeSqlInput(input) {
    if (typeof input !== 'string') return input;
    
    return input
        .replace(/['"]/g, '')
        .replace(/--/g, '')
        .replace(/;/g, '')
        .replace(/\/\*/g, '')
        .replace(/\*\//g, '')
        .replace(/\\/g, '');
}

/**
 * Middleware для санитизации входных параметров
 */
function sqlInjectionProtection(req, res, next) {
    // Санитизация query параметров
    if (req.query) {
        for (const key in req.query) {
            if (typeof req.query[key] === 'string') {
                req.query[key] = sanitizeSqlInput(req.query[key]);
            }
        }
    }
    
    // Санитизация body параметров
    if (req.body) {
        for (const key in req.body) {
            if (typeof req.body[key] === 'string') {
                // Пропускаем поля, которые могут содержать HTML (описания, сообщения)
                const skipFields = ['description', 'text', 'message', 'content', 'bio', 'comment'];
                if (!skipFields.includes(key)) {
                    req.body[key] = sanitizeSqlInput(req.body[key]);
                }
            }
        }
    }
    
    // Санитизация params
    if (req.params) {
        for (const key in req.params) {
            if (typeof req.params[key] === 'string') {
                req.params[key] = sanitizeSqlInput(req.params[key]);
            }
        }
    }
    
    next();
}

// ============================================
= ЗАЩИТА ОТ XSS
// ============================================

/**
 * Экранирование HTML символов
 * @param {string} input - входная строка
 * @returns {string}
 */
function escapeHtml(input) {
    if (typeof input !== 'string') return input;
    
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Middleware для защиты от XSS
 */
function xssProtection(req, res, next) {
    // Экранирование для вывода (будет использовано при рендеринге)
    res.locals.escapeHtml = escapeHtml;
    
    // Валидация входных данных
    if (req.body) {
        for (const key in req.body) {
            if (typeof req.body[key] === 'string') {
                // Проверяем наличие потенциально опасных тегов
                const dangerousPatterns = [
                    /<script/i,
                    /javascript:/i,
                    /onload=/i,
                    /onerror=/i,
                    /onclick=/i,
                    /onmouseover=/i
                ];
                
                for (const pattern of dangerousPatterns) {
                    if (pattern.test(req.body[key])) {
                        return res.status(400).json({
                            error: 'Potential XSS attack detected',
                            message: 'Обнаружены запрещённые символы в запросе'
                        });
                    }
                }
            }
        }
    }
    
    next();
}

// ============================================
= ЗАЩИТА ОТ DDoS
// ============================================

/**
 * Middleware для ограничения количества запросов с одного IP
 */
async function ddosProtection(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const key = `ddos:${ip}`;
    const limit = 200; // 200 запросов в минуту
    const windowMs = 60000; // 1 минута
    
    try {
        const current = await incr(key, 1);
        
        if (current === 1) {
            const { set, expire } = require('../../config/redis');
            await set(key, 1);
            await expire(key, Math.ceil(windowMs / 1000));
        }
        
        if (current > limit) {
            return res.status(429).json({
                error: 'Too Many Requests',
                message: 'Превышен лимит запросов. Пожалуйста, подождите.',
                retryAfter: Math.ceil(windowMs / 1000)
            });
        }
        
        next();
    } catch (error) {
        console.error('DDoS protection error:', error);
        next();
    }
}

// ============================================
= ЗАЩИТА ОТ BRUTE FORCE
// ============================================

/**
 * Middleware для защиты от брутфорса
 * @param {number} maxAttempts - максимальное количество попыток
 * @param {number} blockMinutes - время блокировки в минутах
 */
function bruteForceProtection(maxAttempts = 5, blockMinutes = 15) {
    return async (req, res, next) => {
        const ip = req.ip || req.connection.remoteAddress;
        const key = `bruteforce:${ip}`;
        const blockKey = `bruteforce:blocked:${ip}`;
        
        try {
            const { get, set, incr, expire, ttl } = require('../../config/redis');
            
            // Проверяем, не заблокирован ли IP
            const isBlocked = await get(blockKey);
            if (isBlocked) {
                const remainingTime = await ttl(blockKey);
                return res.status(429).json({
                    error: 'Too Many Attempts',
                    message: `Слишком много неудачных попыток. Попробуйте через ${Math.ceil(remainingTime / 60)} минут.`
                });
            }
            
            const attempts = await incr(key, 1);
            
            if (attempts === 1) {
                await expire(key, 60 * 60); // 1 час
            }
            
            if (attempts > maxAttempts) {
                await set(blockKey, 1, blockMinutes * 60);
                await set(key, 0);
                return res.status(429).json({
                    error: 'Too Many Attempts',
                    message: `Слишком много неудачных попыток. Аккаунт заблокирован на ${blockMinutes} минут.`
                });
            }
            
            next();
        } catch (error) {
            console.error('Brute force protection error:', error);
            next();
        }
    };
}

// ============================================
= ЗАЩИТА ОТ USER-AGENT
// ============================================

const BLOCKED_USER_AGENTS = [
    'curl',
    'wget',
    'python-requests',
    'Go-http-client',
    'Java',
    'Apache-HttpClient',
    'nikto',
    'sqlmap',
    'nmap',
    'masscan',
    'zgrab'
];

/**
 * Middleware для блокировки подозрительных User-Agent
 */
function userAgentProtection(req, res, next) {
    const userAgent = req.headers['user-agent'] || '';
    
    for (const blocked of BLOCKED_USER_AGENTS) {
        if (userAgent.toLowerCase().includes(blocked.toLowerCase())) {
            console.warn(`Blocked suspicious User-Agent: ${userAgent} from IP: ${req.ip}`);
            return res.status(403).json({
                error: 'Access Denied',
                message: 'Доступ запрещён'
            });
        }
    }
    
    next();
}

// ============================================
= ЗАЩИТА ОТ REFERRER SPAM
// ============================================

/**
 * Middleware для проверки Referrer
 */
function referrerProtection(allowedDomains = ['aida.ru', 'aida.com']) {
    return (req, res, next) => {
        // Пропускаем API запросы
        if (req.path.startsWith('/api/')) {
            return next();
        }
        
        const referrer = req.headers.referer || '';
        
        if (referrer) {
            let isAllowed = false;
            for (const domain of allowedDomains) {
                if (referrer.includes(domain)) {
                    isAllowed = true;
                    break;
                }
            }
            
            if (!isAllowed && config.app.isProduction) {
                console.warn(`Blocked request from suspicious referrer: ${referrer} from IP: ${req.ip}`);
                return res.status(403).json({
                    error: 'Access Denied',
                    message: 'Доступ запрещён'
                });
            }
        }
        
        next();
    };
}

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    // Helmet
    helmetConfig,
    
    // CSRF
    csrfTokenMiddleware,
    csrfProtectionMiddleware,
    generateCSRFToken,
    
    // SQL инъекции
    sqlInjectionProtection,
    sanitizeSqlInput,
    
    // XSS
    xssProtection,
    escapeHtml,
    
    // DDoS
    ddosProtection,
    
    // Brute Force
    bruteForceProtection,
    
    // User-Agent
    userAgentProtection,
    
    // Referrer
    referrerProtection,
    
    // Константы
    CSRF_TOKEN_HEADER,
    CSRF_TOKEN_COOKIE,
    BLOCKED_USER_AGENTS
};