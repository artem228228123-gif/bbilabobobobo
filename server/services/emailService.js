/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/emailService.js
 * Описание: Отправка электронных писем (регистрация, восстановление, уведомления, рассылки)
 */

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { config } = require('../../config/env');
const { addJob } = require('../../config/redis');

// ============================================
// НАСТРОЙКА ТРАНСПОРТА
// ============================================

let transporter = null;
let isConfigured = false;

// Создание транспорта для отправки писем
function createTransporter() {
    if (transporter) return transporter;
    
    if (!config.email.enabled) {
        console.warn('⚠️ Email отключён. Письма не будут отправляться.');
        isConfigured = false;
        return null;
    }
    
    try {
        transporter = nodemailer.createTransport({
            host: config.email.host,
            port: config.email.port,
            secure: config.email.port === 465, // true для 465, false для 587
            auth: {
                user: config.email.user,
                pass: config.email.pass,
            },
            tls: {
                rejectUnauthorized: false,
            },
            pool: true, // Используем пул соединений
            maxConnections: 5,
            rateDelta: 1000, // 1 секунда
            rateLimit: 10, // макс 10 писем в секунду
        });
        
        isConfigured = true;
        console.log('✅ Email сервис настроен');
        return transporter;
    } catch (error) {
        console.error('❌ Ошибка настройки email:', error.message);
        isConfigured = false;
        return null;
    }
}

// ============================================
// ШАБЛОНЫ ПИСЕМ
// ============================================

// Базовый HTML шаблон
function getBaseTemplate(content, title = 'АЙДА — Доска объявлений') {
    return `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #1a1a1a;
            background-color: #f5f5f7;
            margin: 0;
            padding: 0;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #ffffff;
            border-radius: 20px;
            margin-top: 20px;
            margin-bottom: 20px;
        }
        .header {
            text-align: center;
            padding: 20px 0;
            border-bottom: 2px solid #10b981;
        }
        .header h1 {
            color: #10b981;
            margin: 0;
            font-size: 28px;
        }
        .content {
            padding: 30px 20px;
        }
        .button {
            display: inline-block;
            background-color: #10b981;
            color: #ffffff !important;
            text-decoration: none;
            padding: 12px 32px;
            border-radius: 44px;
            font-weight: 600;
            margin: 20px 0;
            transition: all 0.35s ease;
        }
        .button:hover {
            background-color: #0e9f6e;
            transform: translateY(-2px);
        }
        .footer {
            text-align: center;
            padding: 20px;
            font-size: 12px;
            color: #8e8e93;
            border-top: 1px solid #e5e5ea;
        }
        .code {
            font-size: 32px;
            font-weight: bold;
            letter-spacing: 5px;
            text-align: center;
            padding: 20px;
            background-color: #f5f5f7;
            border-radius: 16px;
            font-family: monospace;
        }
        .warning {
            background-color: #fef2e8;
            border-left: 4px solid #f59e0b;
            padding: 12px 16px;
            margin: 20px 0;
            border-radius: 12px;
        }
        @media (max-width: 600px) {
            .container {
                margin: 10px;
                padding: 15px;
            }
            .button {
                display: block;
                text-align: center;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 АЙДА</h1>
            <p style="color: #8e8e93; margin-top: 5px;">Премиальная доска объявлений</p>
        </div>
        <div class="content">
            ${content}
        </div>
        <div class="footer">
            <p>© 2025 АЙДА. Все права защищены.</p>
            <p>Это письмо отправлено автоматически, пожалуйста, не отвечайте на него.</p>
            <p>
                <a href="${config.app.clientUrl}/terms" style="color: #8e8e93; text-decoration: none;">Пользовательское соглашение</a>
                &nbsp;|&nbsp;
                <a href="${config.app.clientUrl}/privacy" style="color: #8e8e93; text-decoration: none;">Политика конфиденциальности</a>
            </p>
        </div>
    </div>
</body>
</html>
    `;
}

// ============================================
// ОТПРАВКА ПИСЕМ
// ============================================

// Основная функция отправки
async function sendEmail(to, subject, html, text = null) {
    if (!isConfigured) {
        console.log(`📧 [MOCK] Письмо для ${to}: ${subject}`);
        console.log(`📧 [MOCK] Содержание: ${text || html.substring(0, 200)}...`);
        return { success: true, mock: true };
    }
    
    try {
        const transport = createTransporter();
        if (!transport) {
            throw new Error('Транспорт не настроен');
        }
        
        const info = await transport.sendMail({
            from: config.email.from,
            to,
            subject,
            html,
            text: text || html.replace(/<[^>]*>/g, ''),
        });
        
        console.log(`✅ Письмо отправлено: ${to} (${info.messageId})`);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error(`❌ Ошибка отправки письма ${to}:`, error.message);
        return { success: false, error: error.message };
    }
}

// ============================================
// ПИСЬМО ПОДТВЕРЖДЕНИЯ EMAIL
// ============================================
async function sendVerificationEmail(to, name, code) {
    const verifyUrl = `${config.app.clientUrl}/verify-email?code=${code}`;
    
    const content = `
        <h2>Здравствуйте, ${name}!</h2>
        <p>Спасибо за регистрацию на платформе <strong>АЙДА</strong>!</p>
        <p>Для завершения регистрации и получения доступа ко всем функциям, пожалуйста, подтвердите ваш email адрес.</p>
        <div style="text-align: center;">
            <a href="${verifyUrl}" class="button">Подтвердить email</a>
        </div>
        <p>Или скопируйте ссылку в браузер:</p>
        <p style="word-break: break-all; background-color: #f5f5f7; padding: 10px; border-radius: 8px; font-size: 12px;">${verifyUrl}</p>
        <div class="warning">
            <p>⚠️ Если вы не регистрировались на АЙДА, просто проигнорируйте это письмо.</p>
        </div>
        <p>После подтверждения вам станут доступны:</p>
        <ul>
            <li>📝 Размещение объявлений</li>
            <li>💬 Чаты с продавцами и покупателями</li>
            <li>❤️ Добавление в избранное</li>
            <li>🎁 Бонусная система и лотереи</li>
        </ul>
    `;
    
    return await sendEmail(to, 'Подтверждение регистрации на АЙДА', getBaseTemplate(content, 'Подтверждение email'));
}

// ============================================
// ПИСЬМО ВОССТАНОВЛЕНИЯ ПАРОЛЯ
// ============================================
async function sendResetPasswordEmail(to, name, code) {
    const resetUrl = `${config.app.clientUrl}/reset-password?code=${code}`;
    
    const content = `
        <h2>Здравствуйте, ${name}!</h2>
        <p>Мы получили запрос на сброс пароля для вашей учётной записи на <strong>АЙДА</strong>.</p>
        <p>Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо.</p>
        <div style="text-align: center;">
            <a href="${resetUrl}" class="button">Сбросить пароль</a>
        </div>
        <p>Или используйте этот код:</p>
        <div class="code">${code}</div>
        <div class="warning">
            <p>⚠️ Ссылка действительна в течение 1 часа.</p>
            <p>⚠️ Никогда не сообщайте этот код никому, даже сотрудникам АЙДА.</p>
        </div>
    `;
    
    return await sendEmail(to, 'Восстановление пароля на АЙДА', getBaseTemplate(content, 'Восстановление пароля'));
}

// ============================================
// ПИСЬМО О НОВОМ СООБЩЕНИИ В ЧАТЕ
// ============================================
async function sendNewMessageNotification(to, name, senderName, listingTitle, chatUrl) {
    const content = `
        <h2>Здравствуйте, ${name}!</h2>
        <p>У вас новое сообщение от <strong>${senderName}</strong> в чате по объявлению <strong>${listingTitle}</strong>.</p>
        <div style="text-align: center;">
            <a href="${chatUrl}" class="button">Перейти в чат</a>
        </div>
        <p>Не пропустите важные переговоры — ответьте как можно скорее!</p>
    `;
    
    return await sendEmail(to, `Новое сообщение от ${senderName} на АЙДА`, getBaseTemplate(content, 'Новое сообщение'));
}

// ============================================
// ПИСЬМО О ПРОДАЖЕ ТОВАРА
// ============================================
async function sendSoldNotification(to, name, listingTitle, buyerName, price) {
    const content = `
        <h2>Поздравляем, ${name}!</h2>
        <p>Ваше объявление <strong>${listingTitle}</strong> было отмечено как <strong>ПРОДАНО</strong>!</p>
        <p>Покупатель: <strong>${buyerName}</strong></p>
        <p>Цена: <strong>${price.toLocaleString()} ₽</strong></p>
        <div style="text-align: center;">
            <a href="${config.app.clientUrl}/profile/listings" class="button">Посмотреть мои объявления</a>
        </div>
        <p>Не забудьте оставить отзыв о покупателе — это поможет другим пользователям!</p>
    `;
    
    return await sendEmail(to, `Товар продан! ${listingTitle}`, getBaseTemplate(content, 'Товар продан'));
}

// ============================================
// ПИСЬМО О НОВОМ ОТЗЫВЕ
// ============================================
async function sendNewReviewNotification(to, name, reviewerName, rating, text, listingTitle) {
    const stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
    
    const content = `
        <h2>Здравствуйте, ${name}!</h2>
        <p>Пользователь <strong>${reviewerName}</strong> оставил отзыв о вас по объявлению <strong>${listingTitle}</strong>.</p>
        <div style="background-color: #f5f5f7; padding: 16px; border-radius: 16px; margin: 20px 0;">
            <p style="font-size: 20px; margin: 0;">${stars}</p>
            <p style="margin-top: 10px;">${text}</p>
        </div>
        <div style="text-align: center;">
            <a href="${config.app.clientUrl}/profile/reviews" class="button">Посмотреть все отзывы</a>
        </div>
    `;
    
    return await sendEmail(to, `Новый отзыв на АЙДА — ${stars}`, getBaseTemplate(content, 'Новый отзыв'));
}

// ============================================
// ПИСЬМО О ВЫИГРЫШЕ В ЛОТЕРЕЕ
// ============================================
async function sendLotteryWinNotification(to, name, prize, drawDate) {
    const content = `
        <h2>🎉 ПОЗДРАВЛЯЕМ, ${name}! 🎉</h2>
        <p>Вы выиграли в лотерее АЙДА!</p>
        <div style="text-align: center; font-size: 48px; font-weight: bold; color: #10b981; margin: 20px 0;">
            ${prize.toLocaleString()} бонусов
        </div>
        <p>Розыгрыш состоялся ${new Date(drawDate).toLocaleDateString()}.</p>
        <p>Бонусы уже зачислены на ваш счёт. Вы можете потратить их на:</p>
        <ul>
            <li>🎰 Участие в следующих розыгрышах</li>
            <li>⬆️ Поднятие объявлений в топ</li>
            <li>🎨 VIP-оформление объявлений</li>
        </ul>
        <div style="text-align: center;">
            <a href="${config.app.clientUrl}/bonus" class="button">Использовать бонусы</a>
        </div>
    `;
    
    return await sendEmail(to, 'Вы выиграли в лотерее АЙДА!', getBaseTemplate(content, 'Победа в лотерее'));
}

// ============================================
// ПИСЬМО ОБ ОДОБРЕНИИ ОБЪЯВЛЕНИЯ
// ============================================
async function sendListingApprovedNotification(to, name, listingTitle, listingUrl) {
    const content = `
        <h2>Здравствуйте, ${name}!</h2>
        <p>Ваше объявление <strong>${listingTitle}</strong> прошло модерацию и опубликовано!</p>
        <p>Теперь его видят все пользователи АЙДА.</p>
        <div style="text-align: center;">
            <a href="${listingUrl}" class="button">Посмотреть объявление</a>
        </div>
        <p>Чтобы привлечь больше просмотров, вы можете:</p>
        <ul>
            <li>⬆️ Поднять объявление в топ</li>
            <li>🎨 Добавить больше качественных фото</li>
            <li>📱 Поделиться в соцсетях</li>
        </ul>
    `;
    
    return await sendEmail(to, `Объявление "${listingTitle}" опубликовано!`, getBaseTemplate(content, 'Объявление опубликовано'));
}

// ============================================
// ПИСЬМО ОБ ОТКЛОНЕНИИ ОБЪЯВЛЕНИЯ
// ============================================
async function sendListingRejectedNotification(to, name, listingTitle, reason) {
    const content = `
        <h2>Здравствуйте, ${name}!</h2>
        <p>К сожалению, ваше объявление <strong>${listingTitle}</strong> не прошло модерацию.</p>
        <div class="warning">
            <p><strong>Причина отклонения:</strong></p>
            <p>${reason}</p>
        </div>
        <p>Пожалуйста, исправьте замечания и опубликуйте объявление заново.</p>
        <div style="text-align: center;">
            <a href="${config.app.clientUrl}/add-listing" class="button">Создать объявление</a>
        </div>
    `;
    
    return await sendEmail(to, `Объявление "${listingTitle}" отклонено`, getBaseTemplate(content, 'Объявление отклонено'));
}

// ============================================
// ПИСЬМО О БЛОКИРОВКЕ АККАУНТА
// ============================================
async function sendAccountBlockedNotification(to, name, reason, duration) {
    let durationText = '';
    if (duration === 'permanent') {
        durationText = 'навсегда';
    } else if (duration === '24h') {
        durationText = 'на 24 часа';
    } else if (duration === '7d') {
        durationText = 'на 7 дней';
    } else {
        durationText = duration;
    }
    
    const content = `
        <h2>Здравствуйте, ${name}!</h2>
        <p>Ваш аккаунт на АЙДА был <strong>заблокирован ${durationText}</strong>.</p>
        <div class="warning">
            <p><strong>Причина блокировки:</strong></p>
            <p>${reason}</p>
        </div>
        <p>Если вы считаете, что это ошибка, пожалуйста, свяжитесь со службой поддержки.</p>
        <div style="text-align: center;">
            <a href="${config.app.clientUrl}/support" class="button">Связаться с поддержкой</a>
        </div>
    `;
    
    return await sendEmail(to, 'Ваш аккаунт на АЙДА заблокирован', getBaseTemplate(content, 'Блокировка аккаунта'));
}

// ============================================
// МАССОВАЯ РАССЫЛКА (только для администратора)
// ============================================
async function sendMassEmail(recipients, subject, content) {
    const results = [];
    
    for (const recipient of recipients) {
        const result = await sendEmail(recipient.email, subject, getBaseTemplate(content, subject));
        results.push({ email: recipient.email, success: result.success });
        
        // Задержка между письмами
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return results;
}

// ============================================
// ТЕСТОВОЕ ПИСЬМО
// ============================================
async function sendTestEmail(to) {
    const content = `
        <h2>Тестовое письмо</h2>
        <p>Если вы видите это письмо, значит email сервис работает корректно!</p>
        <p>Время отправки: ${new Date().toLocaleString()}</p>
        <div class="warning">
            <p>✅ Настройки SMTP верны</p>
            <p>✅ Шаблоны писем загружаются</p>
        </div>
    `;
    
    return await sendEmail(to, 'Тестовое письмо от АЙДА', getBaseTemplate(content, 'Тестовое письмо'));
}

// ============================================
// ЭКСПОРТ
// ============================================
module.exports = {
    // Основная
    sendEmail,
    
    // Транзакционные письма
    sendVerificationEmail,
    sendResetPasswordEmail,
    sendNewMessageNotification,
    sendSoldNotification,
    sendNewReviewNotification,
    sendLotteryWinNotification,
    sendListingApprovedNotification,
    sendListingRejectedNotification,
    sendAccountBlockedNotification,
    
    // Массовые
    sendMassEmail,
    
    // Тест
    sendTestEmail,
    
    // Статус
    isEnabled: () => isConfigured,
};