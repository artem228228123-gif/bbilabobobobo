/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/utils/helpers.js
 * Описание: Вспомогательные функции
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ============================================
= ФОРМАТИРОВАНИЕ
// ============================================

/**
 * Форматирование цены
 * @param {number} price - цена
 * @returns {string}
 */
function formatPrice(price) {
    if (price === undefined || price === null) return '0 ₽';
    return new Intl.NumberFormat('ru-RU').format(price) + ' ₽';
}

/**
 * Форматирование числа с сокращением (K, M)
 * @param {number} num - число
 * @returns {string}
 */
function formatNumber(num) {
    if (num === undefined || num === null) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

/**
 * Форматирование даты
 * @param {Date|string} date - дата
 * @param {string} format - формат
 * @returns {string}
 */
function formatDate(date, format = 'DD.MM.YYYY') {
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    
    return format
        .replace('DD', day)
        .replace('MM', month)
        .replace('YYYY', year)
        .replace('HH', hours)
        .replace('mm', minutes)
        .replace('ss', seconds);
}

/**
 * Относительное время
 * @param {Date|string} date - дата
 * @returns {string}
 */
function timeAgo(date) {
    const d = new Date(date);
    const now = new Date();
    const diff = now - d;
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);
    
    if (seconds < 60) return 'только что';
    if (minutes < 60) return `${minutes} мин назад`;
    if (hours < 24) return `${hours} ч назад`;
    if (days === 1) return 'вчера';
    if (days < 7) return `${days} д назад`;
    if (weeks < 4) return `${weeks} нед назад`;
    if (months < 12) return `${months} мес назад`;
    return `${years} г назад`;
}

/**
 * Форматирование телефона
 * @param {string} phone - телефон
 * @returns {string}
 */
function formatPhone(phone) {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 11) {
        return cleaned.replace(/(\d{1})(\d{3})(\d{3})(\d{2})(\d{2})/, '+$1 ($2) $3-$4-$5');
    }
    if (cleaned.length === 10) {
        return cleaned.replace(/(\d{3})(\d{3})(\d{2})(\d{2})/, '+7 ($1) $2-$3-$4');
    }
    return phone;
}

/**
 * Форматирование размера файла
 * @param {number} bytes - размер в байтах
 * @returns {string}
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Форматирование длительности (секунды → MM:SS)
 * @param {number} seconds - секунды
 * @returns {string}
 */
function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// ============================================
= ГЕНЕРАЦИЯ
// ============================================

/**
 * Генерация уникального ID
 * @returns {string}
 */
function generateId() {
    return Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
}

/**
 * Генерация случайной строки
 * @param {number} length - длина
 * @returns {string}
 */
function generateRandomString(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Генерация реферального кода
 * @returns {string}
 */
function generateReferralCode() {
    return generateRandomString(8).toUpperCase();
}

/**
 * Генерация slug из строки
 * @param {string} str - строка
 * @returns {string}
 */
function generateSlug(str) {
    return str
        .toLowerCase()
        .replace(/[^\w\sа-яё]/gi, '')
        .replace(/\s+/g, '-')
        .substring(0, 100);
}

// ============================================
= ВАЛИДАЦИЯ
// ============================================

/**
 * Проверка, является ли значение email
 * @param {string} email - email
 * @returns {boolean}
 */
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@([^\s@.,]+\.)+[^\s@.,]{2,}$/;
    return emailRegex.test(email);
}

/**
 * Проверка, является ли значение телефоном
 * @param {string} phone - телефон
 * @returns {boolean}
 */
function isValidPhone(phone) {
    const phoneRegex = /^(\+7|8)?[\s\-]?\(?[0-9]{3}\)?[\s\-]?[0-9]{3}[\s\-]?[0-9]{2}[\s\-]?[0-9]{2}$/;
    return phoneRegex.test(phone);
}

/**
 * Проверка, является ли значение URL
 * @param {string} url - URL
 * @returns {boolean}
 */
function isValidUrl(url) {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}

/**
 * Проверка, является ли значение VIN номером
 * @param {string} vin - VIN
 * @returns {boolean}
 */
function isValidVIN(vin) {
    const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/i;
    return vinRegex.test(vin);
}

// ============================================
= БЕЗОПАСНОСТЬ
// ============================================

/**
 * Экранирование HTML
 * @param {string} str - строка
 * @returns {string}
 */
function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Санитизация объекта (удаление чувствительных полей)
 * @param {Object} obj - объект
 * @returns {Object}
 */
function sanitizeObject(obj) {
    if (!obj) return {};
    
    const sanitized = { ...obj };
    const sensitiveFields = ['password', 'password_hash', 'token', 'refresh_token', 'secret', 'api_key'];
    
    for (const field of sensitiveFields) {
        if (sanitized[field]) {
            sanitized[field] = '[REDACTED]';
        }
    }
    
    return sanitized;
}

// ============================================
= РАБОТА С ФАЙЛАМИ
// ============================================

/**
 * Удаление файла
 * @param {string} filePath - путь к файлу
 * @returns {boolean}
 */
function deleteFile(filePath) {
    if (!filePath) return false;
    
    const absolutePath = filePath.startsWith('/') 
        ? filePath 
        : path.join(process.cwd(), filePath);
    
    if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
        return true;
    }
    return false;
}

/**
 * Получение расширения файла
 * @param {string} filename - имя файла
 * @returns {string}
 */
function getFileExtension(filename) {
    return path.extname(filename).toLowerCase();
}

/**
 * Проверка, является ли файл изображением
 * @param {string} mimeType - MIME тип
 * @returns {boolean}
 */
function isImage(mimeType) {
    const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];
    return imageTypes.includes(mimeType);
}

/**
 * Проверка, является ли файл видео
 * @param {string} mimeType - MIME тип
 * @returns {boolean}
 */
function isVideo(mimeType) {
    const videoTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo'];
    return videoTypes.includes(mimeType);
}

// ============================================
= РАБОТА С IP
// ============================================

/**
 * Получение IP адреса из запроса
 * @param {Object} req - Express request
 * @returns {string}
 */
function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] 
        || req.headers['x-real-ip']
        || req.connection?.remoteAddress
        || req.socket?.remoteAddress
        || req.ip;
}

// ============================================
= РАЗНОЕ
// ============================================

/**
 * Задержка выполнения (sleep)
 * @param {number} ms - миллисекунды
 * @returns {Promise}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ограничение вызова функции (debounce)
 * @param {Function} func - функция
 * @param {number} wait - задержка
 * @returns {Function}
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Ограничение частоты вызова (throttle)
 * @param {Function} func - функция
 * @param {number} limit - лимит в мс
 * @returns {Function}
 */
function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

/**
 * Глубокое клонирование объекта
 * @param {Object} obj - объект
 * @returns {Object}
 */
function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj);
    if (obj instanceof Array) return obj.map(item => deepClone(item));
    if (obj instanceof Object) {
        const cloned = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                cloned[key] = deepClone(obj[key]);
            }
        }
        return cloned;
    }
    return obj;
}

/**
 * Объединение объектов
 * @param {...Object} objects - объекты
 * @returns {Object}
 */
function mergeObjects(...objects) {
    const result = {};
    for (const obj of objects) {
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
                    result[key] = mergeObjects(result[key], obj[key]);
                } else {
                    result[key] = obj[key];
                }
            }
        }
    }
    return result;
}

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    // Форматирование
    formatPrice,
    formatNumber,
    formatDate,
    timeAgo,
    formatPhone,
    formatFileSize,
    formatDuration,
    
    // Генерация
    generateId,
    generateRandomString,
    generateReferralCode,
    generateSlug,
    
    // Валидация
    isValidEmail,
    isValidPhone,
    isValidUrl,
    isValidVIN,
    
    // Безопасность
    escapeHtml,
    sanitizeObject,
    
    // Работа с файлами
    deleteFile,
    getFileExtension,
    isImage,
    isVideo,
    
    // Работа с IP
    getClientIp,
    
    // Разное
    sleep,
    debounce,
    throttle,
    deepClone,
    mergeObjects
};