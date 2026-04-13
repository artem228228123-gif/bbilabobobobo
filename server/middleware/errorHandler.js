/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/middleware/errorHandler.js
 * Описание: Глобальный обработчик ошибок, логирование, отправка уведомлений
 */

const { get, set, incr } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const ERROR_SEVERITY = {
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical'
};

const ERROR_CATEGORIES = {
    VALIDATION: 'validation',
    AUTHENTICATION: 'authentication',
    AUTHORIZATION: 'authorization',
    DATABASE: 'database',
    NETWORK: 'network',
    EXTERNAL_API: 'external_api',
    BUSINESS_LOGIC: 'business_logic',
    SYSTEM: 'system'
};

// ============================================
= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

/**
 * Определение категории ошибки
 * @param {Error} err - объект ошибки
 * @returns {string}
 */
function getErrorCategory(err) {
    if (err.name === 'ValidationError' || err.name === 'ValidatorError') {
        return ERROR_CATEGORIES.VALIDATION;
    }
    if (err.name === 'UnauthorizedError' || err.name === 'JsonWebTokenError') {
        return ERROR_CATEGORIES.AUTHENTICATION;
    }
    if (err.name === 'ForbiddenError') {
        return ERROR_CATEGORIES.AUTHORIZATION;
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        return ERROR_CATEGORIES.NETWORK;
    }
    if (err.code === '23505' || err.code === '23503' || err.code === '42P01') {
        return ERROR_CATEGORIES.DATABASE;
    }
    if (err.isAxiosError) {
        return ERROR_CATEGORIES.EXTERNAL_API;
    }
    return ERROR_CATEGORIES.SYSTEM;
}

/**
 * Определение severity ошибки
 * @param {Error} err - объект ошибки
 * @returns {string}
 */
function getErrorSeverity(err) {
    const category = getErrorCategory(err);
    const statusCode = err.status || err.statusCode || 500;
    
    if (statusCode >= 500) {
        return ERROR_SEVERITY.CRITICAL;
    }
    if (category === ERROR_CATEGORIES.DATABASE || category === ERROR_CATEGORIES.EXTERNAL_API) {
        return ERROR_SEVERITY.HIGH;
    }
    if (category === ERROR_CATEGORIES.AUTHENTICATION || category === ERROR_CATEGORIES.AUTHORIZATION) {
        return ERROR_SEVERITY.MEDIUM;
    }
    return ERROR_SEVERITY.LOW;
}

/**
 * Форматирование ошибки для логирования
 * @param {Error} err - объект ошибки
 * @param {Object} req - Express request
 * @returns {Object}
 */
function formatErrorForLogging(err, req) {
    return {
        timestamp: new Date().toISOString(),
        name: err.name,
        message: err.message,
        stack: err.stack,
        code: err.code,
        status: err.status || err.statusCode || 500,
        category: getErrorCategory(err),
        severity: getErrorSeverity(err),
        url: req?.originalUrl || req?.url,
        method: req?.method,
        ip: req?.ip || req?.connection?.remoteAddress,
        userId: req?.user?.id,
        userAgent: req?.headers?.['user-agent'],
        referer: req?.headers?.referer,
        query: req?.query,
        body: sanitizeBody(req?.body),
        params: req?.params
    };
}

/**
 * Санитизация тела запроса для логирования (удаление паролей)
 * @param {Object} body - тело запроса
 * @returns {Object}
 */
function sanitizeBody(body) {
    if (!body) return null;
    
    const sanitized = { ...body };
    const sensitiveFields = ['password', 'password_confirm', 'old_password', 'new_password', 'token', 'refresh_token'];
    
    for (const field of sensitiveFields) {
        if (sanitized[field]) {
            sanitized[field] = '[REDACTED]';
        }
    }
    
    return sanitized;
}

/**
 * Сохранение ошибки в базу данных
 * @param {Object} errorLog - отформатированная ошибка
 */
async function saveErrorToDatabase(errorLog) {
    try {
        const { query } = require('../../config/database');
        
        await query(
            `INSERT INTO error_logs (level, message, route, user_id, ip_address, user_agent, stack, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [
                errorLog.severity,
                errorLog.message,
                errorLog.url,
                errorLog.userId,
                errorLog.ip,
                errorLog.userAgent,
                errorLog.stack,
                JSON.stringify({
                    name: errorLog.name,
                    code: errorLog.code,
                    status: errorLog.status,
                    category: errorLog.category,
                    query: errorLog.query,
                    body: errorLog.body,
                    params: errorLog.params
                })
            ]
        );
    } catch (dbError) {
        console.error('Ошибка сохранения error log в БД:', dbError);
    }
}

/**
 * Отправка уведомления об ошибке
 * @param {Object} errorLog - отформатированная ошибка
 */
async function sendErrorNotification(errorLog) {
    if (errorLog.severity === ERROR_SEVERITY.CRITICAL || errorLog.severity === ERROR_SEVERITY.HIGH) {
        await addJob('notificationQueue', 'sendErrorAlert', {
            title: `🚨 ${errorLog.severity.toUpperCase()} ERROR`,
            message: `${errorLog.message}\n\nURL: ${errorLog.method} ${errorLog.url}\nIP: ${errorLog.ip}\nUser: ${errorLog.userId || 'guest'}`,
            stack: errorLog.stack,
            category: errorLog.category
        });
    }
}

/**
 * Инкремент счётчика ошибок для мониторинга
 * @param {Object} errorLog - отформатированная ошибка
 */
async function incrementErrorCounter(errorLog) {
    const key = `errors:${errorLog.category}:${errorLog.severity}`;
    await incr(key, 1);
    
    // Устанавливаем TTL на 24 часа
    const { set, ttl } = require('../../config/redis');
    if ((await ttl(key)) === -2) {
        await set(key, 1, 86400);
    }
}

// ============================================
= ОСНОВНЫЕ MIDDLEWARE
// ============================================

/**
 * Глобальный обработчик ошибок для Express
 */
function errorHandler(err, req, res, next) {
    // Форматируем ошибку
    const errorLog = formatErrorForLogging(err, req);
    
    // Логируем в консоль
    console.error(`[${errorLog.severity.toUpperCase()}] ${errorLog.message}`);
    if (errorLog.stack && config.app.isDevelopment) {
        console.error(errorLog.stack);
    }
    
    // Сохраняем в БД (асинхронно, не блокируем ответ)
    saveErrorToDatabase(errorLog).catch(console.error);
    
    // Отправляем уведомление (только для критических ошибок)
    sendErrorNotification(errorLog).catch(console.error);
    
    // Инкрементируем счётчик
    incrementErrorCounter(errorLog).catch(console.error);
    
    // Определяем статус ответа
    const status = err.status || err.statusCode || 500;
    
    // Формируем ответ клиенту
    const response = {
        error: err.message || 'Внутренняя ошибка сервера',
        status: status,
        timestamp: new Date().toISOString()
    };
    
    // Добавляем stack trace только в development режиме
    if (config.app.isDevelopment && err.stack) {
        response.stack = err.stack;
    }
    
    // Отправляем ответ
    res.status(status).json(response);
}

/**
 * Обработчик 404 ошибок (маршрут не найден)
 */
function notFoundHandler(req, res, next) {
    const error = new Error(`Маршрут ${req.method} ${req.originalUrl} не найден`);
    error.status = 404;
    error.name = 'NotFoundError';
    next(error);
}

/**
 * Асинхронный wrapper для обработки ошибок в async/await
 * @param {Function} fn - асинхронная функция
 * @returns {Function}
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

// ============================================
= СПЕЦИАЛИЗИРОВАННЫЕ ОБРАБОТЧИКИ
// ============================================

/**
 * Обработчик ошибок валидации
 */
function validationErrorHandler(err, req, res, next) {
    if (err.name === 'ValidationError' || err.name === 'ValidatorError') {
        const errors = {};
        
        if (err.errors) {
            for (const field in err.errors) {
                errors[field] = err.errors[field].message;
            }
        }
        
        return res.status(400).json({
            error: 'Ошибка валидации',
            errors,
            timestamp: new Date().toISOString()
        });
    }
    next(err);
}

/**
 * Обработчик ошибок аутентификации
 */
function authErrorHandler(err, req, res, next) {
    if (err.name === 'UnauthorizedError' || err.name === 'JsonWebTokenError') {
        return res.status(401).json({
            error: 'Не авторизован',
            message: err.message,
            timestamp: new Date().toISOString()
        });
    }
    next(err);
}

/**
 * Обработчик ошибок авторизации
 */
function forbiddenErrorHandler(err, req, res, next) {
    if (err.name === 'ForbiddenError' || err.status === 403) {
        return res.status(403).json({
            error: 'Доступ запрещён',
            message: err.message || 'У вас недостаточно прав для выполнения этого действия',
            timestamp: new Date().toISOString()
        });
    }
    next(err);
}

/**
 * Обработчик ошибок базы данных
 */
function databaseErrorHandler(err, req, res, next) {
    // PostgreSQL ошибки
    if (err.code) {
        // Unique violation
        if (err.code === '23505') {
            return res.status(409).json({
                error: 'Конфликт данных',
                message: 'Запись с такими данными уже существует',
                timestamp: new Date().toISOString()
            });
        }
        
        // Foreign key violation
        if (err.code === '23503') {
            return res.status(400).json({
                error: 'Ошибка ссылочной целостности',
                message: 'Связанная запись не найдена',
                timestamp: new Date().toISOString()
            });
        }
        
        // Not null violation
        if (err.code === '23502') {
            return res.status(400).json({
                error: 'Ошибка валидации',
                message: 'Обязательное поле не заполнено',
                timestamp: new Date().toISOString()
            });
        }
    }
    next(err);
}

/**
 * Обработчик ошибок rate limiting
 */
function rateLimitErrorHandler(err, req, res, next) {
    if (err.name === 'RateLimitError' || err.status === 429) {
        return res.status(429).json({
            error: 'Слишком много запросов',
            message: err.message || 'Пожалуйста, подождите перед следующим запросом',
            retryAfter: err.retryAfter || 60,
            timestamp: new Date().toISOString()
        });
    }
    next(err);
}

// ============================================
= МОНИТОРИНГ
// ============================================

/**
 * Получение статистики ошибок
 */
async function getErrorStats() {
    const { query } = require('../../config/database');
    
    const result = await query(`
        SELECT 
            level,
            COUNT(*) as count,
            DATE(created_at) as date
        FROM error_logs
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY level, DATE(created_at)
        ORDER BY date DESC, count DESC
    `);
    
    return result.rows;
}

/**
 * Очистка старых логов ошибок
 */
async function cleanupOldErrorLogs(days = 30) {
    const { query } = require('../../config/database');
    
    const result = await query(
        `DELETE FROM error_logs WHERE created_at < NOW() - INTERVAL '${days} days'`
    );
    
    console.log(`🧹 Очищено ${result.rowCount} старых записей error_logs`);
    return result.rowCount;
}

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    // Основные middleware
    errorHandler,
    notFoundHandler,
    asyncHandler,
    
    // Специализированные обработчики
    validationErrorHandler,
    authErrorHandler,
    forbiddenErrorHandler,
    databaseErrorHandler,
    rateLimitErrorHandler,
    
    // Утилиты
    getErrorCategory,
    getErrorSeverity,
    formatErrorForLogging,
    sanitizeBody,
    saveErrorToDatabase,
    sendErrorNotification,
    incrementErrorCounter,
    getErrorStats,
    cleanupOldErrorLogs,
    
    // Константы
    ERROR_SEVERITY,
    ERROR_CATEGORIES
};