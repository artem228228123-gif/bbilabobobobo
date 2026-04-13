/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/routes/auth.js
 * Описание: Маршруты авторизации (регистрация, вход, восстановление пароля, OAuth)
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const axios = require('axios');

const router = express.Router();
const { User } = require('../models');
const { config, isFinanceEnabled } = require('../../config/env');
const { sendEmail } = require('../services/emailService');
const { addJob } = require('../../config/redis');

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

// Генерация JWT токена
function generateToken(userId, email, name, role) {
    return jwt.sign(
        { id: userId, email, name, role },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn }
    );
}

// Генерация refresh токена
function generateRefreshToken(userId) {
    return jwt.sign(
        { id: userId, type: 'refresh' },
        config.jwt.secret,
        { expiresIn: config.jwt.refreshExpiresIn }
    );
}

// Установка cookie с токеном
function setTokenCookie(res, token) {
    res.cookie('token', token, {
        httpOnly: true,
        secure: config.app.isProduction,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 дней
    });
}

// Генерация кода подтверждения email
function generateVerificationCode() {
    return crypto.randomBytes(32).toString('hex');
}

// Генерация кода сброса пароля
function generateResetCode() {
    return crypto.randomBytes(32).toString('hex');
}

// Валидация ошибок
function validate(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    return null;
}

// ============================================
// POST /api/v1/auth/register
// Регистрация нового пользователя
// ============================================
router.post(
    '/register',
    [
        body('name').notEmpty().withMessage('Имя обязательно').isLength({ min: 2, max: 50 }),
        body('email').isEmail().withMessage('Неверный формат email').normalizeEmail(),
        body('password').isLength({ min: 6 }).withMessage('Пароль должен быть минимум 6 символов'),
        body('password_confirm').custom((value, { req }) => value === req.body.password)
            .withMessage('Пароли не совпадают'),
        body('phone').optional().isMobilePhone('any').withMessage('Неверный формат телефона'),
        body('city').optional().isString().isLength({ max: 100 }),
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { name, email, password, phone, city, referralCode } = req.body;

        try {
            // Проверяем, существует ли пользователь
            const existingUser = await User.findByEmail(email);
            if (existingUser) {
                return res.status(400).json({ error: 'Пользователь с таким email уже существует' });
            }

            // Хешируем пароль
            const passwordHash = await bcrypt.hash(password, config.security.bcryptRounds);

            // Генерируем реферальный код
            const userReferralCode = crypto.randomBytes(6).toString('hex').toUpperCase();

            // Создаём пользователя
            const user = await User.create({
                name,
                email,
                passwordHash,
                phone,
                city,
                referralCode: userReferralCode,
            });

            // Начисляем приветственные бонусы (100)
            await User.addBonus(user.id, 100, 'welcome');

            // Обработка реферала
            if (referralCode) {
                const referrer = await User.findByReferralCode(referralCode);
                if (referrer && referrer.id !== user.id) {
                    // Начисляем бонус пригласившему (50)
                    await User.addBonus(referrer.id, 50, 'referral_registration', user.id);
                    
                    // Обновляем referred_by у нового пользователя
                    await User.update(user.id, { referred_by: referrer.id });
                }
            }

            // Генерируем код подтверждения email
            const verifyCode = generateVerificationCode();
            await User.update(user.id, { email_verify_code: verifyCode });

            // Отправляем письмо с подтверждением (в фоне)
            await addJob('emailQueue', 'sendVerificationEmail', {
                to: email,
                name: name,
                code: verifyCode,
            });

            // Генерируем токен
            const token = generateToken(user.id, user.email, user.name, user.role);
            setTokenCookie(res, token);

            // Отправляем ответ
            res.status(201).json({
                success: true,
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    phone: user.phone,
                    city: user.city,
                    avatar: user.avatar,
                    role: user.role,
                    bonusBalance: user.bonus_balance,
                    referralCode: user.referral_code,
                },
                token,
                message: 'Регистрация успешна. Подтвердите email, перейдя по ссылке в письме.',
            });

        } catch (error) {
            console.error('Ошибка регистрации:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/auth/login
// Вход в систему
// ============================================
router.post(
    '/login',
    [
        body('email').isEmail().withMessage('Неверный формат email'),
        body('password').notEmpty().withMessage('Пароль обязателен'),
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { email, password } = req.body;

        try {
            // Ищем пользователя
            const user = await User.findByEmail(email);
            if (!user) {
                return res.status(401).json({ error: 'Неверный email или пароль' });
            }

            // Проверяем статус
            if (user.status === 'blocked') {
                const blockedUntil = user.blocked_until;
                if (blockedUntil && new Date(blockedUntil) > new Date()) {
                    return res.status(403).json({ 
                        error: `Аккаунт заблокирован до ${new Date(blockedUntil).toLocaleString()}`,
                        blockedUntil,
                    });
                } else if (user.status === 'blocked') {
                    // Автоматическая разблокировка
                    await User.unblock(user.id);
                }
            }

            if (user.status === 'deleted') {
                return res.status(403).json({ error: 'Аккаунт удалён' });
            }

            // Проверяем пароль
            const isValid = await bcrypt.compare(password, user.password_hash);
            if (!isValid) {
                return res.status(401).json({ error: 'Неверный email или пароль' });
            }

            // Обновляем last_seen
            await User.updateLastSeen(user.id);

            // Генерируем токен
            const token = generateToken(user.id, user.email, user.name, user.role);
            setTokenCookie(res, token);

            // Отправляем ответ
            res.json({
                success: true,
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    phone: user.phone,
                    city: user.city,
                    avatar: user.avatar,
                    role: user.role,
                    bonusBalance: user.bonus_balance,
                    emailVerified: user.email_verified,
                },
                token,
            });

        } catch (error) {
            console.error('Ошибка входа:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/auth/logout
// Выход из системы
// ============================================
router.post('/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true, message: 'Выход выполнен успешно' });
});

// ============================================
// GET /api/v1/auth/me
// Получение текущего пользователя
// ============================================
router.get('/me', async (req, res) => {
    const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Не авторизован' });
    }

    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        const user = await User.findById(decoded.id);
        
        if (!user) {
            return res.status(401).json({ error: 'Пользователь не найден' });
        }

        const stats = await User.getStats(user.id);
        const streak = await require('../models').Bonus.getStreak(user.id);

        res.json({
            user: {
                ...user,
                stats,
                streak: streak.streak,
            },
        });
    } catch (error) {
        res.status(401).json({ error: 'Неверный токен' });
    }
});

// ============================================
// POST /api/v1/auth/refresh-token
// Обновление JWT токена
// ============================================
router.post('/refresh-token', async (req, res) => {
    const token = req.cookies.token;
    
    if (!token) {
        return res.status(401).json({ error: 'Токен не предоставлен' });
    }

    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        const user = await User.findById(decoded.id);
        
        if (!user) {
            return res.status(401).json({ error: 'Пользователь не найден' });
        }

        const newToken = generateToken(user.id, user.email, user.name, user.role);
        setTokenCookie(res, newToken);

        res.json({ token: newToken });
    } catch (error) {
        res.status(401).json({ error: 'Неверный токен' });
    }
});

// ============================================
// POST /api/v1/auth/forgot-password
// Запрос на восстановление пароля
// ============================================
router.post(
    '/forgot-password',
    [body('email').isEmail().withMessage('Неверный формат email')],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { email } = req.body;

        try {
            const user = await User.findByEmail(email);
            if (!user) {
                // Не раскрываем существование пользователя
                return res.json({ success: true, message: 'Если аккаунт существует, письмо отправлено' });
            }

            const resetCode = generateResetCode();
            const resetExpires = new Date(Date.now() + 3600000); // 1 час

            await User.update(user.id, {
                reset_password_code: resetCode,
                reset_password_expires: resetExpires,
            });

            // Отправляем письмо
            await addJob('emailQueue', 'sendResetPasswordEmail', {
                to: email,
                name: user.name,
                code: resetCode,
            });

            res.json({ success: true, message: 'Письмо для сброса пароля отправлено' });

        } catch (error) {
            console.error('Ошибка восстановления:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/auth/reset-password
// Сброс пароля
// ============================================
router.post(
    '/reset-password',
    [
        body('code').notEmpty().withMessage('Код обязателен'),
        body('new_password').isLength({ min: 6 }).withMessage('Пароль должен быть минимум 6 символов'),
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { code, new_password } = req.body;

        try {
            const user = await User.findByResetCode(code);
            
            if (!user) {
                return res.status(400).json({ error: 'Неверный или просроченный код' });
            }

            if (new Date(user.reset_password_expires) < new Date()) {
                return res.status(400).json({ error: 'Код истёк. Запросите новый' });
            }

            const passwordHash = await bcrypt.hash(new_password, config.security.bcryptRounds);
            
            await User.update(user.id, {
                password_hash: passwordHash,
                reset_password_code: null,
                reset_password_expires: null,
            });

            res.json({ success: true, message: 'Пароль успешно изменён' });

        } catch (error) {
            console.error('Ошибка сброса пароля:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/auth/verify-email/:code
// Подтверждение email
// ============================================
router.get('/verify-email/:code', async (req, res) => {
    const { code } = req.params;

    try {
        const user = await User.findByVerifyCode(code);
        
        if (!user) {
            return res.status(400).json({ error: 'Неверный код подтверждения' });
        }

        await User.update(user.id, {
            email_verified: true,
            email_verify_code: null,
        });

        // Начисляем бонус за подтверждение email
        await User.addBonus(user.id, 50, 'email_verification');

        res.json({ success: true, message: 'Email подтверждён' });

    } catch (error) {
        console.error('Ошибка подтверждения email:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// POST /api/v1/auth/change-password
// Смена пароля (авторизованный пользователь)
// ============================================
router.post(
    '/change-password',
    [
        body('old_password').notEmpty().withMessage('Текущий пароль обязателен'),
        body('new_password').isLength({ min: 6 }).withMessage('Новый пароль должен быть минимум 6 символов'),
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: 'Не авторизован' });
        }

        const { old_password, new_password } = req.body;

        try {
            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }

            const isValid = await bcrypt.compare(old_password, user.password_hash);
            if (!isValid) {
                return res.status(400).json({ error: 'Неверный текущий пароль' });
            }

            const passwordHash = await bcrypt.hash(new_password, config.security.bcryptRounds);
            await User.update(userId, { password_hash: passwordHash });

            res.json({ success: true, message: 'Пароль изменён' });

        } catch (error) {
            console.error('Ошибка смены пароля:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GOOGLE OAuth
// ============================================
router.get('/google', (req, res) => {
    const redirectUri = config.oauth.google.redirectUri;
    const clientId = config.oauth.google.clientId;
    
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=email%20profile`;
    
    res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
    const { code } = req.query;
    
    try {
        // Обмениваем код на токен
        const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
            code,
            client_id: config.oauth.google.clientId,
            client_secret: config.oauth.google.clientSecret,
            redirect_uri: config.oauth.google.redirectUri,
            grant_type: 'authorization_code',
        });
        
        const { access_token } = tokenResponse.data;
        
        // Получаем информацию о пользователе
        const userInfo = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${access_token}` },
        });
        
        const { email, name, picture } = userInfo.data;
        
        // Ищем или создаём пользователя
        let user = await User.findByEmail(email);
        
        if (!user) {
            const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
            const referralCode = crypto.randomBytes(6).toString('hex').toUpperCase();
            
            user = await User.create({
                name: name || email.split('@')[0],
                email,
                passwordHash,
                avatar: picture,
                referralCode,
            });
            
            await User.addBonus(user.id, 100, 'welcome');
        }
        
        // Обновляем last_seen и аватар
        await User.updateLastSeen(user.id);
        if (picture && !user.avatar) {
            await User.update(user.id, { avatar: picture });
        }
        
        // Генерируем токен
        const token = generateToken(user.id, user.email, user.name, user.role);
        setTokenCookie(res, token);
        
        res.redirect(`${config.app.clientUrl}/auth/success?token=${token}`);
        
    } catch (error) {
        console.error('Google OAuth ошибка:', error);
        res.redirect(`${config.app.clientUrl}/login?error=google_auth_failed`);
    }
});

// ============================================
// YANDEX OAuth
// ============================================
router.get('/yandex', (req, res) => {
    const redirectUri = config.oauth.yandex.redirectUri;
    const clientId = config.oauth.yandex.clientId;
    
    const url = `https://oauth.yandex.ru/authorize?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}`;
    
    res.redirect(url);
});

router.get('/yandex/callback', async (req, res) => {
    const { code } = req.query;
    
    try {
        // Обмениваем код на токен
        const tokenResponse = await axios.post('https://oauth.yandex.ru/token', {
            grant_type: 'authorization_code',
            code,
            client_id: config.oauth.yandex.clientId,
            client_secret: config.oauth.yandex.clientSecret,
        });
        
        const { access_token } = tokenResponse.data;
        
        // Получаем информацию о пользователе
        const userInfo = await axios.get('https://login.yandex.ru/info', {
            headers: { Authorization: `OAuth ${access_token}` },
        });
        
        const { default_email, first_name, last_name, default_avatar_id } = userInfo.data;
        const name = `${first_name || ''} ${last_name || ''}`.trim() || default_email.split('@')[0];
        const avatar = default_avatar_id ? `https://avatars.yandex.net/get-yapic/${default_avatar_id}/islands-200` : null;
        
        // Ищем или создаём пользователя
        let user = await User.findByEmail(default_email);
        
        if (!user) {
            const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
            const referralCode = crypto.randomBytes(6).toString('hex').toUpperCase();
            
            user = await User.create({
                name,
                email: default_email,
                passwordHash,
                avatar,
                referralCode,
            });
            
            await User.addBonus(user.id, 100, 'welcome');
        }
        
        await User.updateLastSeen(user.id);
        
        const token = generateToken(user.id, user.email, user.name, user.role);
        setTokenCookie(res, token);
        
        res.redirect(`${config.app.clientUrl}/auth/success?token=${token}`);
        
    } catch (error) {
        console.error('Yandex OAuth ошибка:', error);
        res.redirect(`${config.app.clientUrl}/login?error=yandex_auth_failed`);
    }
});

// ============================================
// VK OAuth
// ============================================
router.get('/vk', (req, res) => {
    const redirectUri = config.oauth.vk.redirectUri;
    const clientId = config.oauth.vk.clientId;
    
    const url = `https://oauth.vk.com/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=email`;
    
    res.redirect(url);
});

router.get('/vk/callback', async (req, res) => {
    const { code } = req.query;
    
    try {
        // Обмениваем код на токен
        const tokenResponse = await axios.get('https://oauth.vk.com/access_token', {
            params: {
                client_id: config.oauth.vk.clientId,
                client_secret: config.oauth.vk.clientSecret,
                redirect_uri: config.oauth.vk.redirectUri,
                code,
            },
        });
        
        const { access_token, user_id, email } = tokenResponse.data;
        
        // Получаем информацию о пользователе
        const userInfo = await axios.get('https://api.vk.com/method/users.get', {
            params: {
                access_token,
                user_ids: user_id,
                fields: 'photo_200',
                v: '5.131',
            },
        });
        
        const vkUser = userInfo.data.response[0];
        const name = `${vkUser.first_name} ${vkUser.last_name}`;
        const avatar = vkUser.photo_200;
        
        const userEmail = email || `${user_id}@vk.com`;
        
        // Ищем или создаём пользователя
        let user = await User.findByEmail(userEmail);
        
        if (!user) {
            const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
            const referralCode = crypto.randomBytes(6).toString('hex').toUpperCase();
            
            user = await User.create({
                name,
                email: userEmail,
                passwordHash,
                avatar,
                referralCode,
            });
            
            await User.addBonus(user.id, 100, 'welcome');
        }
        
        await User.updateLastSeen(user.id);
        
        const token = generateToken(user.id, user.email, user.name, user.role);
        setTokenCookie(res, token);
        
        res.redirect(`${config.app.clientUrl}/auth/success?token=${token}`);
        
    } catch (error) {
        console.error('VK OAuth ошибка:', error);
        res.redirect(`${config.app.clientUrl}/login?error=vk_auth_failed`);
    }
});

// ============================================
// ЭКСПОРТ
// ============================================
module.exports = router;