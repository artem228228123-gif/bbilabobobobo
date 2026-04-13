/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/utils/constants.js
 * Описание: Глобальные константы приложения
 */

// ============================================
// СТАТУСЫ
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

const ESCROW_STATUS = {
    PENDING: 'pending',
    PAID: 'paid',
    SHIPPED: 'shipped',
    DELIVERED: 'delivered',
    COMPLETED: 'completed',
    DISPUTED: 'disputed',
    REFUNDED: 'refunded',
    CANCELLED: 'cancelled'
};

const WITHDRAWAL_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
};

// ============================================
// РОЛИ
// ============================================

const USER_ROLES = {
    USER: 'user',
    MODERATOR: 'moderator',
    ADMIN: 'admin',
    SUPER_ADMIN: 'superadmin'
};

// ============================================
// ТИПЫ УВЕДОМЛЕНИЙ
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
    PROMOTION: 'promotion',
    WELCOME: 'welcome',
    PAYMENT_SUCCESS: 'payment_success',
    PAYMENT_FAILED: 'payment_failed',
    WITHDRAWAL_COMPLETED: 'withdrawal_completed',
    WITHDRAWAL_FAILED: 'withdrawal_failed'
};

// ============================================
// ТИПЫ БОНУСНЫХ ТРАНЗАКЦИЙ
// ============================================

const BONUS_TRANSACTION_TYPES = {
    WELCOME: 'welcome',
    DAILY: 'daily',
    REFERRAL_REGISTRATION: 'referral_registration',
    REFERRAL_SALE: 'referral_sale',
    LOTTERY_WIN: 'lottery_win',
    LOTTERY_REFUND: 'lottery_refund',
    LISTING_CREATE: 'listing_create',
    LISTING_SOLD: 'listing_sold',
    LISTING_APPROVED: 'listing_approved',
    EMAIL_VERIFICATION: 'email_verification',
    REVIEW: 'review',
    TRANSFER_IN: 'transfer_in',
    TRANSFER_OUT: 'transfer_out',
    ADMIN_GRANT: 'admin_grant',
    ADMIN_REMOVE: 'admin_remove',
    DAILY_QUEST: 'daily_quest',
    BONUS_PROMOTION: 'bonus_promotion'
};

// ============================================
// ТИПЫ ПЛАТЕЖЕЙ
// ============================================

const PAYMENT_TYPES = {
    DEPOSIT: 'deposit',
    BUMP: 'bump',
    VIP: 'vip',
    HIGHLIGHT: 'highlight',
    SUBSCRIPTION: 'subscription',
    COMMISSION: 'commission',
    ESCROW: 'escrow',
    WITHDRAWAL: 'withdrawal',
    REFUND: 'refund'
};

// ============================================
// ТИПЫ ОБЪЯВЛЕНИЙ
// ============================================

const LISTING_TYPES = {
    REGULAR: 'regular',
    AUCTION: 'auction'
};

// ============================================
// ТИПЫ КОМИССИЙ
// ============================================

const COMMISSION_TYPES = {
    SALE: 'sale',
    DELIVERY: 'delivery',
    ESCROW: 'escrow',
    WITHDRAWAL: 'withdrawal'
};

// ============================================
= ПЛАНЫ ПОДПИСОК
// ============================================

const SUBSCRIPTION_PLANS = {
    PREMIUM_MONTH: 'premium_month',
    PREMIUM_YEAR: 'premium_year',
    BUSINESS_MONTH: 'business_month',
    BUSINESS_YEAR: 'business_year'
};

// ============================================
= МЕТОДЫ ВЫВОДА
// ============================================

const WITHDRAWAL_METHODS = {
    CARD: 'card',
    BANK: 'bank',
    YOOMONEY: 'yoomoney',
    CRYPTO: 'crypto'
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
    SERVICE_UNAVAILABLE: 503,
    GATEWAY_TIMEOUT: 504
};

// ============================================
= НАСТРОЙКИ ПО УМОЛЧАНИЮ
// ============================================

const DEFAULTS = {
    // Пользователь
    USER_AVATAR: '/images/default-avatar.png',
    USER_BONUS_BALANCE: 0,
    USER_RATING: 0,
    
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
    MAX_AVATAR_SIZE_MB: 5,
    MAX_CHAT_PHOTO_SIZE_MB: 5,
    
    // Бонусы
    DAILY_BONUS: 100,
    REGISTRATION_BONUS: 100,
    EMAIL_VERIFICATION_BONUS: 50,
    LISTING_CREATE_BONUS: 10,
    LISTING_SOLD_BONUS: 50,
    REVIEW_BONUS: 5,
    REFERRAL_REGISTRATION_BONUS: 50,
    REFERRAL_SALE_BONUS: 100,
    STREAK_BONUS_PERCENT: 10,
    MAX_STREAK_BONUS: 100,
    
    // Лотерея
    LOTTERY_TICKET_PRICE: 100,
    LOTTERY_PRIZE_POOL_PERCENT: 70,
    LOTTERY_DRAW_DAY: 0,
    LOTTERY_DRAW_HOUR: 20,
    
    // Кеш
    CACHE_TTL_SHORT: 60,      // 1 минута
    CACHE_TTL_MEDIUM: 300,    // 5 минут
    CACHE_TTL_LONG: 3600,     // 1 час
    CACHE_TTL_DAY: 86400,     // 24 часа
    CACHE_TTL_WEEK: 604800,   // 7 дней
    
    // Rate Limit
    RATE_LIMIT_GLOBAL: 100,
    RATE_LIMIT_API: 60,
    RATE_LIMIT_AUTH: 5,
    RATE_LIMIT_REGISTRATION: 3,
    RATE_LIMIT_PASSWORD_RESET: 3,
    RATE_LIMIT_LISTING_CREATE: 10,
    RATE_LIMIT_MESSAGE_SEND: 30,
    RATE_LIMIT_SEARCH: 20,
    RATE_LIMIT_UPLOAD: 50,
    RATE_LIMIT_LIKE: 30,
    RATE_LIMIT_REVIEW: 10,
    RATE_LIMIT_ADMIN: 100
};

// ============================================
= РЕГУЛЯРНЫЕ ВЫРАЖЕНИЯ
// ============================================

const REGEX = {
    // Email
    EMAIL: /^[^\s@]+@([^\s@.,]+\.)+[^\s@.,]{2,}$/,
    
    // Телефон (Россия)
    PHONE: /^(\+7|8)?[\s\-]?\(?[0-9]{3}\)?[\s\-]?[0-9]{3}[\s\-]?[0-9]{2}[\s\-]?[0-9]{2}$/,
    
    // Пароль (минимум 6 символов, буквы и цифры)
    PASSWORD: /^(?=.*[a-zA-Zа-яА-Я])(?=.*\d)[a-zA-Zа-яА-Я\d]{6,}$/,
    
    // URL
    URL: /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/,
    
    // VIN номер
    VIN: /^[A-HJ-NPR-Z0-9]{17}$/i,
    
    // Почтовый индекс (Россия)
    POSTAL_CODE: /^\d{6}$/,
    
    // ИНН (10 или 12 цифр)
    INN: /^\d{10}$|^\d{12}$/,
    
    // ОГРН (13 или 15 цифр)
    OGRN: /^\d{13}$|^\d{15}$/,
    
    // Slug
    SLUG: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    
    // HEX цвет
    HEX_COLOR: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/,
    
    // Время HH:MM
    TIME: /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/,
    
    // Дата YYYY-MM-DD
    DATE: /^\d{4}-\d{2}-\d{2}$/,
    
    // Дата и время ISO
    DATETIME_ISO: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/,
    
    // IP адрес
    IP: /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
    
    // UUID
    UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    
    // Координаты (широта)
    LATITUDE: /^-?([1-8]?[0-9]{1,2}\.\d{1,8}|90\.0{1,8})$/,
    
    // Координаты (долгота)
    LONGITUDE: /^-?([1-9]?[0-9]{1,2}\.\d{1,8}|180\.0{1,8})$/,
    
    // Telegram username
    TELEGRAM: /^@?[a-zA-Z0-9_]{5,32}$/,
    
    // VK username или id
    VK: /^(?:https?:\/\/)?(?:vk\.com|vkontakte\.ru)\/([a-zA-Z0-9_.]+|id\d+)$/i
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
    BAD_REQUEST: 'Неверный запрос',
    
    // Пользователи
    USER_NOT_FOUND: 'Пользователь не найден',
    USER_ALREADY_EXISTS: 'Пользователь с таким email уже существует',
    INVALID_CREDENTIALS: 'Неверный email или пароль',
    ACCOUNT_BLOCKED: 'Аккаунт заблокирован',
    ACCOUNT_DELETED: 'Аккаунт удалён',
    EMAIL_NOT_VERIFIED: 'Email не подтверждён',
    PHONE_NOT_VERIFIED: 'Телефон не подтверждён',
    
    // Объявления
    LISTING_NOT_FOUND: 'Объявление не найдено',
    LISTING_ALREADY_SOLD: 'Объявление уже продано',
    LISTING_PENDING: 'Объявление на модерации',
    LISTING_REJECTED: 'Объявление отклонено',
    
    // Чаты
    CHAT_NOT_FOUND: 'Чат не найден',
    MESSAGE_NOT_FOUND: 'Сообщение не найдено',
    MESSAGE_TOO_LONG: 'Сообщение слишком длинное',
    
    // Бонусы
    INSUFFICIENT_BONUSES: 'Недостаточно бонусов',
    DAILY_BONUS_ALREADY_CLAIMED: 'Ежедневный бонус уже получен',
    TRANSFER_SELF: 'Нельзя перевести бонусы самому себе',
    TRANSFER_MIN_AMOUNT: 'Минимальная сумма перевода — 10 бонусов',
    TRANSFER_MAX_AMOUNT: 'Максимальная сумма перевода — 10 000 бонусов',
    
    // Загрузка файлов
    FILE_TOO_LARGE: 'Файл слишком большой',
    INVALID_FILE_TYPE: 'Неподдерживаемый формат файла',
    NO_FILE_UPLOADED: 'Файл не загружен',
    MAX_FILES_EXCEEDED: 'Превышено максимальное количество файлов',
    
    // Платежи
    PAYMENT_FAILED: 'Платёж не удался',
    INSUFFICIENT_FUNDS: 'Недостаточно средств',
    INVALID_CARD: 'Неверные данные карты',
    PAYMENT_NOT_FOUND: 'Платёж не найден',
    
    // Лотерея
    LOTTERY_NOT_ACTIVE: 'Лотерея не активна',
    LOTTERY_ALREADY_COMPLETED: 'Розыгрыш уже завершён',
    LOTTERY_NO_TICKETS: 'Нет билетов для розыгрыша',
    
    // Рефералы
    REFERRAL_CODE_INVALID: 'Неверный реферальный код',
    REFERRAL_SELF: 'Нельзя использовать свой реферальный код'
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
    ],
    NUMERIC: [
        '01', '02', '03', '04', '05', '06',
        '07', '08', '09', '10', '11', '12'
    ]
};

// ============================================
= НАЗВАНИЯ ДНЕЙ НЕДЕЛИ
// ============================================

const DAYS_OF_WEEK = {
    FULL: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
    SHORT: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
    NUMERIC: [0, 1, 2, 3, 4, 5, 6]
};

// ============================================
= ВАЛЮТЫ
// ============================================

const CURRENCIES = {
    RUB: { code: 'RUB', symbol: '₽', name: 'Российский рубль' },
    USD: { code: 'USD', symbol: '$', name: 'Доллар США' },
    EUR: { code: 'EUR', symbol: '€', name: 'Евро' },
    KZT: { code: 'KZT', symbol: '₸', name: 'Казахстанский тенге' },
    UAH: { code: 'UAH', symbol: '₴', name: 'Украинская гривна' },
    BYN: { code: 'BYN', symbol: 'Br', name: 'Белорусский рубль' }
};

// ============================================
= ВРЕМЕННЫЕ ЗОНЫ
// ============================================

const TIMEZONES = {
    MOSCOW: 'Europe/Moscow',
    KALININGRAD: 'Europe/Kaliningrad',
    SAMARA: 'Europe/Samara',
    YEKATERINBURG: 'Asia/Yekaterinburg',
    OMSK: 'Asia/Omsk',
    KRASNOYARSK: 'Asia/Krasnoyarsk',
    IRKUTSK: 'Asia/Irkutsk',
    YAKUTSK: 'Asia/Yakutsk',
    VLADIVOSTOK: 'Asia/Vladivostok',
    MAGADAN: 'Asia/Magadan',
    KAMCHATKA: 'Asia/Kamchatka'
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
    ESCROW_STATUS,
    WITHDRAWAL_STATUS,
    USER_ROLES,
    NOTIFICATION_TYPES,
    BONUS_TRANSACTION_TYPES,
    PAYMENT_TYPES,
    LISTING_TYPES,
    COMMISSION_TYPES,
    SUBSCRIPTION_PLANS,
    WITHDRAWAL_METHODS,
    HTTP_STATUS,
    DEFAULTS,
    REGEX,
    ERROR_MESSAGES,
    MONTHS,
    DAYS_OF_WEEK,
    CURRENCIES,
    TIMEZONES
};