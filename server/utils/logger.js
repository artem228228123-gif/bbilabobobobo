/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/utils/logger.js
 * Описание: Логирование (консоль, файлы, уровни, ротация)
 */

const fs = require('fs');
const path = require('path');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const { getClientIp } = require('./helpers');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const LOG_DIR = path.join(__dirname, '../../logs');
const LOG_LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4
};

const LOG_COLORS = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'blue'
};

// Создаём директорию для логов
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ============================================
= ФОРМАТЫ
// ============================================

/**
 * Формат для консоли (цветной)
 */
const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.colorize({ all: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let msg = `${timestamp} [${level}]: ${message}`;
        if (Object.keys(meta).length > 0 && meta.stack) {
            msg += `\n${meta.stack}`;
        } else if (Object.keys(meta).length > 0) {
            msg += `\n${JSON.stringify(meta, null, 2)}`;
        }
        return msg;
    })
);

/**
 * Формат для файлов (JSON)
 */
const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

/**
 * Формат для access логов
 */
const accessFormat = winston.format.printf(({ timestamp, method, url, status, responseTime, ip, userAgent }) => {
    return `${timestamp} ${ip} "${method} ${url}" ${status} ${responseTime}ms "${userAgent}"`;
});

// ============================================
= ТРАНСПОРТЫ
// ============================================

// Консольный транспорт
const consoleTransport = new winston.transports.Console({
    level: config.app.isDevelopment ? 'debug' : 'info',
    format: consoleFormat
});

// Файловый транспорт для ошибок
const errorFileTransport = new DailyRotateFile({
    level: 'error',
    filename: path.join(LOG_DIR, 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '30d',
    format: fileFormat,
    zippedArchive: true
});

// Файловый транспорт для всех логов
const combinedFileTransport = new DailyRotateFile({
    level: 'info',
    filename: path.join(LOG_DIR, 'combined-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '30d',
    format: fileFormat,
    zippedArchive: true
});

// Файловый транспорт для debug логов (только разработка)
let debugFileTransport = null;
if (config.app.isDevelopment) {
    debugFileTransport = new DailyRotateFile({
        level: 'debug',
        filename: path.join(LOG_DIR, 'debug-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '7d',
        format: fileFormat,
        zippedArchive: true
    });
}

// Транспорт для access логов
const accessFileTransport = new DailyRotateFile({
    filename: path.join(LOG_DIR, 'access-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '50m',
    maxFiles: '30d',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        accessFormat
    ),
    zippedArchive: true
});

// ============================================
= СОЗДАНИЕ ЛОГГЕРА
// ============================================

const transports = [
    consoleTransport,
    errorFileTransport,
    combinedFileTransport
];

if (debugFileTransport) {
    transports.push(debugFileTransport);
}

const logger = winston.createLogger({
    levels: LOG_LEVELS,
    format: fileFormat,
    transports,
    exitOnError: false
});

// Access логгер (отдельный для HTTP запросов)
const accessLogger = winston.createLogger({
    transports: [accessFileTransport],
    exitOnError: false
});

// ============================================
= MIDDLEWARE ДЛЯ HTTP ЗАПРОСОВ
// ============================================

/**
 * Middleware для логирования HTTP запросов
 */
function httpLogger(req, res, next) {
    const start = Date.now();
    
    res.on('finish', () => {
        const responseTime = Date.now() - start;
        const ip = getClientIp(req);
        const userAgent = req.headers['user-agent'] || '-';
        
        accessLogger.info({
            method: req.method,
            url: req.originalUrl,
            status: res.statusCode,
            responseTime,
            ip,
            userAgent
        });
    });
    
    next();
}

// ============================================
= ОСНОВНЫЕ ФУНКЦИИ ЛОГГИРОВАНИЯ
// ============================================

/**
 * Логирование ошибки
 * @param {string} message - сообщение
 * @param {Object} meta - метаданные
 */
function error(message, meta = {}) {
    logger.error(message, meta);
}

/**
 * Логирование предупреждения
 * @param {string} message - сообщение
 * @param {Object} meta - метаданные
 */
function warn(message, meta = {}) {
    logger.warn(message, meta);
}

/**
 * Логирование информации
 * @param {string} message - сообщение
 * @param {Object} meta - метаданные
 */
function info(message, meta = {}) {
    logger.info(message, meta);
}

/**
 * Логирование HTTP запросов
 * @param {string} message - сообщение
 * @param {Object} meta - метаданные
 */
function http(message, meta = {}) {
    logger.http(message, meta);
}

/**
 * Логирование отладки
 * @param {string} message - сообщение
 * @param {Object} meta - метаданные
 */
function debug(message, meta = {}) {
    logger.debug(message, meta);
}

// ============================================
= СПЕЦИАЛИЗИРОВАННОЕ ЛОГИРОВАНИЕ
// ============================================

/**
 * Логирование ошибки API
 * @param {Error} err - ошибка
 * @param {Object} req - Express request
 */
function logApiError(err, req) {
    const errorLog = {
        message: err.message,
        stack: err.stack,
        url: req.originalUrl,
        method: req.method,
        ip: getClientIp(req),
        userId: req.user?.id,
        userAgent: req.headers['user-agent'],
        body: sanitizeBodyForLog(req.body),
        query: req.query,
        params: req.params
    };
    
    error(err.message, errorLog);
}

/**
 * Логирование успешного API запроса
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {number} responseTime - время ответа
 */
function logApiSuccess(req, res, responseTime) {
    const successLog = {
        url: req.originalUrl,
        method: req.method,
        status: res.statusCode,
        responseTime,
        userId: req.user?.id
    };
    
    info(`API ${req.method} ${req.originalUrl}`, successLog);
}

/**
 * Логирование бизнес-события
 * @param {string} event - событие
 * @param {Object} data - данные
 * @param {number} userId - ID пользователя
 */
function logBusinessEvent(event, data, userId = null) {
    const eventLog = {
        event,
        data,
        userId,
        timestamp: new Date().toISOString()
    };
    
    info(`Business event: ${event}`, eventLog);
}

/**
 * Логирование действия пользователя
 * @param {number} userId - ID пользователя
 * @param {string} action - действие
 * @param {Object} details - детали
 */
function logUserAction(userId, action, details = {}) {
    const actionLog = {
        userId,
        action,
        details,
        timestamp: new Date().toISOString()
    };
    
    info(`User action: ${action}`, actionLog);
}

/**
 * Логирование системного события
 * @param {string} event - событие
 * @param {Object} data - данные
 */
function logSystemEvent(event, data = {}) {
    const eventLog = {
        event,
        data,
        timestamp: new Date().toISOString()
    };
    
    info(`System event: ${event}`, eventLog);
}

/**
 * Логирование SQL запроса (для отладки)
 * @param {string} sql - SQL запрос
 * @param {Array} params - параметры
 * @param {number} duration - длительность в мс
 */
function logSqlQuery(sql, params, duration) {
    if (config.app.isDevelopment) {
        debug(`SQL Query (${duration}ms): ${sql}`, { params });
    }
}

/**
 * Санитизация тела запроса для логов
 * @param {Object} body - тело запроса
 * @returns {Object}
 */
function sanitizeBodyForLog(body) {
    if (!body) return null;
    
    const sanitized = { ...body };
    const sensitiveFields = ['password', 'password_confirm', 'old_password', 'new_password', 'token', 'refresh_token', 'api_key', 'secret'];
    
    for (const field of sensitiveFields) {
        if (sanitized[field]) {
            sanitized[field] = '[REDACTED]';
        }
    }
    
    return sanitized;
}

// ============================================
= РОТАЦИЯ И ОЧИСТКА
// ============================================

/**
 * Очистка старых логов
 * @param {number} days - количество дней для хранения
 */
function cleanupOldLogs(days = 30) {
    const files = fs.readdirSync(LOG_DIR);
    const now = Date.now();
    const maxAge = days * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    
    for (const file of files) {
        const filePath = path.join(LOG_DIR, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
            deletedCount++;
        }
    }
    
    info(`Cleaned up ${deletedCount} old log files`);
    return deletedCount;
}

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    // Основные функции
    error,
    warn,
    info,
    http,
    debug,
    
    // Middleware
    httpLogger,
    
    // Специализированные
    logApiError,
    logApiSuccess,
    logBusinessEvent,
    logUserAction,
    logSystemEvent,
    logSqlQuery,
    
    // Утилиты
    cleanupOldLogs,
    sanitizeBodyForLog,
    
    // Доступ к raw логгеру (для особых случаев)
    rawLogger: logger,
    accessLogger
};