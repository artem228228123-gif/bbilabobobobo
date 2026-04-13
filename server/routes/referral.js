/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/routes/referral.js
 * Описание: Маршруты для работы с реферальной системой
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');

const router = express.Router();
const { User, Bonus } = require('../models');
const { authenticate, isAdmin } = require('../middleware/auth');
const { get, set, del, sadd, smembers } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const REFERRAL_CONFIG = {
    registrationBonus: 50,
    saleBonus: 100,
    maxReferrals: 100,
    bonusDelayDays: 7
};

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function validate(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    return null;
}

async function generateReferralCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    const existing = await User.query(`SELECT id FROM users WHERE referral_code = $1`, [code]);
    if (existing.rows.length > 0) {
        return generateReferralCode();
    }
    return code;
}

async function updateReferralStats(userId) {
    const stats = await Bonus.query(`
        SELECT 
            COUNT(*) as total_invited,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(bonus_earned) as total_bonus
        FROM referrals WHERE referrer_id = $1
    `, [userId]);
    
    await set(`referral:stats:${userId}`, stats.rows[0], 300);
    return stats.rows[0];
}

// ============================================
// GET /api/v1/referral/info
// Получение реферальной информации
// ============================================
router.get('/info', authenticate, async (req, res) => {
    try {
        const cacheKey = `referral:info:${req.user.id}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }
        
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        const referralLink = `${config.app.clientUrl}/register?ref=${user.referral_code}`;
        const stats = await updateReferralStats(req.user.id);
        
        let referrerInfo = null;
        if (user.referred_by) {
            const referrer = await User.findById(user.referred_by);
            if (referrer) {
                referrerInfo = {
                    id: referrer.id,
                    name: referrer.name,
                    avatar: referrer.avatar
                };
            }
        }
        
        const response = {
            referral: {
                code: user.referral_code,
                link: referralLink,
                bonusPerRegistration: REFERRAL_CONFIG.registrationBonus,
                bonusPerSale: REFERRAL_CONFIG.saleBonus,
                maxReferrals: REFERRAL_CONFIG.maxReferrals
            },
            stats: {
                totalInvited: parseInt(stats.total_invited || 0),
                completed: parseInt(stats.completed || 0),
                totalBonus: parseInt(stats.total_bonus || 0)
            },
            referrer: referrerInfo
        };
        
        await set(cacheKey, response, 300);
        res.json({ success: true, ...response });
    } catch (error) {
        console.error('Ошибка получения реферальной информации:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/referral/list
// Список приглашённых пользователей
// ============================================
router.get(
    '/list',
    authenticate,
    [
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('offset').optional().isInt({ min: 0 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { limit = 50, offset = 0 } = req.query;

        try {
            const cacheKey = `referral:list:${req.user.id}:${limit}:${offset}`;
            const cached = await get(cacheKey);
            if (cached) {
                return res.json({ success: true, ...cached, fromCache: true });
            }
            
            const result = await Bonus.query(`
                SELECT r.*, u.name, u.email, u.avatar, u.created_at as registered_at,
                       u.email_verified, u.bonus_balance,
                       (SELECT COUNT(*) FROM listings WHERE user_id = u.id AND status = 'sold') as sales_count
                FROM referrals r
                JOIN users u ON u.id = r.referred_id
                WHERE r.referrer_id = $1
                ORDER BY r.created_at DESC
                LIMIT $2 OFFSET $3
            `, [req.user.id, parseInt(limit), parseInt(offset)]);
            
            const countResult = await Bonus.query(
                `SELECT COUNT(*) FROM referrals WHERE referrer_id = $1`,
                [req.user.id]
            );
            const total = parseInt(countResult.rows[0].count);
            
            const referrals = result.rows.map(ref => ({
                id: ref.id,
                user: {
                    id: ref.referred_id,
                    name: ref.name,
                    email: ref.email,
                    avatar: ref.avatar,
                    registeredAt: ref.registered_at,
                    emailVerified: ref.email_verified,
                    bonusBalance: ref.bonus_balance,
                    salesCount: parseInt(ref.sales_count || 0)
                },
                bonusEarned: ref.bonus_earned,
                status: ref.status,
                createdAt: ref.created_at,
                completedAt: ref.completed_at
            }));
            
            const response = {
                referrals,
                total,
                limit: parseInt(limit),
                offset: parseInt(offset),
                hasMore: offset + referrals.length < total
            };
            
            await set(cacheKey, response, 300);
            res.json({ success: true, ...response });
        } catch (error) {
            console.error('Ошибка получения списка приглашённых:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/referral/stats
// Детальная статистика рефералов
// ============================================
router.get('/stats', authenticate, async (req, res) => {
    try {
        const cacheKey = `referral:stats:${req.user.id}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, stats: cached, fromCache: true });
        }
        
        const overview = await Bonus.query(`
            SELECT 
                COUNT(*) as total_invited,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
                SUM(bonus_earned) as total_bonus,
                AVG(bonus_earned) as avg_bonus
            FROM referrals WHERE referrer_id = $1
        `, [req.user.id]);
        
        const monthlyStats = await Bonus.query(`
            SELECT 
                DATE_TRUNC('month', r.created_at) as month,
                COUNT(*) as invited_count,
                COUNT(CASE WHEN r.status = 'completed' THEN 1 END) as completed_count,
                SUM(r.bonus_earned) as bonus_earned
            FROM referrals r
            WHERE r.referrer_id = $1
            GROUP BY DATE_TRUNC('month', r.created_at)
            ORDER BY month DESC
            LIMIT 12
        `, [req.user.id]);
        
        const totalInvited = parseInt(overview.rows[0].total_invited || 0);
        const completed = parseInt(overview.rows[0].completed || 0);
        const conversionRate = totalInvited > 0 ? (completed / totalInvited * 100).toFixed(1) : 0;
        
        const stats = {
            overview: {
                totalInvited,
                completed,
                pending: parseInt(overview.rows[0].pending || 0),
                totalBonus: parseInt(overview.rows[0].total_bonus || 0),
                avgBonus: Math.round(overview.rows[0].avg_bonus || 0),
                conversionRate: parseFloat(conversionRate)
            },
            monthlyStats: monthlyStats.rows.map(stat => ({
                month: new Date(stat.month).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }),
                invitedCount: parseInt(stat.invited_count),
                completedCount: parseInt(stat.completed_count),
                bonusEarned: parseInt(stat.bonus_earned || 0)
            }))
        };
        
        await set(cacheKey, stats, 300);
        res.json({ success: true, stats });
    } catch (error) {
        console.error('Ошибка получения статистики рефералов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/referral/top
// Топ рефералов
// ============================================
router.get('/top', async (req, res) => {
    const { limit = 10 } = req.query;
    
    try {
        const cacheKey = `referral:top:${limit}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, topReferrers: cached, fromCache: true });
        }
        
        const result = await Bonus.query(`
            SELECT 
                u.id, u.name, u.avatar,
                COUNT(r.id) as invited_count,
                SUM(r.bonus_earned) as total_bonus
            FROM users u
            JOIN referrals r ON r.referrer_id = u.id
            WHERE u.status = 'active'
            GROUP BY u.id, u.name, u.avatar
            ORDER BY invited_count DESC
            LIMIT $1
        `, [parseInt(limit)]);
        
        const topReferrers = result.rows.map(ref => ({
            id: ref.id,
            name: ref.name,
            avatar: ref.avatar,
            invitedCount: parseInt(ref.invited_count),
            totalBonus: parseInt(ref.total_bonus || 0)
        }));
        
        await set(cacheKey, topReferrers, 3600);
        res.json({ success: true, topReferrers });
    } catch (error) {
        console.error('Ошибка получения топ рефералов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/referral/check/:code
// Проверка реферального кода
// ============================================
router.get(
    '/check/:code',
    [
        param('code').isString().isLength({ min: 8, max: 8 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { code } = req.params;

        try {
            const result = await User.query(
                `SELECT id, name FROM users WHERE referral_code = $1 AND status = 'active'`,
                [code]
            );
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Реферальный код не найден' });
            }
            
            res.json({
                success: true,
                valid: true,
                referrer: {
                    id: result.rows[0].id,
                    name: result.rows[0].name
                }
            });
        } catch (error) {
            console.error('Ошибка проверки реферального кода:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/referral/regenerate
// Генерация нового реферального кода
// ============================================
router.post('/regenerate', authenticate, async (req, res) => {
    try {
        const newCode = await generateReferralCode();
        
        await User.update(req.user.id, { referral_code: newCode });
        await del(`referral:info:${req.user.id}`);
        
        res.json({
            success: true,
            referral_code: newCode,
            message: 'Реферальный код обновлён'
        });
    } catch (error) {
        console.error('Ошибка генерации реферального кода:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// POST /api/v1/referral/invite
// Отправка приглашения
// ============================================
router.post(
    '/invite',
    authenticate,
    [
        body('email').isEmail().withMessage('Неверный формат email'),
        body('name').optional().isString().isLength({ min: 2, max: 50 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { email, name } = req.body;

        try {
            const user = await User.findById(req.user.id);
            const referralLink = `${config.app.clientUrl}/register?ref=${user.referral_code}`;
            
            await addJob('emailQueue', 'sendReferralInvitation', {
                to: email,
                name: name || email.split('@')[0],
                referrerName: user.name,
                referralLink
            });
            
            await sadd(`referral:invites:${req.user.id}`, email);
            
            res.json({
                success: true,
                message: `Приглашение отправлено на ${email}`
            });
        } catch (error) {
            console.error('Ошибка отправки приглашения:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/referral/admin/stats (только админ)
// Статистика реферальной системы
// ============================================
router.get('/admin/stats', authenticate, isAdmin, async (req, res) => {
    try {
        const stats = await Bonus.query(`
            SELECT 
                COUNT(DISTINCT referrer_id) as active_referrers,
                COUNT(*) as total_referrals,
                SUM(bonus_earned) as total_bonus_paid,
                AVG(bonus_earned) as avg_bonus_per_referral,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_referrals,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_referrals
            FROM referrals
        `);
        
        const topReferrers = await Bonus.query(`
            SELECT u.name, u.email, COUNT(r.id) as referrals_count, SUM(r.bonus_earned) as total_bonus
            FROM referrals r
            JOIN users u ON u.id = r.referrer_id
            GROUP BY u.id, u.name, u.email
            ORDER BY referrals_count DESC
            LIMIT 10
        `);
        
        res.json({
            success: true,
            stats: stats.rows[0],
            topReferrers: topReferrers.rows
        });
    } catch (error) {
        console.error('Ошибка получения статистики реферальной системы:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

module.exports = router;