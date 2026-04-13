/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/routes/bonus.js
 * Описание: Бонусная система (ежедневный бонус, история транзакций, рефералы, лотерея)
 */

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');

const router = express.Router();
const { User, Bonus, Lottery } = require('../models');
const { authenticate } = require('../middleware/auth');
const { get, set, del, incr, sadd, sismember } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { config } = require('../../config/env');

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

// ============================================
// GET /api/v1/bonus/balance
// Получение баланса бонусов пользователя
// ============================================
router.get('/balance', authenticate, async (req, res) => {
    try {
        const balance = await Bonus.getBalance(req.user.id);
        const streak = await Bonus.getStreak(req.user.id);
        
        res.json({
            success: true,
            balance,
            streak: streak.streak,
            lastClaim: streak.lastClaim
        });
    } catch (error) {
        console.error('Ошибка получения баланса:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// POST /api/v1/bonus/daily
// Получение ежедневного бонуса
// ============================================
router.post('/daily', authenticate, async (req, res) => {
    try {
        const result = await Bonus.claimDaily(req.user.id);
        
        if (!result.success) {
            return res.status(400).json({ error: result.message });
        }
        
        // Обновляем кеш
        await del(`user:${req.user.id}`);
        
        res.json({
            success: true,
            amount: result.amount,
            streak: result.streak,
            newBalance: result.newBalance,
            message: `Вы получили ${result.amount} бонусов! День ${result.streak} подряд.`
        });
    } catch (error) {
        console.error('Ошибка получения ежедневного бонуса:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/bonus/history
// История транзакций
// ============================================
router.get(
    '/history',
    authenticate,
    [
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('offset').optional().isInt({ min: 0 }),
        query('type').optional().isString()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { limit = 50, offset = 0, type } = req.query;

        try {
            let sql = `
                SELECT id, amount, type, reference_id, created_at,
                       CASE 
                           WHEN amount > 0 THEN '+'
                           ELSE ''
                       END || amount as amount_formatted,
                       CASE 
                           WHEN amount > 0 THEN 'Начисление'
                           ELSE 'Списание'
                       END as operation_type,
                       CASE type
                           WHEN 'welcome' THEN 'Приветственный бонус'
                           WHEN 'daily' THEN 'Ежедневный бонус'
                           WHEN 'referral_registration' THEN 'Бонус за регистрацию реферала'
                           WHEN 'referral_sale' THEN 'Бонус за продажу реферала'
                           WHEN 'lottery_ticket' THEN 'Покупка лотерейного билета'
                           WHEN 'lottery_win' THEN 'Выигрыш в лотерее'
                           WHEN 'listing_create' THEN 'Создание объявления'
                           WHEN 'listing_sold' THEN 'Продажа товара'
                           WHEN 'email_verification' THEN 'Подтверждение email'
                           WHEN 'review' THEN 'Написание отзыва'
                           WHEN 'transfer' THEN 'Перевод бонусов'
                           ELSE type
                       END as type_name
                FROM bonus_transactions
                WHERE user_id = $1
            `;
            const params = [req.user.id];

            if (type) {
                sql += ` AND type = $${params.length + 1}`;
                params.push(type);
            }

            sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            params.push(parseInt(limit), parseInt(offset));

            const result = await Bonus.query(sql, params);
            
            const countResult = await Bonus.query(
                `SELECT COUNT(*) FROM bonus_transactions WHERE user_id = $1`,
                [req.user.id]
            );
            const total = parseInt(countResult.rows[0].count);

            res.json({
                success: true,
                transactions: result.rows,
                pagination: {
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    total,
                    hasMore: offset + result.rows.length < total
                }
            });
        } catch (error) {
            console.error('Ошибка получения истории:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/bonus/transfer
// Перевод бонусов другому пользователю
// ============================================
router.post(
    '/transfer',
    authenticate,
    [
        body('to_user_id').isInt().withMessage('ID получателя обязателен'),
        body('amount').isInt({ min: 10, max: 10000 }).withMessage('Сумма от 10 до 10000 бонусов')
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { to_user_id, amount } = req.body;

        if (req.user.id === parseInt(to_user_id)) {
            return res.status(400).json({ error: 'Нельзя перевести бонусы самому себе' });
        }

        try {
            const balance = await Bonus.getBalance(req.user.id);
            if (balance < amount) {
                return res.status(400).json({ error: 'Недостаточно бонусов' });
            }

            // Списание у отправителя
            await User.addBonus(req.user.id, -amount, 'transfer_out', to_user_id);
            
            // Начисление получателю
            await User.addBonus(parseInt(to_user_id), amount, 'transfer_in', req.user.id);

            // Очищаем кеш
            await del(`user:${req.user.id}`);
            await del(`user:${to_user_id}`);

            res.json({
                success: true,
                message: `Переведено ${amount} бонусов пользователю`,
                newBalance: await Bonus.getBalance(req.user.id)
            });
        } catch (error) {
            console.error('Ошибка перевода бонусов:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/bonus/referral/info
// Реферальная информация
// ============================================
router.get('/referral/info', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const referralLink = `${config.app.clientUrl}/register?ref=${user.referral_code}`;
        
        // Статистика рефералов
        const referralsResult = await Bonus.query(
            `SELECT COUNT(*) as count, 
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                    SUM(bonus_earned) as total_bonus
             FROM referrals WHERE referrer_id = $1`,
            [req.user.id]
        );
        
        // Список приглашённых
        const invitedResult = await Bonus.query(
            `SELECT r.*, u.name, u.email, u.created_at,
                    CASE WHEN u.email_verified THEN 'Активен' ELSE 'Ожидает' END as status
             FROM referrals r
             JOIN users u ON u.id = r.referred_id
             WHERE r.referrer_id = $1
             ORDER BY r.created_at DESC
             LIMIT 20`,
            [req.user.id]
        );

        res.json({
            success: true,
            referral: {
                code: user.referral_code,
                link: referralLink,
                bonusPerRegistration: config.modules.referral.registrationBonus,
                bonusPerSale: config.modules.referral.saleBonus
            },
            stats: {
                totalInvited: parseInt(referralsResult.rows[0].count),
                completed: parseInt(referralsResult.rows[0].completed),
                totalBonus: parseInt(referralsResult.rows[0].total_bonus)
            },
            invited: invitedResult.rows
        });
    } catch (error) {
        console.error('Ошибка получения реферальной информации:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/bonus/lottery/current
// Текущий розыгрыш лотереи
// ============================================
router.get('/lottery/current', authenticate, async (req, res) => {
    try {
        const draw = await Lottery.getCurrentDraw();
        const userTickets = await Lottery.getUserTickets(req.user.id, draw.id);
        
        // Время до розыгрыша
        const now = new Date();
        const drawDate = new Date(draw.draw_date);
        const timeLeft = drawDate - now;
        
        const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
        const hours = Math.floor((timeLeft % (86400000)) / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (3600000)) / (1000 * 60));
        
        res.json({
            success: true,
            lottery: {
                id: draw.id,
                weekNumber: draw.week_number,
                prizePool: draw.prize_pool,
                ticketPrice: config.modules.lottery.ticketPrice,
                drawDate: draw.draw_date,
                timeLeft: {
                    days, hours, minutes,
                    totalSeconds: Math.floor(timeLeft / 1000)
                },
                userTickets: userTickets.length,
                userTicketsList: userTickets
            }
        });
    } catch (error) {
        console.error('Ошибка получения лотереи:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// POST /api/v1/bonus/lottery/buy
// Покупка лотерейного билета
// ============================================
router.post(
    '/lottery/buy',
    authenticate,
    [
        body('quantity').optional().isInt({ min: 1, max: 100 })
    ],
    async (req, res) => {
        const { quantity = 1 } = req.body;

        try {
            const result = await Lottery.buyTicket(req.user.id, quantity);
            
            if (!result.success) {
                return res.status(400).json({ error: result.message });
            }
            
            // Обновляем кеш
            await del(`user:${req.user.id}`);
            
            res.json({
                success: true,
                tickets: result.tickets,
                totalCost: result.totalCost,
                newBalance: result.newBalance,
                message: `Куплено ${quantity} билет(ов) за ${result.totalCost} бонусов`
            });
        } catch (error) {
            console.error('Ошибка покупки билета:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/bonus/lottery/winners
// Победители прошлых розыгрышей
// ============================================
router.get('/lottery/winners', async (req, res) => {
    try {
        const winners = await Lottery.getWinners(20);
        res.json({ success: true, winners });
    } catch (error) {
        console.error('Ошибка получения победителей:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/bonus/streak
// Текущая серия (streak) пользователя
// ============================================
router.get('/streak', authenticate, async (req, res) => {
    try {
        const streak = await Bonus.getStreak(req.user.id);
        
        // Бонус за следующий день
        let nextBonus = 100;
        if (streak.streak > 0) {
            nextBonus = 100 + Math.min(streak.streak * 10, 100);
        }
        
        res.json({
            success: true,
            streak: streak.streak,
            lastClaim: streak.lastClaim,
            nextBonus,
            maxStreakBonus: 200
        });
    } catch (error) {
        console.error('Ошибка получения streak:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/bonus/leaderboard
// Топ пользователей по бонусам
// ============================================
router.get(
    '/leaderboard',
    [
        query('limit').optional().isInt({ min: 1, max: 100 })
    ],
    async (req, res) => {
        const { limit = 50 } = req.query;

        try {
            const cached = await get('bonus:leaderboard');
            if (cached) {
                return res.json({ success: true, leaderboard: cached, fromCache: true });
            }
            
            const result = await Bonus.query(
                `SELECT id, name, avatar, bonus_balance, city,
                        RANK() OVER (ORDER BY bonus_balance DESC) as rank
                 FROM users
                 WHERE status = 'active' AND bonus_balance > 0
                 ORDER BY bonus_balance DESC
                 LIMIT $1`,
                [parseInt(limit)]
            );
            
            await set('bonus:leaderboard', result.rows, 3600);
            
            res.json({
                success: true,
                leaderboard: result.rows,
                userRank: null // можно добавить ранг текущего пользователя
            });
        } catch (error) {
            console.error('Ошибка получения лидерборда:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/bonus/redeem
// Обмен бонусов на услуги
// ============================================
router.post(
    '/redeem',
    authenticate,
    [
        body('service').isIn(['bump', 'vip', 'highlight', 'lottery_ticket']),
        body('listing_id').optional().isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { service, listing_id } = req.body;

        const prices = {
            bump: 500,
            vip: 1000,
            highlight: 300,
            lottery_ticket: 100
        };

        const price = prices[service];
        if (!price) {
            return res.status(400).json({ error: 'Услуга не найдена' });
        }

        try {
            const balance = await Bonus.getBalance(req.user.id);
            if (balance < price) {
                return res.status(400).json({ error: 'Недостаточно бонусов' });
            }

            let result = null;

            switch (service) {
                case 'bump':
                    if (!listing_id) {
                        return res.status(400).json({ error: 'ID объявления обязателен' });
                    }
                    // Обновляем время объявления
                    await Bonus.query(
                        `UPDATE listings SET created_at = NOW(), bumped_at = NOW() WHERE id = $1 AND user_id = $2`,
                        [listing_id, req.user.id]
                    );
                    result = { message: 'Объявление поднято в топ' };
                    break;
                    
                case 'vip':
                    if (!listing_id) {
                        return res.status(400).json({ error: 'ID объявления обязателен' });
                    }
                    await Bonus.query(
                        `UPDATE listings SET is_vip = true, vip_until = NOW() + INTERVAL '30 days' 
                         WHERE id = $1 AND user_id = $2`,
                        [listing_id, req.user.id]
                    );
                    result = { message: 'VIP-статус активирован на 30 дней' };
                    break;
                    
                case 'highlight':
                    if (!listing_id) {
                        return res.status(400).json({ error: 'ID объявления обязателен' });
                    }
                    await Bonus.query(
                        `UPDATE listings SET is_highlighted = true, highlighted_until = NOW() + INTERVAL '7 days'
                         WHERE id = $1 AND user_id = $2`,
                        [listing_id, req.user.id]
                    );
                    result = { message: 'Выделение объявления активировано на 7 дней' };
                    break;
                    
                case 'lottery_ticket':
                    const ticket = await Lottery.buyTicket(req.user.id, 1);
                    if (!ticket.success) {
                        return res.status(400).json({ error: ticket.message });
                    }
                    result = { message: 'Лотерейный билет куплен', ticket: ticket.tickets[0] };
                    break;
            }

            // Списываем бонусы
            await User.addBonus(req.user.id, -price, service, listing_id || null);
            await del(`user:${req.user.id}`);

            res.json({
                success: true,
                ...result,
                spent: price,
                newBalance: await Bonus.getBalance(req.user.id)
            });
        } catch (error) {
            console.error('Ошибка обмена бонусов:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = router;