/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/app.js
 * Описание: Главный файл приложения, настройка Express, middleware, маршруты
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

// Загрузка переменных окружения
require('dotenv').config();

// Инициализация приложения
const app = express();

// Создаём папку для логов если её нет
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Настройка логов
const accessLogStream = fs.createWriteStream(
    path.join(logsDir, 'access.log'),
    { flags: 'a' }
);

// ============================================
// MIDDLEWARE (Безопасность и производительность)
// ============================================

// Защита HTTP заголовков
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'", "wss:", "https:"],
        },
    },
}));

// CORS настройки (для API)
app.use(cors({
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    credentials: true,
    optionsSuccessStatus: 200
}));

// Сжатие ответов (Gzip/Brotli)
app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    }
}));

// Логирование запросов
app.use(morgan('combined', { stream: accessLogStream }));
app.use(morgan('dev')); // для консоли

// Парсинг JSON и URL-encoded
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Парсинг cookie
app.use(cookieParser());

// Rate Limiting (100 запросов в 15 минут с одного IP)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 100, // максимум 100 запросов
    message: { error: 'Слишком много запросов, попробуйте позже' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Более строгий лимит для API (60 запросов в минуту)
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 минута
    max: 60,
    message: { error: 'Превышен лимит запросов к API' },
});

// Применяем лимиты
app.use('/', limiter);
app.use('/api/', apiLimiter);

// Статические файлы (клиентская часть)
app.use(express.static(path.join(__dirname, '../client')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/temp', express.static(path.join(__dirname, '../temp')));

// ============================================
// ПОДКЛЮЧЕНИЕ МОДУЛЕЙ
// ============================================

// Импорт маршрутов
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const listingRoutes = require('./routes/listings');
const categoryRoutes = require('./routes/categories');
const favoriteRoutes = require('./routes/favorites');
const chatRoutes = require('./routes/chats');
const reviewRoutes = require('./routes/reviews');
const mapRoutes = require('./routes/map');
const tiktokRoutes = require('./routes/tiktok');
const bonusRoutes = require('./routes/bonus');
const lotteryRoutes = require('./routes/lottery');
const referralRoutes = require('./routes/referral');
const adminRoutes = require('./routes/admin');
const notificationRoutes = require('./routes/notifications');

// ============================================
// РЕГИСТРАЦИЯ МАРШРУТОВ
// ============================================

// API версии 1
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/listings', listingRoutes);
app.use('/api/v1/categories', categoryRoutes);
app.use('/api/v1/favorites', favoriteRoutes);
app.use('/api/v1/chats', chatRoutes);
app.use('/api/v1/reviews', reviewRoutes);
app.use('/api/v1/map', mapRoutes);
app.use('/api/v1/tiktok', tiktokRoutes);
app.use('/api/v1/bonus', bonusRoutes);
app.use('/api/v1/lottery', lotteryRoutes);
app.use('/api/v1/referral', referralRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/notifications', notificationRoutes);

// Health check (для мониторинга)
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: '3.0.0'
    });
});

// ============================================
// ОБРАБОТЧИКИ ОШИБОК
// ============================================

// 404 — маршрут не найден
app.use((req, res) => {
    res.status(404).json({
        error: 'Маршрут не найден',
        path: req.originalUrl,
        method: req.method
    });
});

// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
    // Логируем ошибку
    console.error('❌ Ошибка:', err);
    
    // Записываем в файл логов
    const errorLog = `${new Date().toISOString()} | ${err.message} | ${req.method} ${req.url} | IP: ${req.ip}\n`;
    fs.appendFileSync(path.join(logsDir, 'errors.log'), errorLog);
    
    // Отправляем ответ клиенту
    const status = err.status || 500;
    const message = err.message || 'Внутренняя ошибка сервера';
    
    res.status(status).json({
        error: message,
        status: status,
        timestamp: new Date().toISOString(),
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// ============================================
// ЭКСПОРТ ПРИЛОЖЕНИЯ
// ============================================

module.exports = app;