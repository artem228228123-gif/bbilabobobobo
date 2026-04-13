/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/controllers/bonusController.js
 * Описание: Контроллер бонусной системы (ежедневный бонус, транзакции, лидерборд)
 */

const { User, Bonus, Listing } = require('../models');
const { get, set, del, incr, zincrby, zrevrange, zadd } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_TTL = {
    balance: 300,        // 5 минут
    history: 300,        // 5 минут
    streak: 3600,        // 1 час
    leaderboard: 3600    // 1 час
};

const BONUS_CONFIG = {
    dailyBase: 100,
    streakBonusPercent: 10,
    maxStreakBonus: 100,  // макс. бонус за streak (100%)
    maxStreakDays: 10     // макс. дней для расчёта streak
};

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

async function calculateStreakBonus(streak) {
    const bonusPercent = Math.min(streak * BONUS_CONFIG.streakBonusPercent, BONUS_CONFIG.maxStreakBonus);
    return Math.floor(BONUS_CONFIG.dailyBase * (1 + bonusPercent / 100));
}

async function updateLeaderboard() {
    const topUsers = await User.query(`
        SELECT id, name, avatar, bonus_balance
        FROM users
        WHERE status = 'active' AND bonus_balance > 0
        ORDER BY bonus_balance DESC
        LIMIT 100
    `);
    
    for (const user of topUsers.rows) {
        await zadd('leaderboard:bonus', user.bonus_balance, user.id);
    }
    
    await set('leaderboard:bonus:data', topUsers.rows, CACHE_TTL.leaderboard);
}

// ============================================
// ПОЛУЧЕНИЕ БАЛАНСА
// ============================================

async function getBalance(req, res) {
    try {
        const cacheKey = `bonus:balance:${req.user.id}`;
        const cached = await get(cacheKey);
        if (cached !== null) {
            return res.json({ success: true, balance: cached });
        }
        
        const balance = await Bonus.getBalance(req.user.id);
        await set(cacheKey, balance, CACHE_TTL.balance);
        
        res.json({ success: true, balance });
    } catch (error) {
        console.error('Ошибка получения баланса:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ ЕЖЕДНЕВНОГО БОНУСА
// ============================================

async function claimDailyBonus(req, res) {
    try {
        const result = await Bonus.claimDaily(req.user.id);
        
        if (!result.success) {
            return res.status(400).json({ error: result.message });
        }
        
        await del(`bonus:balance:${req.user.id}`);
        await del(`bonus:streak:${req.user.id}`);
        await updateLeaderboard();
        
        // Отправляем уведомление
        await addJob('notificationQueue', 'dailyBonusNotification', {
            userId: req.user.id,
            amount: result.amount,
            streak: result.streak
        });
        
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
}

// ============================================
// ПОЛУЧЕНИЕ ИСТОРИИ ТРАНЗАКЦИЙ
// ============================================

async function getTransactionHistory(req, res) {
    const { limit = 50, offset = 0, type } = req.query;
    
    try {
        const cacheKey = `bonus:history:${req.user.id}:${limit}:${offset}:${type}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }
        
        const history = await Bonus.getHistory(req.user.id, parseInt(limit), parseInt(offset), type);
        
        await set(cacheKey, history, CACHE_TTL.history);
        res.json({ success: true, ...history });
    } catch (error) {
        console.error('Ошибка получения истории транзакций:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПЕРЕВОД БОНУСОВ ДРУГОМУ ПОЛЬЗОВАТЕЛЮ
// ============================================

async function transferBonuses(req, res) {
    const { to_user_id, amount } = req.body;
    
    if (req.user.id === parseInt(to_user_id)) {
        return res.status(400).json({ error: 'Нельзя перевести бонусы самому себе' });
    }
    
    if (amount < 10) {
        return res.status(400).json({ error: 'Минимальная сумма перевода — 10 бонусов' });
    }
    
    if (amount > 10000) {
        return res.status(400).json({ error: 'Максимальная сумма перевода — 10 000 бонусов' });
    }
    
    try {
        const balance = await Bonus.getBalance(req.user.id);
        if (balance < amount) {
            return res.status(400).json({ error: 'Недостаточно бонусов' });
        }
        
        const toUser = await User.findById(parseInt(to_user_id));
        if (!toUser) {
            return res.status(404).json({ error: 'Получатель не найден' });
        }
        
        // Списание у отправителя
        await User.addBonus(req.user.id, -amount, 'transfer_out', to_user_id);
        
        // Начисление получателю
        await User.addBonus(parseInt(to_user_id), amount, 'transfer_in', req.user.id);
        
        // Очищаем кеш
        await del(`bonus:balance:${req.user.id}`);
        await del(`bonus:balance:${to_user_id}`);
        await updateLeaderboard();
        
        // Уведомляем получателя
        await addJob('notificationQueue', 'bonusTransferNotification', {
            userId: to_user_id,
            fromUserName: req.user.name,
            amount
        });
        
        res.json({
            success: true,
            message: `Переведено ${amount} бонусов пользователю ${toUser.name}`,
            newBalance: await Bonus.getBalance(req.user.id)
        });
    } catch (error) {
        console.error('Ошибка перевода бонусов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ПОЛУЧЕНИЕ ТЕКУЩЕЙ СЕРИИ (STREAK)
// ============================================

async function getStreak(req, res) {
    try {
        const cacheKey = `bonus:streak:${req.user.id}`;
        const cached = await get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...cached, fromCache: true });
        }
        
        const streak = await Bonus.getStreak(req.user.id);
        const nextBonus = await calculateStreakBonus(streak.streak + 1);
        
        const response = {
            streak: streak.streak,
            lastClaim: streak.lastClaim,
            nextBonus,
            maxStreakBonus: BONUS_CONFIG.maxStreakBonus
        };
        
        await set(cacheKey, response, CACHE_TTL.streak);
        res.json({ success: true, ...response });
    } catch (error) {
        console.error('Ошибка получения streak:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЛИДЕРБОРД (ТОП ПО БОНУСАМ)
// ============================================

async function getLeaderboard(req, res) {
    const { limit = 50 } = req.query;
    
    try {
        const cached = await get('leaderboard:bonus:data');
        if (cached) {
            const topUsers = cached.slice(0, parseInt(limit));
            
            // Находим место текущего пользователя
            let userRank = null;
            if (req.user) {
                const userBalance = await Bonus.getBalance(req.user.id);
                const rankResult = await User.query(`
                    SELECT COUNT(*) + 1 as rank
                    FROM users
                    WHERE bonus_balance > $1 AND status = 'active'
                `, [userBalance]);
                userRank = parseInt(rankResult.rows[0].rank);
            }
            
            return res.json({
                success: true,
                leaderboard: topUsers,
                userRank,
                fromCache: true
            });
        }
        
        await updateLeaderboard();
        
        const topUsers = await zrevrange('leaderboard:bonus', 0, parseInt(limit) - 1, true);
        const leaderboard = [];
        
        for (const user of topUsers) {
            const userData = await User.findById(parseInt(user.value));
            if (userData) {
                leaderboard.push({
                    id: userData.id,
                    name: userData.name,
                    avatar: userData.avatar,
                    bonus_balance: userData.bonus_balance,
                    score: parseInt(user.score)
                });
            }
        }
        
        let userRank = null;
        if (req.user) {
            const userBalance = await Bonus.getBalance(req.user.id);
            const rankResult = await User.query(`
                SELECT COUNT(*) + 1 as rank
                FROM users
                WHERE bonus_balance > $1 AND status = 'active'
            `, [userBalance]);
            userRank = parseInt(rankResult.rows[0].rank);
        }
        
        res.json({ success: true, leaderboard, userRank });
    } catch (error) {
        console.error('Ошибка получения лидерборда:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ОБМЕН БОНУСОВ НА УСЛУГИ
// ============================================

async function redeemBonus(req, res) {
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
                const listing = await Listing.findById(listing_id);
                if (!listing || listing.user_id !== req.user.id) {
                    return res.status(404).json({ error: 'Объявление не найдено' });
                }
                await Listing.update(listing_id, { bumped_at: new Date(), created_at: new Date() });
                result = { message: 'Объявление поднято в топ' };
                break;
                
            case 'vip':
                if (!listing_id) {
                    return res.status(400).json({ error: 'ID объявления обязателен' });
                }
                await Listing.update(listing_id, { 
                    is_vip: true, 
                    vip_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) 
                });
                result = { message: 'VIP-статус активирован на 30 дней' };
                break;
                
            case 'highlight':
                if (!listing_id) {
                    return res.status(400).json({ error: 'ID объявления обязателен' });
                }
                await Listing.update(listing_id, { 
                    is_highlighted: true, 
                    highlighted_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) 
                });
                result = { message: 'Выделение объявления активировано на 7 дней' };
                break;
                
            case 'lottery_ticket':
                const lotteryResult = await Bonus.query(`
                    INSERT INTO lottery_tickets (draw_id, user_id, ticket_number, price, created_at)
                    SELECT id, $1, LPAD(CAST(nextval('ticket_seq') AS TEXT), 8, '0'), $2, NOW()
                    FROM lottery_draws WHERE status = 'active' LIMIT 1
                    RETURNING *
                `, [req.user.id, price]);
                result = { message: 'Лотерейный билет куплен', ticket: lotteryResult.rows[0] };
                break;
        }
        
        await User.addBonus(req.user.id, -price, service, listing_id || null);
        await del(`bonus:balance:${req.user.id}`);
        await updateLeaderboard();
        
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

// ============================================
// СТАТИСТИКА БОНУСОВ ПОЛЬЗОВАТЕЛЯ
// ============================================

async function getBonusStats(req, res) {
    try {
        const balance = await Bonus.getBalance(req.user.id);
        const streak = await Bonus.getStreak(req.user.id);
        
        // Статистика по типам транзакций
        const stats = await Bonus.query(`
            SELECT 
                type,
                SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as earned,
                SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) as spent,
                COUNT(*) as count
            FROM bonus_transactions
            WHERE user_id = $1
            GROUP BY type
            ORDER BY earned DESC
        `, [req.user.id]);
        
        // Всего заработано и потрачено
        const totals = await Bonus.query(`
            SELECT 
                SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as total_earned,
                SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) as total_spent
            FROM bonus_transactions
            WHERE user_id = $1
        `, [req.user.id]);
        
        res.json({
            success: true,
            balance,
            streak: streak.streak,
            lastClaim: streak.lastClaim,
            totalEarned: parseInt(totals.rows[0].total_earned || 0),
            totalSpent: parseInt(totals.rows[0].total_spent || 0),
            byType: stats.rows
        });
    } catch (error) {
        console.error('Ошибка получения статистики бонусов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ДОСТУПНЫЕ УСЛУГИ ДЛЯ ОБМЕНА
// ============================================

async function getRedeemableServices(req, res) {
    const services = [
        { id: 'bump', name: 'Поднятие объявления', price: 500, description: 'Поднимите объявление в топ на 7 дней', icon: '⬆️' },
        { id: 'vip', name: 'VIP-объявление', price: 1000, description: 'Золотой значок и закрепление на 30 дней', icon: '👑' },
        { id: 'highlight', name: 'Выделение объявления', price: 300, description: 'Выделите объявление цветом на 7 дней', icon: '🎨' },
        { id: 'lottery_ticket', name: 'Лотерейный билет', price: 100, description: 'Участвуйте в розыгрыше призового фонда', icon: '🎰' }
    ];
    
    res.json({ success: true, services });
}

// ============================================
// АДМИН-ФУНКЦИИ
// ============================================

async function addBonusToUser(req, res) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }
    
    const { user_id, amount, reason } = req.body;
    
    if (!user_id || !amount) {
        return res.status(400).json({ error: 'ID пользователя и сумма обязательны' });
    }
    
    try {
        await User.addBonus(parseInt(user_id), parseInt(amount), 'admin_grant', null, reason);
        await del(`bonus:balance:${user_id}`);
        await updateLeaderboard();
        
        await addJob('notificationQueue', 'adminBonusNotification', {
            userId: user_id,
            amount: parseInt(amount),
            reason: reason || 'Поощрение от администрации'
        });
        
        res.json({ success: true, message: `Бонусы добавлены пользователю` });
    } catch (error) {
        console.error('Ошибка добавления бонусов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    getBalance,
    claimDailyBonus,
    getTransactionHistory,
    transferBonuses,
    getStreak,
    getLeaderboard,
    redeemBonus,
    getBonusStats,
    getRedeemableServices,
    addBonusToUser
};