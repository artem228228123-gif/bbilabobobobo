/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/jobs/lotteryJob.js
 * Описание: Фоновые задачи для лотереи (розыгрыши, обновление призового фонда)
 */

const cron = require('node-cron');
const { get, set, del, incr } = require('../../config/redis');
const { query } = require('../../config/database');
const { addJob } = require('../../config/redis');
const { sendNotification } = require('../services/notificationService');
const { config } = require('../../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_TTL = {
    currentDraw: 60,        // 1 минута
    winners: 3600,          // 1 час
    stats: 3600             // 1 час
};

const LOTTERY_CONFIG = {
    ticketPrice: 100,
    prizePoolPercent: 70,
    drawDay: 0,             // 0 = воскресенье
    drawHour: 20,           // 20:00
    minTicketsForDraw: 1    // минимальное количество билетов для розыгрыша
};

// ============================================
= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

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
    nextSunday.setHours(LOTTERY_CONFIG.drawHour, 0, 0, 0);
    return nextSunday;
}

function generateTicketNumber() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// ============================================
= СОЗДАНИЕ РОЗЫГРЫША
// ============================================

/**
 * Создание следующего розыгрыша
 */
async function createNextDraw() {
    console.log('🎰 [LotteryJob] Создание следующего розыгрыша...');
    
    try {
        const weekNumber = getWeekNumber(new Date());
        const year = new Date().getFullYear();
        const drawDate = getNextDrawDate();
        
        // Проверяем, существует ли уже розыгрыш на эту неделю
        const existing = await query(
            `SELECT id FROM lottery_draws WHERE week_number = $1 AND year = $2`,
            [weekNumber, year]
        );
        
        if (existing.rows.length === 0) {
            await query(
                `INSERT INTO lottery_draws (week_number, year, draw_date, status, prize_pool)
                 VALUES ($1, $2, $3, 'active', 0)`,
                [weekNumber, year, drawDate]
            );
            console.log(`✅ [LotteryJob] Создан розыгрыш на ${drawDate.toISOString()}`);
        } else {
            console.log(`ℹ️ [LotteryJob] Розыгрыш на неделю ${weekNumber} уже существует`);
        }
    } catch (error) {
        console.error('❌ [LotteryJob] Ошибка создания розыгрыша:', error);
    }
}

// ============================================
= ПРОВЕДЕНИЕ РОЗЫГРЫША
// ============================================

/**
 * Проведение розыгрыша
 * @param {number} drawId - ID розыгрыша
 */
async function performDraw(drawId) {
    console.log(`🎰 [LotteryJob] Проведение розыгрыша #${drawId}...`);
    
    try {
        // Получаем информацию о розыгрыше
        const drawResult = await query(
            `SELECT * FROM lottery_draws WHERE id = $1 AND status = 'active'`,
            [drawId]
        );
        
        if (drawResult.rows.length === 0) {
            console.log(`ℹ️ [LotteryJob] Розыгрыш #${drawId} не найден или уже завершён`);
            return null;
        }
        
        const draw = drawResult.rows[0];
        
        // Проверяем, что наступило время розыгрыша
        if (new Date(draw.draw_date) > new Date()) {
            console.log(`ℹ️ [LotteryJob] Время розыгрыша #${drawId} ещё не наступило`);
            return null;
        }
        
        // Получаем все билеты
        const ticketsResult = await query(
            `SELECT id, user_id, ticket_number FROM lottery_tickets WHERE draw_id = $1`,
            [drawId]
        );
        
        if (ticketsResult.rows.length < LOTTERY_CONFIG.minTicketsForDraw) {
            console.log(`ℹ️ [LotteryJob] Недостаточно билетов для розыгрыша #${drawId}`);
            
            // Возвращаем бонусы покупателям
            for (const ticket of ticketsResult.rows) {
                await query(
                    `UPDATE users SET bonus_balance = bonus_balance + $1 WHERE id = $2`,
                    [LOTTERY_CONFIG.ticketPrice, ticket.user_id]
                );
                
                await query(
                    `INSERT INTO bonus_transactions (user_id, amount, type, reference_id, description)
                     VALUES ($1, $2, 'lottery_refund', $3, 'Возврат бонусов за лотерейный билет')`,
                    [ticket.user_id, LOTTERY_CONFIG.ticketPrice, drawId]
                );
            }
            
            // Закрываем розыгрыш
            await query(
                `UPDATE lottery_draws SET status = 'cancelled', completed_at = NOW() WHERE id = $1`,
                [drawId]
            );
            
            return null;
        }
        
        // Выбираем победителя
        const randomIndex = Math.floor(Math.random() * ticketsResult.rows.length);
        const winner = ticketsResult.rows[randomIndex];
        const prizeAmount = Math.floor(draw.prize_pool * LOTTERY_CONFIG.prizePoolPercent / 100);
        
        // Обновляем розыгрыш
        await query(
            `UPDATE lottery_draws 
             SET status = 'completed', 
                 winner_id = $1, 
                 winner_prize = $2, 
                 winner_ticket_number = $3,
                 completed_at = NOW()
             WHERE id = $4`,
            [winner.user_id, prizeAmount, winner.ticket_number, drawId]
        );
        
        // Начисляем приз победителю
        await query(
            `UPDATE users SET bonus_balance = bonus_balance + $1 WHERE id = $2`,
            [prizeAmount, winner.user_id]
        );
        
        // Записываем транзакцию
        await query(
            `INSERT INTO bonus_transactions (user_id, amount, type, reference_id, description)
             VALUES ($1, $2, 'lottery_win', $3, 'Выигрыш в лотерее')`,
            [winner.user_id, prizeAmount, drawId]
        );
        
        // Обновляем статусы билетов
        await query(
            `UPDATE lottery_tickets SET status = 'expired' WHERE draw_id = $1`,
            [drawId]
        );
        await query(
            `UPDATE lottery_tickets SET status = 'winning' WHERE id = $1`,
            [winner.id]
        );
        
        // Отправляем уведомление победителю
        const winnerUser = await query(`SELECT name, email FROM users WHERE id = $1`, [winner.user_id]);
        
        if (winnerUser.rows[0]) {
            await sendNotification(winner.user_id, 'lottery', {
                title: '🎉 Вы выиграли в лотерее!',
                message: `Поздравляем! Вы выиграли ${prizeAmount.toLocaleString()} бонусов в лотерее!`,
                prize: prizeAmount,
                drawId,
                ticketNumber: winner.ticket_number
            });
        }
        
        // Уведомляем всех участников
        for (const ticket of ticketsResult.rows) {
            if (ticket.user_id !== winner.user_id) {
                await sendNotification(ticket.user_id, 'lottery', {
                    title: 'Лотерея завершена',
                    message: `Лотерея завершена. Победитель получил ${prizeAmount.toLocaleString()} бонусов. Спасибо за участие!`,
                    drawId
                });
            }
        }
        
        console.log(`✅ [LotteryJob] Розыгрыш #${drawId} завершён. Победитель: ${winner.user_id}, приз: ${prizeAmount}`);
        
        // Создаём следующий розыгрыш
        await createNextDraw();
        
        return {
            drawId,
            winnerId: winner.user_id,
            prizeAmount,
            ticketNumber: winner.ticket_number,
            totalTickets: ticketsResult.rows.length,
            prizePool: draw.prize_pool
        };
    } catch (error) {
        console.error(`❌ [LotteryJob] Ошибка проведения розыгрыша #${drawId}:`, error);
        return null;
    }
}

/**
 * Проверка и проведение просроченных розыгрышей
 */
async function checkAndPerformExpiredDraws() {
    console.log('🎰 [LotteryJob] Проверка просроченных розыгрышей...');
    
    try {
        const expiredDraws = await query(
            `SELECT id FROM lottery_draws 
             WHERE status = 'active' AND draw_date <= NOW()`
        );
        
        for (const draw of expiredDraws.rows) {
            await performDraw(draw.id);
        }
        
        console.log(`✅ [LotteryJob] Проверено ${expiredDraws.rows.length} розыгрышей`);
    } catch (error) {
        console.error('❌ [LotteryJob] Ошибка проверки розыгрышей:', error);
    }
}

// ============================================
= ОБНОВЛЕНИЕ ПРИЗОВОГО ФОНДА
// ============================================

/**
 * Обновление призового фонда для активного розыгрыша
 */
async function updatePrizePool() {
    console.log('🎰 [LotteryJob] Обновление призового фонда...');
    
    try {
        const activeDraw = await query(
            `SELECT id FROM lottery_draws WHERE status = 'active' ORDER BY draw_date ASC LIMIT 1`
        );
        
        if (activeDraw.rows.length === 0) {
            console.log('ℹ️ [LotteryJob] Нет активных розыгрышей');
            return;
        }
        
        const drawId = activeDraw.rows[0].id;
        
        // Подсчитываем общую сумму билетов
        const ticketsSum = await query(
            `SELECT COALESCE(SUM(price), 0) as total FROM lottery_tickets WHERE draw_id = $1`,
            [drawId]
        );
        
        await query(
            `UPDATE lottery_draws SET prize_pool = $1 WHERE id = $2`,
            [ticketsSum.rows[0].total, drawId]
        );
        
        console.log(`✅ [LotteryJob] Призовой фонд обновлён: ${ticketsSum.rows[0].total} бонусов`);
    } catch (error) {
        console.error('❌ [LotteryJob] Ошибка обновления призового фонда:', error);
    }
}

// ============================================
= СТАТИСТИКА ЛОТЕРЕИ
// ============================================

/**
 * Обновление глобальной статистики лотереи
 */
async function updateLotteryStats() {
    console.log('📊 [LotteryJob] Обновление статистики лотереи...');
    
    try {
        // Общая статистика
        const stats = await query(`
            SELECT 
                COUNT(*) as total_draws,
                COALESCE(SUM(prize_pool), 0) as total_prize_pool,
                COALESCE(SUM(winner_prize), 0) as total_winners_prize,
                COUNT(DISTINCT winner_id) as unique_winners
            FROM lottery_draws
            WHERE status = 'completed'
        `);
        
        // Количество проданных билетов
        const ticketsSold = await query(`
            SELECT COUNT(*) as total FROM lottery_tickets
        `);
        
        await set('lottery:stats', {
            totalDraws: parseInt(stats.rows[0].total_draws || 0),
            totalPrizePool: parseInt(stats.rows[0].total_prize_pool || 0),
            totalWinnersPrize: parseInt(stats.rows[0].total_winners_prize || 0),
            uniqueWinners: parseInt(stats.rows[0].unique_winners || 0),
            totalTicketsSold: parseInt(ticketsSold.rows[0].total || 0)
        }, CACHE_TTL.stats);
        
        console.log(`✅ [LotteryJob] Статистика лотереи обновлена`);
    } catch (error) {
        console.error('❌ [LotteryJob] Ошибка обновления статистики:', error);
    }
}

// ============================================
= АРХИВАЦИЯ СТАРЫХ РОЗЫГРЫШЕЙ
// ============================================

/**
 * Архивация старых розыгрышей
 */
async function archiveOldDraws() {
    console.log('📦 [LotteryJob] Архивация старых розыгрышей...');
    
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    
    try {
        // Получаем старые завершённые розыгрыши
        const oldDraws = await query(
            `SELECT id FROM lottery_draws 
             WHERE status = 'completed' AND completed_at < $1`,
            [threeMonthsAgo]
        );
        
        for (const draw of oldDraws.rows) {
            // Перемещаем билеты в архивную таблицу
            await query(
                `INSERT INTO lottery_tickets_archive 
                 SELECT *, NOW() as archived_at FROM lottery_tickets WHERE draw_id = $1`,
                [draw.id]
            );
            
            // Удаляем из основной таблицы
            await query(`DELETE FROM lottery_tickets WHERE draw_id = $1`, [draw.id]);
        }
        
        console.log(`✅ [LotteryJob] Архивировано ${oldDraws.rows.length} розыгрышей`);
    } catch (error) {
        console.error('❌ [LotteryJob] Ошибка архивации:', error);
    }
}

// ============================================
= ЗАПУСК ВСЕХ ЗАДАЧ
// ============================================

/**
 * Запуск всех лотерейных задач по расписанию
 */
function startLotteryJobs() {
    console.log('⏰ [LotteryJob] Запуск планировщика лотереи...');
    
    // Создание следующего розыгрыша каждый понедельник в 00:00
    cron.schedule('0 0 * * 1', async () => {
        await createNextDraw();
    });
    
    // Проверка просроченных розыгрышей каждый час
    cron.schedule('0 * * * *', async () => {
        await checkAndPerformExpiredDraws();
    });
    
    // Обновление призового фонда каждые 10 минут
    cron.schedule('*/10 * * * *', async () => {
        await updatePrizePool();
    });
    
    // Обновление статистики каждый час
    cron.schedule('0 * * * *', async () => {
        await updateLotteryStats();
    });
    
    // Архивация старых розыгрышей каждую неделю в воскресенье в 3:00
    cron.schedule('0 3 * * 0', async () => {
        await archiveOldDraws();
    });
    
    console.log('✅ [LotteryJob] Все задачи лотереи запущены');
}

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    startLotteryJobs,
    createNextDraw,
    performDraw,
    checkAndPerformExpiredDraws,
    updatePrizePool,
    updateLotteryStats,
    archiveOldDraws,
    LOTTERY_CONFIG,
    getWeekNumber,
    getNextDrawDate,
    generateTicketNumber
};