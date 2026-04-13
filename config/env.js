const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';

const config = {
    app: {
        env: process.env.NODE_ENV || 'development',
        port: parseInt(process.env.PORT, 10) || 3000,
        clientUrl: clientUrl,
        isProduction: process.env.NODE_ENV === 'production',
        isDevelopment: process.env.NODE_ENV === 'development',
    },
    database: {
        url: process.env.DATABASE_URL || 'postgresql://aida:aida123@localhost:5432/aida',
    },
    redis: {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
    },
    jwt: {
        secret: process.env.JWT_SECRET || 'your_secret_key',
        expiresIn: '7d',
    },
    oauth: {
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            redirectUri: `${clientUrl}/api/v1/auth/google/callback`,
            enabled: !!process.env.GOOGLE_CLIENT_ID,
        },
        yandex: {
            clientId: process.env.YANDEX_CLIENT_ID,
            clientSecret: process.env.YANDEX_CLIENT_SECRET,
            redirectUri: `${clientUrl}/api/v1/auth/yandex/callback`,
            enabled: !!process.env.YANDEX_CLIENT_ID,
        },
        vk: {
            clientId: process.env.VK_CLIENT_ID,
            clientSecret: process.env.VK_CLIENT_SECRET,
            redirectUri: `${clientUrl}/api/v1/auth/vk/callback`,
            enabled: !!process.env.VK_CLIENT_ID,
        },
        telegram: {
            botToken: process.env.TELEGRAM_BOT_TOKEN,
            enabled: !!process.env.TELEGRAM_BOT_TOKEN,
        },
    },
    modules: {
        finance: { enabled: false },
        delivery: { enabled: false },
        bonuses: { enabled: true },
        lottery: { enabled: true },
        auction: { enabled: true },
        tiktok: { enabled: true },
        map: { enabled: true },
    },
};

module.exports = { config };
