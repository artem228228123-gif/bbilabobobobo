/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/middleware/validation.js
 * Описание: Middleware для валидации входных данных (Joi, express-validator)
 */

const { body, param, query, validationResult } = require('express-validator');
const Joi = require('joi');

// ============================================
= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

/**
 * Проверка результатов валидации express-validator
 */
function validate(req, res, next) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            error: 'Ошибка валидации',
            errors: errors.array(),
            timestamp: new Date().toISOString()
        });
    }
    next();
}

/**
 * Валидация с Joi
 * @param {Object} schema - Joi схема
 * @returns {Function}
 */
function validateJoi(schema) {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.body, { abortEarly: false });
        
        if (error) {
            const errors = error.details.map(detail => ({
                field: detail.path.join('.'),
                message: detail.message
            }));
            
            return res.status(400).json({
                error: 'Ошибка валидации',
                errors,
                timestamp: new Date().toISOString()
            });
        }
        
        req.body = value;
        next();
    };
}

// ============================================
= СХЕМЫ ДЛЯ JOI
// ============================================

const userSchemas = {
    // Регистрация
    register: Joi.object({
        name: Joi.string().min(2).max(50).required(),
        email: Joi.string().email().required(),
        password: Joi.string().min(6).max(100).required(),
        password_confirm: Joi.string().valid(Joi.ref('password')).required(),
        phone: Joi.string().pattern(/^(\+7|8)?[\s\-]?\(?[0-9]{3}\)?[\s\-]?[0-9]{3}[\s\-]?[0-9]{2}[\s\-]?[0-9]{2}$/).optional(),
        city: Joi.string().max(100).optional(),
        referral_code: Joi.string().length(8).optional()
    }),
    
    // Вход
    login: Joi.object({
        email: Joi.string().email().required(),
        password: Joi.string().required()
    }),
    
    // Обновление профиля
    updateProfile: Joi.object({
        name: Joi.string().min(2).max(50).optional(),
        phone: Joi.string().pattern(/^(\+7|8)?[\s\-]?\(?[0-9]{3}\)?[\s\-]?[0-9]{3}[\s\-]?[0-9]{2}[\s\-]?[0-9]{2}$/).optional(),
        city: Joi.string().max(100).optional(),
        bio: Joi.string().max(500).optional(),
        birth_date: Joi.date().iso().optional(),
        social_telegram: Joi.string().max(100).optional(),
        social_vk: Joi.string().max(100).optional()
    }),
    
    // Смена пароля
    changePassword: Joi.object({
        old_password: Joi.string().required(),
        new_password: Joi.string().min(6).max(100).required(),
        confirm_password: Joi.string().valid(Joi.ref('new_password')).required()
    })
};

const listingSchemas = {
    // Создание объявления
    create: Joi.object({
        title: Joi.string().min(5).max(200).required(),
        description: Joi.string().max(5000).optional(),
        price: Joi.number().integer().min(0).max(1000000000).required(),
        category_id: Joi.number().integer().required(),
        city: Joi.string().max(100).required(),
        address: Joi.string().max(255).optional(),
        latitude: Joi.number().min(-90).max(90).optional(),
        longitude: Joi.number().min(-180).max(180).optional(),
        hide_address: Joi.boolean().optional(),
        phone: Joi.string().pattern(/^(\+7|8)?[\s\-]?\(?[0-9]{3}\)?[\s\-]?[0-9]{3}[\s\-]?[0-9]{2}[\s\-]?[0-9]{2}$/).optional(),
        email: Joi.string().email().optional(),
        show_phone: Joi.boolean().optional(),
        type: Joi.string().valid('regular', 'auction').default('regular'),
        start_price: Joi.number().integer().min(0).when('type', {
            is: 'auction',
            then: Joi.required(),
            otherwise: Joi.optional()
        }),
        min_step: Joi.number().integer().min(1).when('type', {
            is: 'auction',
            then: Joi.required(),
            otherwise: Joi.optional()
        }),
        ends_at: Joi.date().iso().when('type', {
            is: 'auction',
            then: Joi.required(),
            otherwise: Joi.optional()
        })
    }),
    
    // Обновление объявления
    update: Joi.object({
        title: Joi.string().min(5).max(200).optional(),
        description: Joi.string().max(5000).optional(),
        price: Joi.number().integer().min(0).max(1000000000).optional(),
        category_id: Joi.number().integer().optional(),
        city: Joi.string().max(100).optional(),
        address: Joi.string().max(255).optional(),
        latitude: Joi.number().min(-90).max(90).optional(),
        longitude: Joi.number().min(-180).max(180).optional(),
        hide_address: Joi.boolean().optional(),
        phone: Joi.string().pattern(/^(\+7|8)?[\s\-]?\(?[0-9]{3}\)?[\s\-]?[0-9]{3}[\s\-]?[0-9]{2}[\s\-]?[0-9]{2}$/).optional(),
        email: Joi.string().email().optional(),
        show_phone: Joi.boolean().optional(),
        status: Joi.string().valid('active', 'sold', 'archived').optional()
    }),
    
    // Поиск с фильтрами
    search: Joi.object({
        q: Joi.string().max(200).optional(),
        category_id: Joi.number().integer().optional(),
        price_min: Joi.number().integer().min(0).optional(),
        price_max: Joi.number().integer().min(0).optional(),
        city: Joi.string().max(100).optional(),
        radius: Joi.number().integer().min(1).max(500).optional(),
        lat: Joi.number().min(-90).max(90).optional(),
        lng: Joi.number().min(-180).max(180).optional(),
        seller_type: Joi.string().valid('all', 'private', 'company').default('all'),
        sort: Joi.string().valid('created_desc', 'price_asc', 'price_desc', 'popular').default('created_desc'),
        limit: Joi.number().integer().min(1).max(50).default(20),
        cursor: Joi.string().optional()
    })
};

const chatSchemas = {
    // Создание чата
    create: Joi.object({
        listing_id: Joi.number().integer().required(),
        seller_id: Joi.number().integer().required()
    }),
    
    // Отправка сообщения
    sendMessage: Joi.object({
        text: Joi.string().max(2000).optional(),
        reply_to_id: Joi.number().integer().optional()
    }),
    
    // Настройки автоответчика
    autoReply: Joi.object({
        enabled: Joi.boolean().required(),
        text: Joi.string().max(500).optional(),
        start_time: Joi.string().pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
        end_time: Joi.string().pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).optional()
    })
};

const paymentSchemas = {
    // Создание платежа
    createPayment: Joi.object({
        amount: Joi.number().integer().min(100).max(100000).required(),
        description: Joi.string().max(255).required(),
        return_url: Joi.string().uri().optional()
    }),
    
    // Вывод средств
    withdrawal: Joi.object({
        amount: Joi.number().integer().min(500).max(100000).required(),
        method: Joi.string().valid('card', 'bank', 'yoomoney', 'crypto').required(),
        details: Joi.object({
            card_number: Joi.string().when('method', { is: 'card', then: Joi.required() }),
            card_expiry: Joi.string().when('method', { is: 'card', then: Joi.required() }),
            bank_account: Joi.string().when('method', { is: 'bank', then: Joi.required() }),
            yoomoney_wallet: Joi.string().when('method', { is: 'yoomoney', then: Joi.required() }),
            crypto_address: Joi.string().when('method', { is: 'crypto', then: Joi.required() })
        }).required()
    })
};

const reviewSchemas = {
    // Создание отзыва
    create: Joi.object({
        to_user_id: Joi.number().integer().required(),
        listing_id: Joi.number().integer().required(),
        rating: Joi.number().integer().min(1).max(5).required(),
        text: Joi.string().min(10).max(1000).required()
    }),
    
    // Ответ на отзыв
    reply: Joi.object({
        reply: Joi.string().min(2).max(500).required()
    })
};

const bonusSchemas = {
    // Перевод бонусов
    transfer: Joi.object({
        to_user_id: Joi.number().integer().required(),
        amount: Joi.number().integer().min(10).max(10000).required()
    }),
    
    // Обмен бонусов
    redeem: Joi.object({
        service: Joi.string().valid('bump', 'vip', 'highlight', 'lottery_ticket').required(),
        listing_id: Joi.number().integer().when('service', {
            is: Joi.string().valid('bump', 'vip', 'highlight'),
            then: Joi.required(),
            otherwise: Joi.optional()
        })
    })
};

const adminSchemas = {
    // Блокировка пользователя
    blockUser: Joi.object({
        reason: Joi.string().min(5).max(500).required(),
        duration: Joi.string().valid('24h', '7d', 'permanent').required()
    }),
    
    // Отклонение объявления
    rejectListing: Joi.object({
        reason: Joi.string().min(10).max(1000).required()
    }),
    
    // Обработка жалобы
    resolveComplaint: Joi.object({
        action: Joi.string().valid('ignore', 'warn', 'delete_listing', 'block_user').required(),
        comment: Joi.string().max(500).optional()
    }),
    
    // Массовая рассылка
    massNotification: Joi.object({
        title: Joi.string().min(3).max(100).required(),
        message: Joi.string().min(10).max(2000).required(),
        type: Joi.string().valid('promotion', 'system', 'news').default('promotion'),
        user_filter: Joi.string().valid('all', 'active', 'new', 'email').default('all'),
        emails: Joi.array().items(Joi.string().email()).when('user_filter', {
            is: 'email',
            then: Joi.required()
        })
    })
};

// ============================================
= ПРАВИЛА ДЛЯ EXPRESS-VALIDATOR
// ============================================

const validationRules = {
    // Пользователи
    userRegister: [
        body('name').notEmpty().withMessage('Имя обязательно').isLength({ min: 2, max: 50 }),
        body('email').isEmail().withMessage('Неверный формат email').normalizeEmail(),
        body('password').isLength({ min: 6 }).withMessage('Пароль должен быть минимум 6 символов'),
        body('password_confirm').custom((value, { req }) => value === req.body.password).withMessage('Пароли не совпадают'),
        body('phone').optional().isMobilePhone('any').withMessage('Неверный формат телефона'),
        body('city').optional().isString().isLength({ max: 100 })
    ],
    
    userLogin: [
        body('email').isEmail().withMessage('Неверный формат email'),
        body('password').notEmpty().withMessage('Пароль обязателен')
    ],
    
    userUpdate: [
        body('name').optional().isLength({ min: 2, max: 50 }),
        body('phone').optional().isMobilePhone('any'),
        body('city').optional().isString().isLength({ max: 100 }),
        body('bio').optional().isString().isLength({ max: 500 })
    ],
    
    changePassword: [
        body('old_password').notEmpty().withMessage('Текущий пароль обязателен'),
        body('new_password').isLength({ min: 6 }).withMessage('Новый пароль должен быть минимум 6 символов'),
        body('confirm_password').custom((value, { req }) => value === req.body.new_password).withMessage('Пароли не совпадают')
    ],
    
    // Объявления
    listingCreate: [
        body('title').notEmpty().withMessage('Название обязательно').isLength({ min: 5, max: 200 }),
        body('description').optional().isLength({ max: 5000 }),
        body('price').isInt({ min: 0 }).withMessage('Цена должна быть положительным числом'),
        body('category_id').isInt().withMessage('Категория обязательна'),
        body('city').notEmpty().withMessage('Город обязателен'),
        body('latitude').optional().isFloat({ min: -90, max: 90 }),
        body('longitude').optional().isFloat({ min: -180, max: 180 }),
        body('type').optional().isIn(['regular', 'auction'])
    ],
    
    listingUpdate: [
        param('id').isInt().withMessage('ID должен быть числом'),
        body('title').optional().isLength({ min: 5, max: 200 }),
        body('price').optional().isInt({ min: 0 }),
        body('status').optional().isIn(['active', 'sold', 'archived'])
    ],
    
    // Чаты
    chatCreate: [
        body('listing_id').isInt().withMessage('ID объявления обязателен'),
        body('seller_id').isInt().withMessage('ID продавца обязателен')
    ],
    
    sendMessage: [
        param('id').isInt(),
        body('text').optional().isString().isLength({ max: 2000 })
    ],
    
    // Отзывы
    reviewCreate: [
        body('to_user_id').isInt(),
        body('listing_id').isInt(),
        body('rating').isInt({ min: 1, max: 5 }),
        body('text').isString().isLength({ min: 10, max: 1000 })
    ],
    
    reviewReply: [
        param('id').isInt(),
        body('reply').isString().isLength({ min: 2, max: 500 })
    ],
    
    // Жалобы
    complaintCreate: [
        param('id').isInt(),
        body('reason').notEmpty().withMessage('Укажите причину жалобы'),
        body('description').optional().isString().isLength({ max: 1000 })
    ],
    
    // Бонусы
    bonusTransfer: [
        body('to_user_id').isInt().withMessage('ID получателя обязателен'),
        body('amount').isInt({ min: 10, max: 10000 }).withMessage('Сумма от 10 до 10000 бонусов')
    ],
    
    bonusRedeem: [
        body('service').isIn(['bump', 'vip', 'highlight', 'lottery_ticket']),
        body('listing_id').optional().isInt()
    ],
    
    // Админ
    adminBlockUser: [
        param('id').isInt(),
        body('reason').isString().isLength({ min: 5, max: 500 }),
        body('duration').isIn(['24h', '7d', 'permanent'])
    ],
    
    adminRejectListing: [
        param('id').isInt(),
        body('reason').isString().isLength({ min: 10, max: 1000 })
    ]
};

// ============================================
= КАСТОМНЫЕ ВАЛИДАТОРЫ
// ============================================

/**
 * Проверка, что значение является целым числом
 */
const isInt = (value) => {
    return Number.isInteger(Number(value));
};

/**
 * Проверка, что значение находится в диапазоне
 */
const isInRange = (value, min, max) => {
    const num = Number(value);
    return !isNaN(num) && num >= min && num <= max;
};

/**
 * Проверка, что значение является валидным VIN номером
 */
const isValidVIN = (value) => {
    const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/i;
    return vinRegex.test(value);
};

/**
 * Проверка, что значение является валидным URL
 */
const isValidUrl = (value) => {
    try {
        new URL(value);
        return true;
    } catch {
        return false;
    }
};

/**
 * Проверка, что значение не содержит HTML теги
 */
const noHtmlTags = (value) => {
    const htmlRegex = /<[^>]*>/g;
    return !htmlRegex.test(value);
};

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    // Основные
    validate,
    validateJoi,
    
    // Схемы Joi
    userSchemas,
    listingSchemas,
    chatSchemas,
    paymentSchemas,
    reviewSchemas,
    bonusSchemas,
    adminSchemas,
    
    // Правила express-validator
    validationRules,
    
    // Кастомные валидаторы
    isInt,
    isInRange,
    isValidVIN,
    isValidUrl,
    noHtmlTags
};