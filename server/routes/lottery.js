/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/routes/lottery.js
 * Описание: Маршруты для работы с лотереей
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');

const router = express.Router();
const { User, Bonus, Lottery } = require('../models');
const { authenticate, isAdmin } = require('../middleware/auth');
const { get, set, del } = require('../../config/redis');
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

function getWeekNumber(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

function getNextDrawDate() {
    const now = new Date();
    const daysUntilSunday = (7 - now.getDay()) % 7;
    const nextSunday = new Date(now);
    nextSunday.setDate(now.getDate() + daysUntilSunday);
    nextSunday.setHours(20, 0, 0, 0);
    return nextSunday;
}

// ============================================
// GET /api/v1/lottery/current
// Получение текущего розыгрыша
// ============================================
router.get('/current', authenticate, async (req, res) => {
    try {
        const cacheKey = 'lottery:current';
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }
        
        const draw = await Lottery.getCurrentDraw();
        const userTickets = await Lottery.getUserTickets(req.user.id, draw.id);
        const now = new Date();
        const drawDate = new Date(draw.draw_date);
        const timeLeft = drawDate - now;
        
        const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
        const hours = Math.floor((timeLeft % (86400000)) / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (3600000)) / (1000 * 60));
        
        const participantsCount = await Lottery.query(
            `SELECT COUNT(DISTINCT user_id) FROM lottery_tickets WHERE draw_id = $1`,
            [draw.id]
        );
        
        const response = {
            lottery: {
                id: draw.id,
                weekNumber: draw.week_number,
                year: draw.year,
                prizePool: draw.prize_pool,
                ticketPrice: 100,
                drawDate: draw.draw_date,
                status: draw.status,
                timeLeft: {
                    days, hours, minutes,
                    totalSeconds: Math.floor(timeLeft / 1000),
                    formatted: `${days}д ${hours}ч ${minutes}м`
                },
                stats: {
                    totalTickets: draw.total_tickets || 0,
                    totalParticipants: parseInt(participantsCount.rows[0].count) || 0,
                    yourTickets: userTickets.length
                }
            },
            userTickets: userTickets.map(t => ({
                id: t.id,
                number: t.ticket_number,
                purchasedAt: t.created_at
            }))
        };
        
        await set(cacheKey, response, 60);
        res.json({ success: true, ...response });
    } catch (error) {
        console.error('Ошибка получения текущего розыгрыша:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// POST /api/v1/lottery/buy
// Покупка лотерейного билета
// ============================================
router.post(
    '/buy',
    authenticate,
    [
        body('quantity').optional().isInt({ min: 1, max: 100 })
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { quantity = 1 } = req.body;

        try {
            const draw = await Lottery.getCurrentDraw();
            
            if (new Date(draw.draw_date) < new Date()) {
                return res.status(400).json({ error: 'Розыгрыш уже завершён или начался' });
            }
            
            const result = await Lottery.buyTicket(req.user.id, quantity);
            
            if (!result.success) {
                return res.status(400).json({ error: result.message });
            }
            
            await del('lottery:current');
            await del(`lottery:user:${req.user.id}`);
            
            res.json({
                success: true,
                tickets: result.tickets,
                totalCost: result.totalCost,
                newBalance: result.newBalance,
                message: `Куплено ${quantity} билет(ов) за ${result.totalCost} бонусов. Удачи! 🍀`
            });
        } catch (error) {
            console.error('Ошибка покупки билета:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// GET /api/v1/lottery/tickets
// Получение билетов пользователя
// ============================================
router.get('/tickets', authenticate, async (req, res) => {
    const { drawId } = req.query;
    
    try {
        const cacheKey = `lottery:user:${req.user.id}:${drawId || 'all'}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, tickets: cached, fromCache: true });
        }
        
        const tickets = await Lottery.getUserTickets(req.user.id, drawId ? parseInt(drawId) : null);
        
        await set(cacheKey, tickets, 3600);
        res.json({ success: true, tickets });
    } catch (error) {
        console.error('Ошибка получения билетов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/lottery/winners
// Получение победителей
// ============================================
router.get('/winners', async (req, res) => {
    const { limit = 10 } = req.query;
    
    try {
        const cacheKey = `lottery:winners:${limit}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, winners: cached, fromCache: true });
        }
        
        const winners = await Lottery.getWinners(parseInt(limit));
        
        const winnersWithDetails = await Promise.all(winners.map(async (winner) => {
            const user = await User.findById(winner.winner_id);
            return {
                ...winner,
                winner_name: user?.name || 'Пользователь',
                winner_avatar: user?.avatar || null,
                prize_formatted: new Intl.NumberFormat('ru-RU').format(winner.winner_prize)
            };
        }));
        
        await set(cacheKey, winnersWithDetails, 3600);
        res.json({ success: true, winners: winnersWithDetails });
    } catch (error) {
        console.error('Ошибка получения победителей:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/lottery/history
// История розыгрышей
// ============================================
router.get('/history', async (req, res) => {
    const { limit = 10 } = req.query;
    
    try {
        const cacheKey = `lottery:history:${limit}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, draws: cached, fromCache: true });
        }
        
        const result = await Lottery.query(`
            SELECT d.*, u.name as winner_name, u.avatar as winner_avatar,
                   COUNT(t.id) as total_tickets,
                   COUNT(DISTINCT t.user_id) as total_participants
            FROM lottery_draws d
            LEFT JOIN lottery_tickets t ON t.draw_id = d.id
            LEFT JOIN users u ON u.id = d.winner_id
            WHERE d.status = 'completed'
            GROUP BY d.id, u.name, u.avatar
            ORDER BY d.draw_date DESC
            LIMIT $1
        `, [parseInt(limit)]);
        
        const draws = result.rows.map(draw => ({
            ...draw,
            prize_pool_formatted: new Intl.NumberFormat('ru-RU').format(draw.prize_pool),
            winner_prize_formatted: draw.winner_prize ? new Intl.NumberFormat('ru-RU').format(draw.winner_prize) : null,
            draw_date_formatted: new Date(draw.draw_date).toLocaleDateString('ru-RU')
        }));
        
        await set(cacheKey, draws, 3600);
        res.json({ success: true, draws });
    } catch (error) {
        console.error('Ошибка получения истории розыгрышей:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/lottery/stats
// Статистика лотереи
// ============================================
router.get('/stats', async (req, res) => {
    try {
        const cacheKey = 'lottery:stats';
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }
        
        const totalStats = await Lottery.query(`
            SELECT 
                COUNT(*) as total_draws,
                SUM(prize_pool) as total_prize_pool,
                SUM(winner_prize) as total_winners_prize,
                COUNT(DISTINCT winner_id) as unique_winners,
                SUM(total_tickets) as total_tickets_sold
            FROM lottery_draws
            WHERE status = 'completed'
        `);
        
        const monthlyStats = await Lottery.query(`
            SELECT 
                DATE_TRUNC('month', draw_date) as month,
                COUNT(*) as draws_count,
                SUM(prize_pool) as prize_pool,
                SUM(winner_prize) as winner_prize
            FROM lottery_draws
            WHERE status = 'completed'
            GROUP BY DATE_TRUNC('month', draw_date)
            ORDER BY month DESC
            LIMIT 12
        `);
        
        const biggestWin = await Lottery.query(`
            SELECT d.*, u.name as winner_name
            FROM lottery_draws d
            JOIN users u ON u.id = d.winner_id
            WHERE d.status = 'completed'
            ORDER BY d.winner_prize DESC
            LIMIT 1
        `);
        
        const response = {
            stats: {
                totalDraws: parseInt(totalStats.rows[0].total_draws || 0),
                totalPrizePool: parseInt(totalStats.rows[0].total_prize_pool || 0),
                totalWinnersPrize: parseInt(totalStats.rows[0].total_winners_prize || 0),
                uniqueWinners: parseInt(totalStats.rows[0].unique_winners || 0),
                totalTicketsSold: parseInt(totalStats.rows[0].total_tickets_sold || 0),
                biggestWin: biggestWin.rows[0] ? {
                    amount: biggestWin.rows[0].winner_prize,
                    amountFormatted: new Intl.NumberFormat('ru-RU').format(biggestWin.rows[0].winner_prize),
                    winnerName: biggestWin.rows[0].winner_name,
                    drawDate: biggestWin.rows[0].draw_date
                } : null
            },
            monthlyStats: monthlyStats.rows.map(stat => ({
                month: new Date(stat.month).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }),
                drawsCount: parseInt(stat.draws_count),
                prizePool: parseInt(stat.prize_pool),
                prizePoolFormatted: new Intl.NumberFormat('ru-RU').format(stat.prize_pool),
                winnerPrize: parseInt(stat.winner_prize)
            }))
        };
        
        await set(cacheKey, response, 3600);
        res.json({ success: true, ...response });
    } catch (error) {
        console.error('Ошибка получения статистики лотереи:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// GET /api/v1/lottery/check/:drawId
// Проверка участия в розыгрыше
// ============================================
router.get(
    '/check/:drawId',
    authenticate,
    [
        param('drawId').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { drawId } = req.params;

        try {
            const tickets = await Lottery.getUserTickets(req.user.id, drawId ? parseInt(drawId) : null);
            const hasParticipated = tickets.length > 0;
            
            let winInfo = null;
            if (hasParticipated) {
                const drawResult = await Lottery.query(
                    `SELECT winner_id, winner_prize FROM lottery_draws WHERE id = $1 AND status = 'completed'`,
                    [drawId]
                );
                if (drawResult.rows.length > 0 && drawResult.rows[0].winner_id === req.user.id) {
                    winInfo = {
                        isWinner: true,
                        prize: drawResult.rows[0].winner_prize,
                        prizeFormatted: new Intl.NumberFormat('ru-RU').format(drawResult.rows[0].winner_prize)
                    };
                }
            }
            
            res.json({
                success: true,
                hasParticipated,
                ticketsCount: tickets.length,
                winInfo
            });
        } catch (error) {
            console.error('Ошибка проверки участия:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

// ============================================
// POST /api/v1/lottery/draw/:drawId (только админ)
// Принудительное проведение розыгрыша
// ============================================
router.post(
    '/draw/:drawId',
    authenticate,
    isAdmin,
    [
        param('drawId').isInt()
    ],
    async (req, res) => {
        const error = validate(req, res);
        if (error) return error;

        const { drawId } = req.params;

        try {
            const result = await Lottery.performDraw(parseInt(drawId));
            
            if (!result.success) {
                return res.status(400).json({ error: result.message });
            }
            
            await del('lottery:current');
            await del('lottery:winners:*');
            await del('lottery:history:*');
            await del('lottery:stats');
            
            await addJob('notificationQueue', 'lotteryWinNotification', {
                userId: result.winner.user_id,
                prize: result.winnerPrize,
                drawId: parseInt(drawId),
                ticketNumber: result.winner.ticket_number
            });
            
            res.json({
                success: true,
                winner: {
                    userId: result.winner.user_id,
                    ticketNumber: result.winner.ticket_number,
                    prize: result.winnerPrize,
                    prizeFormatted: new Intl.NumberFormat('ru-RU').format(result.winnerPrize)
                },
                prizePool: result.prizePool,
                message: 'Розыгрыш проведён'
            });
        } catch (error) {
            console.error('Ошибка принудительного розыгрыша:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    }
);

module.exports = router;