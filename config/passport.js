/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: config/passport.js
 * Описание: Настройка Passport.js для OAuth аутентификации (Google, Yandex, VK, Telegram)
 */

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const YandexStrategy = require('passport-yandex').Strategy;
const VKStrategy = require('passport-vkontakte').Strategy;
const TelegramStrategy = require('passport-telegram-official').Strategy;
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { User } = require('../server/models');
const { config } = require('./env');
const { addJob } = require('./redis');

// ============================================
// СЕРИАЛИЗАЦИЯ ПОЛЬЗОВАТЕЛЯ
// ============================================

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (error) {
        done(error, null);
    }
});

// ============================================
= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

/**
 * Создание или обновление пользователя через OAuth
 * @param {Object} profile - профиль из OAuth
 * @param {string} provider - провайдер (google, yandex, vk, telegram)
 * @returns {Promise<Object>} - пользователь
 */
async function findOrCreateOAuthUser(profile, provider) {
    const email = profile.emails?.[0]?.value || `${provider}_${profile.id}@${provider}.com`;
    const name = profile.displayName || profile.name?.givenName || email.split('@')[0];
    const avatar = profile.photos?.[0]?.value || null;
    
    // Ищем существующего пользователя
    let user = await User.findByEmail(email);
    
    if (user) {
        // Обновляем аватар если его нет
        if (avatar && !user.avatar) {
            await User.update(user.id, { avatar });
        }
        return user;
    }
    
    // Создаём нового пользователя
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const passwordHash = await bcrypt.hash(randomPassword, 10);
    const referralCode = crypto.randomBytes(6).toString('hex').toUpperCase();
    
    user = await User.create({
        name,
        email,
        passwordHash,
        avatar,
        referralCode,
        email_verified: true // OAuth пользователи已验证
    });
    
    // Начисляем приветственный бонус
    await User.addBonus(user.id, 100, 'welcome');
    
    // Отправляем приветственное письмо
    await addJob('emailQueue', 'sendWelcomeEmail', {
        to: email,
        name: name,
        provider
    });
    
    return user;
}

// ============================================
= GOOGLE STRATEGY
// ============================================

if (config.oauth.google.enabled) {
    passport.use(new GoogleStrategy({
        clientID: config.oauth.google.clientId,
        clientSecret: config.oauth.google.clientSecret,
        callbackURL: config.oauth.google.redirectUri,
        scope: ['profile', 'email'],
        proxy: true
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            const user = await findOrCreateOAuthUser(profile, 'google');
            done(null, user);
        } catch (error) {
            console.error('Google OAuth error:', error);
            done(error, null);
        }
    }));
}

// ============================================
= YANDEX STRATEGY
// ============================================

if (config.oauth.yandex.enabled) {
    passport.use(new YandexStrategy({
        clientID: config.oauth.yandex.clientId,
        clientSecret: config.oauth.yandex.clientSecret,
        callbackURL: config.oauth.yandex.redirectUri,
        scope: ['login:email', 'login:avatar']
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            // Адаптируем профиль Яндекса к стандартному формату
            const adaptedProfile = {
                id: profile.id,
                displayName: profile.displayName,
                emails: [{ value: profile.emails?.[0]?.value }],
                photos: [{ value: profile.photos?.[0]?.value }]
            };
            const user = await findOrCreateOAuthUser(adaptedProfile, 'yandex');
            done(null, user);
        } catch (error) {
            console.error('Yandex OAuth error:', error);
            done(error, null);
        }
    }));
}

// ============================================
= VK STRATEGY
// ============================================

if (config.oauth.vk.enabled) {
    passport.use(new VKStrategy({
        clientID: config.oauth.vk.clientId,
        clientSecret: config.oauth.vk.clientSecret,
        callbackURL: config.oauth.vk.redirectUri,
        scope: ['email', 'photos'],
        apiVersion: '5.131'
    }, async (accessToken, refreshToken, params, profile, done) => {
        try {
            // Адаптируем профиль VK к стандартному формату
            const adaptedProfile = {
                id: profile.id,
                displayName: `${profile.name?.givenName || ''} ${profile.name?.familyName || ''}`.trim() || profile.id,
                emails: [{ value: params.email || `${profile.id}@vk.com` }],
                photos: [{ value: profile.photos?.[0]?.value }]
            };
            const user = await findOrCreateOAuthUser(adaptedProfile, 'vk');
            done(null, user);
        } catch (error) {
            console.error('VK OAuth error:', error);
            done(error, null);
        }
    }));
}

// ============================================
= TELEGRAM STRATEGY
// ============================================

if (config.oauth.telegram.enabled) {
    passport.use(new TelegramStrategy({
        botToken: config.oauth.telegram.botToken,
        passReqToCallback: false
    }, async (profile, done) => {
        try {
            // Адаптируем профиль Telegram к стандартному формату
            const adaptedProfile = {
                id: profile.id,
                displayName: `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || profile.username || profile.id,
                emails: [{ value: `${profile.id}@telegram.com` }],
                photos: [{ value: profile.photo_url }]
            };
            const user = await findOrCreateOAuthUser(adaptedProfile, 'telegram');
            
            // Сохраняем Telegram ID для уведомлений
            await User.update(user.id, { social_telegram: profile.id });
            
            done(null, user);
        } catch (error) {
            console.error('Telegram OAuth error:', error);
            done(error, null);
        }
    }));
}

// ============================================
= МИДЛВАРЫ
// ============================================

/**
 * Мидлвара для проверки аутентификации
 */
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.status(401).json({ error: 'Не авторизован' });
}

/**
 * Мидлвара для проверки роли администратора
 */
function ensureAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user.role === 'admin') {
        return next();
    }
    res.status(403).json({ error: 'Доступ запрещён. Требуются права администратора.' });
}

/**
 * Мидлвара для проверки роли модератора
 */
function ensureModerator(req, res, next) {
    if (req.isAuthenticated() && (req.user.role === 'moderator' || req.user.role === 'admin')) {
        return next();
    }
    res.status(403).json({ error: 'Доступ запрещён. Требуются права модератора.' });
}

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    passport,
    ensureAuthenticated,
    ensureAdmin,
    ensureModerator,
    findOrCreateOAuthUser
};