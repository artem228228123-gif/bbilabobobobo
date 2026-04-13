/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: config/constants.js
 * Описание: Глобальные константы приложения
 */

// ============================================
= СТАТУСЫ
// ============================================

const USER_STATUS = {
    ACTIVE: 'active',
    BLOCKED: 'blocked',
    DELETED: 'deleted',
    PENDING: 'pending'
};

const LISTING_STATUS = {
    PENDING: 'pending',
    ACTIVE: 'active',
    SOLD: 'sold',
    ARCHIVED: 'archived',
    REJECTED: 'rejected',
    DELETED: 'deleted'
};

const PAYMENT_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    REFUNDED: 'refunded',
    CANCELLED: 'cancelled'
};

const COMPLAINT_STATUS = {
    PENDING: 'pending',
    RESOLVED: 'resolved',
    IGNORED: 'ignored'
};

const SUBSCRIPTION_STATUS = {
    ACTIVE: 'active',
    EXPIRED: 'expired',
    CANCELLED: 'cancelled',
    PENDING: 'pending'
};

// ============================================
= РОЛИ
// ============================================

const USER_ROLES = {
    USER: 'user',
    MODERATOR: 'moderator',
    ADMIN: 'admin',
    SUPER_ADMIN: 'superadmin'
};

// ============================================
= ТИПЫ УВЕДОМЛЕНИЙ
// ============================================

const NOTIFICATION_TYPES = {
    MESSAGE: 'message',
    LIKE: 'like',
    SALE: 'sale',
    REVIEW: 'review',
    LOTTERY: 'lottery',
    SYSTEM: 'system',
    LISTING_APPROVED: 'listing_approved',
    LISTING_REJECTED: 'listing_rejected',
    ACCOUNT_BLOCKED: 'account_blocked',
    AUCTION_BID: 'auction_bid',
    AUCTION_WIN: 'auction_win',
    SUBSCRIPTION: 'subscription',
    PROMOTION: 'promotion'
};

// ============================================
= ТИПЫ БОНУСНЫХ ТРАНЗАКЦИЙ
// ============================================

const BONUS_TRANSACTION_TYPES = {
    WELCOME: 'welcome',
    DAILY: 'daily',
    REFERRAL_REGISTRATION: 'referral_registration',
    REFERRAL_SALE: 'referral_sale',
    LOTTERY_WIN: 'lottery_win',
    LISTING_CREATE: 'listing_create',
    LISTING_SOLD: 'listing_sold',
    EMAIL_VERIFICATION: 'email_verification',
    REVIEW: 'review',
    TRANSFER_IN: 'transfer_in',
    TRANSFER_OUT: 'transfer_out',
    ADMIN_GRANT: 'admin_grant'
};

// ============================================
= ТИПЫ ПЛАТЕЖЕЙ
// ============================================

const PAYMENT_TYPES = {
    DEPOSIT: 'deposit',
    BUMP: 'bump',
    VIP: 'vip',
    HIGHLIGHT: 'highlight',
    SUBSCRIPTION: 'subscription',
    COMMISSION: 'commission',
    ESCROW: 'escrow',
    WITHDRAWAL: 'withdrawal'
};

// ============================================
= ТИПЫ ОБЪЯВЛЕНИЙ
// ============================================

const LISTING_TYPES = {
    REGULAR: 'regular',
    AUCTION: 'auction'
};

// ============================================
= НАСТРОЙКИ ПО УМОЛЧАНИЮ
// ============================================

const DEFAULTS = {
    // Пользователь
    USER_AVATAR: '/images/default-avatar.png',
    USER_BONUS_BALANCE: 0,
    
    // Объявление
    LISTING_PRICE: 0,
    LISTING_VIEWS: 0,
    LISTING_LIKES: 0,
    
    // Пагинация
    ITEMS_PER_PAGE: 20,
    MAX_ITEMS_PER_PAGE: 100,
    
    // Загрузка файлов
    MAX_PHOTO_SIZE_MB: 10,
    MAX_VIDEO_SIZE_MB: 100,
    MAX_PHOTOS_COUNT: 10,
    
    // Бонусы
    DAILY_BONUS: 100,
    REGISTRATION_BONUS: 100,
    EMAIL_VERIFICATION_BONUS: 50,
    LISTING_CREATE_BONUS: 10,
    LISTING_SOLD_BONUS: 50,
    REVIEW_BONUS: 5,
    REFERRAL_REGISTRATION_BONUS: 50,
    REFERRAL_SALE_BONUS: 100,
    
    // Лотерея
    LOTTERY_TICKET_PRICE: 100,
    LOTTERY_PRIZE_POOL_PERCENT: 70,
    
    // Кеш
    CACHE_TTL_SHORT: 60,      // 1 минута
    CACHE_TTL_MEDIUM: 300,    // 5 минут
    CACHE_TTL_LONG: 3600,     // 1 час
    CACHE_TTL_DAY: 86400      // 24 часа
};

// ============================================
= РЕГУЛЯРНЫЕ ВЫРАЖЕНИЯ
// ============================================

const REGEX = {
    EMAIL: /^[^\s@]+@([^\s@.,]+\.)+[^\s@.,]{2,}$/,
    PHONE: /^(\+7|8)?[\s\-]?\(?[0-9]{3}\)?[\s\-]?[0-9]{3}[\s\-]?[0-9]{2}[\s\-]?[0-9]{2}$/,
    PASSWORD: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{6,}$/,
    URL: /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/,
    VIN: /^[A-HJ-NPR-Z0-9]{17}$/i,
    POSTAL_CODE: /^\d{6}$/,
    INN: /^\d{10}$|^\d{12}$/,
    OGRN: /^\d{13}$|^\d{15}$/,
    SLUG: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    HEX_COLOR: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/
};

// ============================================
= HTTP СТАТУСЫ
// ============================================

const HTTP_STATUS = {
    OK: 200,
    CREATED: 201,
    ACCEPTED: 202,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    CONFLICT: 409,
    UNPROCESSABLE_ENTITY: 422,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
    BAD_GATEWAY: 502,
    SERVICE_UNAVAILABLE: 503
};

// ============================================
= СООБЩЕНИЯ ОБ ОШИБКАХ
// ============================================

const ERROR_MESSAGES = {
    // Общие
    INTERNAL_ERROR: 'Внутренняя ошибка сервера',
    NOT_FOUND: 'Ресурс не найден',
    UNAUTHORIZED: 'Не авторизован',
    FORBIDDEN: 'Доступ запрещён',
    VALIDATION_ERROR: 'Ошибка валидации',
    
    // Пользователи
    USER_NOT_FOUND: 'Пользователь не найден',
    USER_ALREADY_EXISTS: 'Пользователь с таким email уже существует',
    INVALID_CREDENTIALS: 'Неверный email или пароль',
    ACCOUNT_BLOCKED: 'Аккаунт заблокирован',
    
    // Объявления
    LISTING_NOT_FOUND: 'Объявление не найдено',
    LISTING_ALREADY_SOLD: 'Объявление уже продано',
    
    // Чаты
    CHAT_NOT_FOUND: 'Чат не найден',
    MESSAGE_NOT_FOUND: 'Сообщение не найдено',
    
    // Бонусы
    INSUFFICIENT_BONUSES: 'Недостаточно бонусов',
    DAILY_BONUS_ALREADY_CLAIMED: 'Ежедневный бонус уже получен',
    
    // Загрузка файлов
    FILE_TOO_LARGE: 'Файл слишком большой',
    INVALID_FILE_TYPE: 'Неподдерживаемый формат файла',
    NO_FILE_UPLOADED: 'Файл не загружен',
    
    // Платежи
    PAYMENT_FAILED: 'Платёж не удался',
    INSUFFICIENT_FUNDS: 'Недостаточно средств'
};

// ============================================
= НАЗВАНИЯ МЕСЯЦЕВ
// ============================================

const MONTHS = {
    FULL: [
        'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
        'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
    ],
    SHORT: [
        'янв', 'фев', 'мар', 'апр', 'мая', 'июн',
        'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'
    ]
};

// ============================================
= НАЗВАНИЯ ДНЕЙ НЕДЕЛИ
// ============================================

const DAYS_OF_WEEK = {
    FULL: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
    SHORT: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
};

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    USER_STATUS,
    LISTING_STATUS,
    PAYMENT_STATUS,
    COMPLAINT_STATUS,
    SUBSCRIPTION_STATUS,
    USER_ROLES,
    NOTIFICATION_TYPES,
    BONUS_TRANSACTION_TYPES,
    PAYMENT_TYPES,
    LISTING_TYPES,
    DEFAULTS,
    REGEX,
    HTTP_STATUS,
    ERROR_MESSAGES,
    MONTHS,
    DAYS_OF_WEEK
};