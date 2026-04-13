/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/paymentService.js
 * Описание: Сервис платежей (ЮKassa, обработка платежей, подписки, вывод средств)
 */

const crypto = require('crypto');
const axios = require('axios');
const { get, set, del } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { config } = require('../../config/env');
const { User, Listing, Payment } = require('../models');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_TTL = {
    payment: 3600,       // 1 час
    balance: 300,        // 5 минут
    withdrawal: 3600     // 1 час
};

const PAYMENT_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    REFUNDED: 'refunded',
    CANCELLED: 'cancelled'
};

const WITHDRAWAL_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
};

// ЮKassa конфигурация
const YOOKASSA_API_URL = 'https://api.yookassa.ru/v3';
const YOOKASSA_IDEMPOTENCY_KEY_HEADER = 'Idempotence-Key';

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function generateIdempotencyKey() {
    return crypto.randomBytes(32).toString('hex');
}

function getYookassaHeaders() {
    const auth = Buffer.from(`${config.payments.shopId}:${config.payments.secretKey}`).toString('base64');
    return {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        'Idempotence-Key': generateIdempotencyKey()
    };
}

async function updateUserBalance(userId, amount, type, referenceId) {
    const balance = await get(`user:balance:${userId}`) || 0;
    const newBalance = parseInt(balance) + amount;
    await set(`user:balance:${userId}`, newBalance, CACHE_TTL.balance);
    
    await Payment.query(
        `INSERT INTO balance_transactions (user_id, amount, type, reference_id, balance_before, balance_after, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [userId, amount, type, referenceId, balance, newBalance]
    );
    
    return newBalance;
}

// ============================================
// СОЗДАНИЕ ПЛАТЕЖА (ЮKassa)
// ============================================

async function createPayment(amount, description, userId, metadata = {}) {
    if (!config.payments.enabled) {
        return {
            success: false,
            error: 'Платежи временно недоступны',
            mock: true,
            paymentUrl: '#',
            paymentId: `mock_${Date.now()}`
        };
    }
    
    try {
        const paymentData = {
            amount: {
                value: amount.toFixed(2),
                currency: 'RUB'
            },
            payment_method_data: {
                type: 'bank_card'
            },
            confirmation: {
                type: 'redirect',
                return_url: `${config.payments.returnUrl}?order_id=${metadata.orderId || ''}`
            },
            description: description,
            metadata: {
                user_id: userId.toString(),
                ...metadata
            },
            capture: true
        };
        
        const response = await axios.post(`${YOOKASSA_API_URL}/payments`, paymentData, {
            headers: getYookassaHeaders()
        });
        
        // Сохраняем информацию о платеже
        const payment = await Payment.query(
            `INSERT INTO payments (user_id, amount, currency, type, status, payment_id, order_id, description, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
             RETURNING *`,
            [userId, amount, 'RUB', 'payment', PAYMENT_STATUS.PENDING, response.data.id, response.data.id, description, JSON.stringify(metadata)]
        );
        
        return {
            success: true,
            paymentId: response.data.id,
            paymentUrl: response.data.confirmation.confirmation_url,
            payment: payment.rows[0]
        };
    } catch (error) {
        console.error('Ошибка создания платежа:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.description || 'Ошибка создания платежа'
        };
    }
}

// ============================================
= ОБРАБОТКА ВЕБХУКА ОТ ЮKassa
// ============================================

async function handlePaymentWebhook(event, data) {
    const { object } = data;
    const paymentId = object.id;
    const status = object.status;
    
    try {
        const payment = await Payment.query(
            `SELECT * FROM payments WHERE payment_id = $1`,
            [paymentId]
        );
        
        if (payment.rows.length === 0) {
            console.error(`Платёж не найден: ${paymentId}`);
            return { success: false, error: 'Payment not found' };
        }
        
        const paymentRecord = payment.rows[0];
        
        if (status === 'succeeded') {
            // Обновляем статус платежа
            await Payment.query(
                `UPDATE payments SET status = $1, completed_at = NOW() WHERE id = $2`,
                [PAYMENT_STATUS.COMPLETED, paymentRecord.id]
            );
            
            // Начисляем средства на баланс пользователя
            await updateUserBalance(
                paymentRecord.user_id,
                paymentRecord.amount,
                'payment',
                paymentRecord.id
            );
            
            // Отправляем уведомление пользователю
            await addJob('notificationQueue', 'paymentSuccessNotification', {
                userId: paymentRecord.user_id,
                amount: paymentRecord.amount,
                paymentId: paymentRecord.id
            });
            
            // Если это оплата услуги (поднятие, VIP и т.д.)
            const metadata = JSON.parse(paymentRecord.metadata || '{}');
            if (metadata.service && metadata.listing_id) {
                await activateService(metadata.service, metadata.listing_id, paymentRecord.user_id);
            }
        } else if (status === 'canceled') {
            await Payment.query(
                `UPDATE payments SET status = $1 WHERE id = $2`,
                [PAYMENT_STATUS.CANCELLED, paymentRecord.id]
            );
        }
        
        return { success: true };
    } catch (error) {
        console.error('Ошибка обработки вебхука:', error);
        return { success: false, error: error.message };
    }
}

// ============================================
= АКТИВАЦИЯ ПЛАТНЫХ УСЛУГ
// ============================================

async function activateService(service, listingId, userId) {
    try {
        const listing = await Listing.findById(listingId);
        if (!listing || listing.user_id !== userId) {
            return { success: false, error: 'Listing not found' };
        }
        
        switch (service) {
            case 'bump':
                await Listing.update(listingId, {
                    bumped_at: new Date(),
                    created_at: new Date()
                });
                break;
                
            case 'vip':
                await Listing.update(listingId, {
                    is_vip: true,
                    vip_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
                });
                break;
                
            case 'highlight':
                await Listing.update(listingId, {
                    is_highlighted: true,
                    highlighted_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
                });
                break;
                
            case 'subscription':
                await activateSubscription(userId, metadata.plan);
                break;
        }
        
        return { success: true };
    } catch (error) {
        console.error('Ошибка активации услуги:', error);
        return { success: false, error: error.message };
    }
}

// ============================================
= ПОДПИСКИ
// ============================================

async function createSubscription(userId, plan, amount, description) {
    const result = await createPayment(amount, description, userId, {
        type: 'subscription',
        plan: plan
    });
    
    if (result.success) {
        await Payment.query(
            `INSERT INTO subscriptions (user_id, plan, price, status, start_date, end_date, payment_id, created_at)
             VALUES ($1, $2, $3, 'pending', NOW(), NOW() + INTERVAL '30 days', $4, NOW())`,
            [userId, plan, amount, result.paymentId]
        );
    }
    
    return result;
}

async function activateSubscription(userId, plan) {
    const endDate = plan === 'premium_year' 
        ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    
    await Payment.query(
        `UPDATE subscriptions SET status = 'active', start_date = NOW(), end_date = $1
         WHERE user_id = $2 AND plan = $3 AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
        [endDate, userId, plan]
    );
    
    // Обновляем роль пользователя (если нужно)
    await User.update(userId, { role: 'premium' });
    
    return { success: true };
}

async function checkExpiredSubscriptions() {
    const result = await Payment.query(
        `UPDATE subscriptions SET status = 'expired'
         WHERE status = 'active' AND end_date < NOW()
         RETURNING user_id`
    );
    
    for (const sub of result.rows) {
        // Проверяем, есть ли другие активные подписки
        const activeSubs = await Payment.query(
            `SELECT id FROM subscriptions WHERE user_id = $1 AND status = 'active' AND end_date > NOW()`,
            [sub.user_id]
        );
        
        if (activeSubs.rows.length === 0) {
            await User.update(sub.user_id, { role: 'user' });
        }
    }
    
    return result.rows.length;
}

// ============================================
= ВЫВОД СРЕДСТВ
// ============================================

async function createWithdrawal(userId, amount, method, details) {
    const balance = await get(`user:balance:${userId}`) || 0;
    
    if (balance < amount) {
        return { success: false, error: 'Недостаточно средств на балансе' };
    }
    
    if (amount < 500) {
        return { success: false, error: 'Минимальная сумма вывода — 500 ₽' };
    }
    
    if (amount > 100000) {
        return { success: false, error: 'Максимальная сумма вывода за раз — 100 000 ₽' };
    }
    
    try {
        // Замораживаем средства
        await updateUserBalance(userId, -amount, 'withdrawal_hold', null);
        
        // Создаём запрос на вывод
        const withdrawal = await Payment.query(
            `INSERT INTO withdrawals (user_id, amount, method, details, status, created_at)
             VALUES ($1, $2, $3, $4, 'pending', NOW())
             RETURNING *`,
            [userId, amount, method, JSON.stringify(details)]
        );
        
        // Отправляем уведомление администраторам
        await addJob('notificationQueue', 'newWithdrawalRequest', {
            userId,
            amount,
            withdrawalId: withdrawal.rows[0].id
        });
        
        return {
            success: true,
            withdrawal: withdrawal.rows[0],
            message: 'Запрос на вывод создан. Ожидайте обработки.'
        };
    } catch (error) {
        console.error('Ошибка создания вывода:', error);
        return { success: false, error: 'Ошибка создания запроса' };
    }
}

async function processWithdrawal(withdrawalId, adminId, action, comment) {
    const withdrawal = await Payment.query(
        `SELECT * FROM withdrawals WHERE id = $1 AND status = 'pending'`,
        [withdrawalId]
    );
    
    if (withdrawal.rows.length === 0) {
        return { success: false, error: 'Запрос не найден' };
    }
    
    const withdrawalRecord = withdrawal.rows[0];
    
    if (action === 'approve') {
        // Обновляем статус
        await Payment.query(
            `UPDATE withdrawals SET status = 'completed', processed_at = NOW(), processed_by = $1
             WHERE id = $2`,
            [adminId, withdrawalId]
        );
        
        // Здесь должен быть реальный перевод денег
        // В демо-режиме просто списываем с баланса
        
        await updateUserBalance(
            withdrawalRecord.user_id,
            -withdrawalRecord.amount,
            'withdrawal',
            withdrawalId
        );
        
        // Отправляем уведомление пользователю
        await addJob('notificationQueue', 'withdrawalCompletedNotification', {
            userId: withdrawalRecord.user_id,
            amount: withdrawalRecord.amount,
            withdrawalId
        });
        
        return { success: true, message: 'Вывод одобрен' };
    } else {
        // Отклоняем и возвращаем средства
        await Payment.query(
            `UPDATE withdrawals SET status = 'failed', processed_at = NOW(), processed_by = $1, failure_reason = $2
             WHERE id = $3`,
            [adminId, comment || 'Отклонено администратором', withdrawalId]
        );
        
        // Возвращаем средства на баланс
        await updateUserBalance(
            withdrawalRecord.user_id,
            withdrawalRecord.amount,
            'withdrawal_refund',
            withdrawalId
        );
        
        return { success: true, message: 'Вывод отклонён' };
    }
}

// ============================================
= БАЛАНС ПОЛЬЗОВАТЕЛЯ
// ============================================

async function getUserBalance(userId) {
    const cached = await get(`user:balance:${userId}`);
    if (cached !== null) {
        return parseInt(cached);
    }
    
    const result = await Payment.query(
        `SELECT SUM(amount) as balance FROM balance_transactions WHERE user_id = $1`,
        [userId]
    );
    
    const balance = parseInt(result.rows[0].balance || 0);
    await set(`user:balance:${userId}`, balance, CACHE_TTL.balance);
    
    return balance;
}

async function getUserBalanceHistory(userId, limit = 50, offset = 0) {
    const result = await Payment.query(
        `SELECT * FROM balance_transactions 
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
    );
    
    const countResult = await Payment.query(
        `SELECT COUNT(*) FROM balance_transactions WHERE user_id = $1`,
        [userId]
    );
    
    return {
        transactions: result.rows,
        total: parseInt(countResult.rows[0].count)
    };
}

// ============================================
= СТАТИСТИКА ПЛАТЕЖЕЙ (АДМИН)
// ============================================

async function getPaymentStats(dateFrom, dateTo) {
    const result = await Payment.query(`
        SELECT 
            COUNT(*) as total_payments,
            SUM(amount) as total_amount,
            AVG(amount) as avg_amount,
            COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_payments,
            COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_payments,
            DATE(created_at) as date
        FROM payments
        WHERE created_at BETWEEN $1 AND $2
        GROUP BY DATE(created_at)
        ORDER BY date DESC
    `, [dateFrom, dateTo]);
    
    return result.rows;
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    createPayment,
    handlePaymentWebhook,
    activateService,
    createSubscription,
    activateSubscription,
    checkExpiredSubscriptions,
    createWithdrawal,
    processWithdrawal,
    getUserBalance,
    getUserBalanceHistory,
    getPaymentStats,
    PAYMENT_STATUS,
    WITHDRAWAL_STATUS
};