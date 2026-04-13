/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/middleware/auth.js
 * Описание: Мидлвары для аутентификации, авторизации и проверки ролей
 */

const jwt = require('jsonwebtoken');
const { config } = require('../../config/env');
const { User } = require('../models');
const { redis, get } = require('../../config/redis');

// ============================================
// ОСНОВНАЯ АУТЕНТИФИКАЦИЯ
// ============================================

/**
 * Проверка JWT токена из cookie или Authorization header
 * Добавляет user в req
 */
async function authenticate(req, res, next) {
    // Пытаемся получить токен из cookie
    let token = req.cookies?.token;
    
    // Если нет в cookie, пробуем из заголовка Authorization
    if (!token) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        }
    }
    
    if (!token) {
        return res.status(401).json({ 
            error: 'Не авторизован',
            code: 'NO_TOKEN'
        });
    }
    
    try {
        // Проверяем токен в чёрном списке (при выходе из всех устройств)
        const isBlacklisted = await get(`blacklist_token:${token}`);
        if (isBlacklisted) {
            return res.status(401).json({ 
                error: 'Токен отозван',
                code: 'TOKEN_REVOKED'
            });
        }
        
        // Верифицируем токен
        const decoded = jwt.verify(token, config.jwt.secret);
        
        // Получаем пользователя из БД (с кешем)
        const user = await User.findById(decoded.id);
        
        if (!user) {
            return res.status(401).json({ 
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }
        
        // Проверяем статус пользователя
        if (user.status === 'blocked') {
            const blockedUntil = user.blocked_until;
            if (blockedUntil && new Date(blockedUntil) > new Date()) {
                return res.status(403).json({
                    error: `Аккаунт заблокирован до ${new Date(blockedUntil).toLocaleString()}`,
                    code: 'ACCOUNT_BLOCKED',
                    blockedUntil
                });
            }
        }
        
        if (user.status === 'deleted') {
            return res.status(403).json({
                error: 'Аккаунт удалён',
                code: 'ACCOUNT_DELETED'
            });
        }
        
        // Добавляем пользователя в req
        req.user = {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            avatar: user.avatar,
            bonusBalance: user.bonus_balance,
            emailVerified: user.email_verified,
        };
        
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ 
                error: 'Токен истёк',
                code: 'TOKEN_EXPIRED'
            });
        }
        
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ 
                error: 'Неверный токен',
                code: 'INVALID_TOKEN'
            });
        }
        
        console.error('Auth middleware error:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПРОВЕРКА РОЛЕЙ
// ============================================

/**
 * Проверка, что пользователь является администратором
 */
function isAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Не авторизован' });
    }
    
    if (req.user.role !== 'admin') {
        return res.status(403).json({ 
            error: 'Доступ запрещён. Требуются права администратора',
            code: 'ADMIN_REQUIRED'
        });
    }
    
    next();
}

/**
 * Проверка, что пользователь является администратором или модератором
 */
function isAdminOrModerator(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Не авторизован' });
    }
    
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
        return res.status(403).json({ 
            error: 'Доступ запрещён. Требуются права администратора или модератора',
            code: 'MODERATOR_REQUIRED'
        });
    }
    
    next();
}

/**
 * Проверка, что пользователь владелец ресурса
 * @param {Function} getResourceUserId - функция, возвращающая id владельца ресурса
 */
function isOwner(getResourceUserId) {
    return async (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Не авторизован' });
        }
        
        try {
            const ownerId = await getResourceUserId(req);
            
            if (req.user.role === 'admin') {
                return next();
            }
            
            if (req.user.id !== ownerId) {
                return res.status(403).json({ 
                    error: 'Доступ запрещён. Вы не являетесь владельцем',
                    code: 'NOT_OWNER'
                });
            }
            
            next();
        } catch (error) {
            console.error('Owner check error:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    };
}

// ============================================
// ОПЦИОНАЛЬНАЯ АУТЕНТИФИКАЦИЯ
// ============================================

/**
 * Опциональная аутентификация (не требует токена, но если есть — проверяет)
 */
async function optionalAuth(req, res, next) {
    let token = req.cookies?.token;
    
    if (!token) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        }
    }
    
    if (!token) {
        req.user = null;
        return next();
    }
    
    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        const user = await User.findById(decoded.id);
        
        if (user && user.status === 'active') {
            req.user = {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
            };
        } else {
            req.user = null;
        }
        
        next();
    } catch (error) {
        req.user = null;
        next();
    }
}

// ============================================
// ПРОВЕРКА ПОДТВЕРЖДЕНИЯ EMAIL
// ============================================

/**
 * Проверка, что email пользователя подтверждён
 */
async function requireVerifiedEmail(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Не авторизован' });
    }
    
    if (!req.user.emailVerified) {
        return res.status(403).json({
            error: 'Требуется подтверждение email',
            code: 'EMAIL_NOT_VERIFIED'
        });
    }
    
    next();
}

// ============================================
// ОГРАНИЧЕНИЕ ПО РЕГИОНУ (ОПЦИОНАЛЬНО)
// ============================================

/**
 * Проверка, что пользователь из разрешённого региона
 */
function requireRegion(allowedRegions = ['ru', 'kz', 'by', 'ua']) {
    return (req, res, next) => {
        const userRegion = req.headers['x-user-region'] || 'ru';
        
        if (!allowedRegions.includes(userRegion)) {
            return res.status(403).json({
                error: 'Сервис недоступен в вашем регионе',
                code: 'REGION_NOT_ALLOWED'
            });
        }
        
        req.userRegion = userRegion;
        next();
    };
}

// ============================================
// ОГРАНИЧЕНИЕ ПО ВОЗРАСТУ
// ============================================

/**
 * Проверка, что пользователь старше 18 лет
 */
async function requireAdult(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Не авторизован' });
    }
    
    try {
        const user = await User.findById(req.user.id);
        
        if (!user.birth_date) {
            return res.status(403).json({
                error: 'Требуется указать дату рождения для доступа к этому разделу',
                code: 'BIRTH_DATE_REQUIRED'
            });
        }
        
        const age = new Date().getFullYear() - new Date(user.birth_date).getFullYear();
        
        if (age < 18) {
            return res.status(403).json({
                error: 'Доступ запрещён для пользователей младше 18 лет',
                code: 'AGE_RESTRICTION'
            });
        }
        
        next();
    } catch (error) {
        console.error('Age check error:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ФУНКЦИИ ДЛЯ ISOWNER
// ============================================

/**
 * Получить ID владельца объявления
 */
function getListingOwnerId(req) {
    const listingId = req.params.id || req.params.listingId;
    return require('../models').Listing.findById(listingId).then(listing => listing?.user_id);
}

/**
 * Получить ID владельца чата
 */
async function getChatOwnerId(req) {
    const chatId = req.params.id;
    const result = await require('../models').Chat.findById(chatId);
    if (!result) return null;
    
    // Проверяем, является ли пользователь участником чата
    if (req.user.id === result.buyer_id || req.user.id === result.seller_id) {
        return req.user.id;
    }
    return null;
}

/**
 * Получить ID владельца отзыва
 */
function getReviewOwnerId(req) {
    const reviewId = req.params.id;
    return require('../models').Review.findById(reviewId).then(review => review?.from_user_id);
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    // Основные
    authenticate,
    optionalAuth,
    
    // Роли
    isAdmin,
    isAdminOrModerator,
    
    // Владелец
    isOwner,
    getListingOwnerId,
    getChatOwnerId,
    getReviewOwnerId,
    
    // Дополнительные проверки
    requireVerifiedEmail,
    requireRegion,
    requireAdult,
};