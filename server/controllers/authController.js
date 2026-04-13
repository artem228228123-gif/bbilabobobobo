/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/controllers/authController.js
 * Описание: Контроллер авторизации (регистрация, вход, восстановление)
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { User } = require('../models');
const { config } = require('../../config/env');
const { sendEmail } = require('../services/emailService');
const { addJob } = require('../../config/redis');
const { set, del } = require('../../config/redis');

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function generateToken(userId, email, name, role) {
    return jwt.sign(
        { id: userId, email, name, role },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn }
    );
}

function generateRefreshToken(userId) {
    return jwt.sign(
        { id: userId, type: 'refresh' },
        config.jwt.secret,
        { expiresIn: config.jwt.refreshExpiresIn }
    );
}

function setTokenCookie(res, token) {
    res.cookie('token', token, {
        httpOnly: true,
        secure: config.app.isProduction,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    });
}

// ============================================
// РЕГИСТРАЦИЯ
// ============================================

async function register(req, res) {
    const { name, email, password, phone, city, referralCode } = req.body;

    try {
        const existingUser = await User.findByEmail(email);
        if (existingUser) {
            return res.status(400).json({ error: 'Пользователь с таким email уже существует' });
        }

        const passwordHash = await bcrypt.hash(password, config.security.bcryptRounds);
        const userReferralCode = crypto.randomBytes(6).toString('hex').toUpperCase();

        const user = await User.create({
            name,
            email,
            passwordHash,
            phone,
            city,
            referralCode: userReferralCode
        });

        await User.addBonus(user.id, 100, 'welcome');

        if (referralCode) {
            const referrer = await User.findByReferralCode(referralCode);
            if (referrer && referrer.id !== user.id) {
                await User.addBonus(referrer.id, 50, 'referral_registration', user.id);
                await User.update(user.id, { referred_by: referrer.id });
            }
        }

        const verifyCode = crypto.randomBytes(32).toString('hex');
        await User.update(user.id, { email_verify_code: verifyCode });

        await addJob('emailQueue', 'sendVerificationEmail', {
            to: email,
            name: name,
            code: verifyCode
        });

        const token = generateToken(user.id, user.email, user.name, user.role);
        setTokenCookie(res, token);

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
                referralCode: user.referral_code
            },
            token
        });
    } catch (error) {
        console.error('Ошибка регистрации:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ВХОД
// ============================================

async function login(req, res) {
    const { email, password } = req.body;

    try {
        const user = await User.findByEmail(email);
        if (!user) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }

        if (user.status === 'blocked') {
            const blockedUntil = user.blocked_until;
            if (blockedUntil && new Date(blockedUntil) > new Date()) {
                return res.status(403).json({ 
                    error: `Аккаунт заблокирован до ${new Date(blockedUntil).toLocaleString()}`,
                    blockedUntil
                });
            }
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }

        await User.updateLastSeen(user.id);

        const token = generateToken(user.id, user.email, user.name, user.role);
        setTokenCookie(res, token);

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
                emailVerified: user.email_verified
            },
            token
        });
    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ВЫХОД
// ============================================

function logout(req, res) {
    res.clearCookie('token');
    res.json({ success: true, message: 'Выход выполнен успешно' });
}

// ============================================
// ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ
// ============================================

async function getMe(req, res) {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        const stats = await User.getStats(req.user.id);
        const streak = await User.getStreak?.(req.user.id) || { streak: 0 };

        res.json({
            success: true,
            user: {
                ...user,
                stats,
                streak: streak.streak
            }
        });
    } catch (error) {
        console.error('Ошибка получения профиля:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    register,
    login,
    logout,
    getMe
};