/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/queue.js
 * Описание: Очереди задач (Bull) для фоновой обработки (email, уведомления, обработка изображений)
 */

const Queue = require('bull');
const { redis } = require('../config/redis');
const { config } = require('../config/env');
const { addJob } = require('../config/redis');

// ============================================
// КОНФИГУРАЦИЯ
// ============================================

const QUEUE_CONFIG = {
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT, 10) || 6379,
        password: process.env.REDIS_PASSWORD,
        db: 1
    },
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 5000
        },
        removeOnComplete: 100,
        removeOnFail: 1000,
        timeout: 30000
    },
    limiter: {
        max: 100,
        duration: 1000
    }
};

// ============================================
= ИНИЦИАЛИЗАЦИЯ ОЧЕРЕДЕЙ
// ============================================

// Очередь для email
const emailQueue = new Queue('email', QUEUE_CONFIG);

// Очередь для уведомлений
const notificationQueue = new Queue('notification', QUEUE_CONFIG);

// Очередь для обработки изображений
const imageQueue = new Queue('image-processing', {
    ...QUEUE_CONFIG,
    limiter: { max: 10, duration: 1000 } // 10 изображений в секунду
});

// Очередь для обработки видео
const videoQueue = new Queue('video-processing', {
    ...QUEUE_CONFIG,
    limiter: { max: 5, duration: 1000 } // 5 видео в секунду
});

// Очередь для аналитики
const analyticsQueue = new Queue('analytics', {
    ...QUEUE_CONFIG,
    defaultJobOptions: {
        ...QUEUE_CONFIG.defaultJobOptions,
        removeOnComplete: true,
        removeOnFail: 100
    }
});

// Очередь для экспорта данных
const exportQueue = new Queue('export', {
    ...QUEUE_CONFIG,
    limiter: { max: 2, duration: 1000 } // 2 экспорта в секунду
});

// Очередь для Telegram
const telegramQueue = new Queue('telegram', QUEUE_CONFIG);

// Очередь для очистки
const cleanupQueue = new Queue('cleanup', {
    ...QUEUE_CONFIG,
    defaultJobOptions: {
        ...QUEUE_CONFIG.defaultJobOptions,
        removeOnComplete: true,
        removeOnFail: true
    }
});

// ============================================
= ОБРАБОТЧИКИ ОЧЕРЕДЕЙ
// ============================================

// ========================================
// EMAIL QUEUE
// ========================================
emailQueue.process(async (job) => {
    const { type, data } = job.data;
    
    const { sendEmail, sendVerificationEmail, sendResetPasswordEmail, sendNewMessageNotification, sendSoldNotification, sendNewReviewNotification, sendLotteryWinNotification, sendListingApprovedNotification, sendListingRejectedNotification, sendAccountBlockedNotification, sendMassEmail } = require('./services/emailService');
    
    switch (type) {
        case 'send_email':
            return await sendEmail(data.to, data.subject, data.html, data.text);
        case 'send_verification':
            return await sendVerificationEmail(data.to, data.name, data.code);
        case 'send_reset_password':
            return await sendResetPasswordEmail(data.to, data.name, data.code);
        case 'send_new_message':
            return await sendNewMessageNotification(data.to, data.name, data.senderName, data.listingTitle, data.chatUrl);
        case 'send_sold':
            return await sendSoldNotification(data.to, data.name, data.listingTitle, data.buyerName, data.price);
        case 'send_new_review':
            return await sendNewReviewNotification(data.to, data.name, data.reviewerName, data.rating, data.text, data.listingTitle);
        case 'send_lottery_win':
            return await sendLotteryWinNotification(data.to, data.name, data.prize, data.drawDate);
        case 'send_listing_approved':
            return await sendListingApprovedNotification(data.to, data.name, data.listingTitle, data.listingUrl);
        case 'send_listing_rejected':
            return await sendListingRejectedNotification(data.to, data.name, data.listingTitle, data.reason);
        case 'send_account_blocked':
            return await sendAccountBlockedNotification(data.to, data.name, data.reason, data.duration);
        case 'send_mass_email':
            return await sendMassEmail(data.recipients, data.subject, data.content);
        default:
            throw new Error(`Unknown email job type: ${type}`);
    }
});

// ========================================
// NOTIFICATION QUEUE
// ========================================
notificationQueue.process(async (job) => {
    const { type, data } = job.data;
    
    const { sendNotification, sendMassNotification } = require('./services/notificationService');
    
    switch (type) {
        case 'send_notification':
            return await sendNotification(data.userId, data.type, data.data);
        case 'send_mass_notification':
            return await sendMassNotification(data.userIds, data.type, data.data);
        case 'new_message_notification':
            return await sendNotification(data.userId, 'message', {
                title: 'Новое сообщение',
                message: data.message,
                senderName: data.senderName,
                chatId: data.chatId
            });
        case 'new_like_notification':
            return await sendNotification(data.userId, 'like', {
                title: 'Новый лайк',
                message: `${data.likerName} понравилось ваше объявление "${data.listingTitle}"`,
                listingId: data.listingId
            });
        case 'new_review_notification':
            return await sendNotification(data.userId, 'review', {
                title: 'Новый отзыв',
                message: `${data.reviewerName} оставил отзыв с оценкой ${data.rating}⭐`,
                reviewId: data.reviewId
            });
        case 'new_subscription_notification':
            return await sendNotification(data.userId, 'subscription', {
                title: 'Новый подписчик',
                message: `${data.subscriberName} подписался на ваши обновления`
            });
        case 'lottery_win_notification':
            return await sendNotification(data.userId, 'lottery', {
                title: 'Вы выиграли в лотерее!',
                message: `Поздравляем! Вы выиграли ${data.prize} бонусов!`,
                prize: data.prize,
                drawId: data.drawId
            });
        case 'payment_success_notification':
            return await sendNotification(data.userId, 'system', {
                title: 'Платёж успешно проведён',
                message: `Сумма: ${data.amount} ₽`
            });
        case 'withdrawal_completed_notification':
            return await sendNotification(data.userId, 'system', {
                title: 'Вывод средств выполнен',
                message: `Сумма: ${data.amount} ₽`
            });
        case 'notify_moderators':
            return await sendNotification(null, 'system', {
                title: 'Новое событие модерации',
                message: `${data.type}: ${data.reason}`,
                link: '/admin.html'
            });
        default:
            throw new Error(`Unknown notification job type: ${type}`);
    }
});

// ========================================
// IMAGE PROCESSING QUEUE
// ========================================
imageQueue.process(async (job) => {
    const { listingId, files } = job.data;
    
    const { processImage, generateAllThumbnails } = require('./services/imageService');
    const { ListingPhoto } = require('./models');
    
    const results = [];
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileBuffer = require('fs').readFileSync(file.path);
        
        // Создаём миниатюры
        const thumbnails = await generateAllThumbnails(fileBuffer, `${listingId}_${i}`, 'listings');
        
        // Сохраняем в БД
        const photo = await ListingPhoto.add(listingId, thumbnails.medium, i);
        results.push(photo);
        
        // Удаляем временный файл
        require('fs').unlinkSync(file.path);
    }
    
    return { listingId, photos: results };
});

// ========================================
// VIDEO PROCESSING QUEUE
// ========================================
videoQueue.process(async (job) => {
    const { listingId, videoPath } = job.data;
    
    const { processVideo } = require('./services/videoService');
    const { Listing } = require('./models');
    
    const result = await processVideo(videoPath, { listingId });
    
    await Listing.update(listingId, { video_url: result.streamUrl, video_thumbnail: result.thumbnail });
    
    return { listingId, video: result };
});

// ========================================
// ANALYTICS QUEUE
// ========================================
analyticsQueue.process(async (job) => {
    const { type, data } = job.data;
    
    const analyticsService = require('./services/analyticsService');
    
    switch (type) {
        case 'track_view':
            return await analyticsService.trackView(data.listingId, data.userId, data.ip);
        case 'track_new_user':
            return await analyticsService.trackNewUser(data.userId);
        case 'track_new_listing':
            return await analyticsService.trackNewListing(data.listingId, data.userId, data.categoryId);
        case 'track_new_message':
            return await analyticsService.trackNewMessage(data.chatId, data.userId);
        case 'track_search_query':
            return await analyticsService.trackSearchQuery(data.query, data.userId, data.resultsCount);
        case 'track_revenue':
            return await analyticsService.trackRevenue(data.amount, data.type, data.userId);
        case 'save_search_analytics':
            return await analyticsService.saveSearchAnalytics(data.query, data.userId, data.resultsCount);
        default:
            throw new Error(`Unknown analytics job type: ${type}`);
    }
});

// ========================================
// EXPORT QUEUE
// ========================================
exportQueue.process(async (job) => {
    const { jobId, type, format, date_from, date_to, requestedBy } = job.data;
    
    const exportService = require('./services/exportService');
    const { sendNotification } = require('./services/notificationService');
    
    let result;
    
    switch (type) {
        case 'users':
            result = await exportService.exportUsers(requestedBy, format, date_from, date_to);
            break;
        case 'listings':
            result = await exportService.exportListings(requestedBy, format, date_from, date_to);
            break;
        case 'payments':
            result = await exportService.exportPayments(requestedBy, format, date_from, date_to);
            break;
        default:
            throw new Error(`Unknown export type: ${type}`);
    }
    
    // Уведомляем пользователя о готовности экспорта
    await sendNotification(requestedBy, 'system', {
        title: 'Экспорт данных готов',
        message: `Файл ${result.filename} готов к скачиванию`,
        link: `/api/v1/exports/download/${jobId}`
    });
    
    return result;
});

// ========================================
// TELEGRAM QUEUE
// ========================================
telegramQueue.process(async (job) => {
    const { chatId, text, parseMode } = job.data;
    
    const axios = require('axios');
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    
    if (!botToken) {
        throw new Error('Telegram bot token not configured');
    }
    
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    const response = await axios.post(url, {
        chat_id: chatId,
        text: text,
        parse_mode: parseMode || 'HTML',
        disable_web_page_preview: true
    });
    
    return response.data;
});

// ========================================
// CLEANUP QUEUE
// ========================================
cleanupQueue.process(async (job) => {
    const { type } = job.data;
    
    switch (type) {
        case 'cleanup_temp_files':
            const { cleanupTempFiles } = require('./services/imageService');
            return await cleanupTempFiles(24);
        case 'cleanup_old_exports':
            const { cleanupOldExports } = require('./services/exportService');
            return await cleanupOldExports();
        case 'cleanup_old_logs':
            const { cleanupOldLogs } = require('./utils/logger');
            return await cleanupOldLogs(30);
        case 'cleanup_old_backups':
            const { cleanupOldBackups } = require('./services/backupService');
            return await cleanupOldBackups('database');
        default:
            throw new Error(`Unknown cleanup type: ${type}`);
    }
});

// ============================================
= МОНИТОРИНГ ОЧЕРЕДЕЙ
// ============================================

// Мониторинг очередей
const queues = {
    email: emailQueue,
    notification: notificationQueue,
    image: imageQueue,
    video: videoQueue,
    analytics: analyticsQueue,
    export: exportQueue,
    telegram: telegramQueue,
    cleanup: cleanupQueue
};

// Функция для получения статистики всех очередей
async function getAllQueuesStats() {
    const stats = {};
    
    for (const [name, queue] of Object.entries(queues)) {
        const [waiting, active, completed, failed, delayed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
            queue.getDelayedCount()
        ]);
        
        stats[name] = {
            waiting,
            active,
            completed,
            failed,
            delayed,
            total: waiting + active + completed + failed + delayed
        };
    }
    
    return stats;
}

// Функция для очистки завершённых заданий
async function cleanCompletedJobs(queueName, age = 3600) {
    const queue = queues[queueName];
    if (!queue) throw new Error(`Queue ${queueName} not found`);
    
    await queue.clean(age, 'completed');
    return true;
}

// Функция для очистки неудачных заданий
async function cleanFailedJobs(queueName, age = 86400) {
    const queue = queues[queueName];
    if (!queue) throw new Error(`Queue ${queueName} not found`);
    
    await queue.clean(age, 'failed');
    return true;
}

// Функция для повторного выполнения неудачных заданий
async function retryFailedJobs(queueName, limit = 100) {
    const queue = queues[queueName];
    if (!queue) throw new Error(`Queue ${queueName} not found`);
    
    const failedJobs = await queue.getFailed();
    const retried = [];
    
    for (let i = 0; i < Math.min(failedJobs.length, limit); i++) {
        await failedJobs[i].retry();
        retried.push(failedJobs[i].id);
    }
    
    return retried;
}

// ============================================
= ЗАПУСК ПЛАНИРОВЩИКА
// ============================================

function startQueueScheduler() {
    const cron = require('node-cron');
    
    // Очистка временных файлов каждый час
    cron.schedule('0 * * * *', async () => {
        await addJob('cleanup', 'cleanup_temp_files', { type: 'cleanup_temp_files' });
    });
    
    // Очистка старых экспортов каждый день в 2:00
    cron.schedule('0 2 * * *', async () => {
        await addJob('cleanup', 'cleanup_old_exports', { type: 'cleanup_old_exports' });
    });
    
    // Очистка старых логов каждый день в 3:00
    cron.schedule('0 3 * * *', async () => {
        await addJob('cleanup', 'cleanup_old_logs', { type: 'cleanup_old_logs' });
    });
    
    // Очистка старых бэкапов каждый день в 4:00
    cron.schedule('0 4 * * *', async () => {
        await addJob('cleanup', 'cleanup_old_backups', { type: 'cleanup_old_backups' });
    });
    
    console.log('⏰ Планировщик очередей запущен');
}

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    // Очереди
    emailQueue,
    notificationQueue,
    imageQueue,
    videoQueue,
    analyticsQueue,
    exportQueue,
    telegramQueue,
    cleanupQueue,
    
    // Утилиты
    getAllQueuesStats,
    cleanCompletedJobs,
    cleanFailedJobs,
    retryFailedJobs,
    startQueueScheduler,
    
    // Конфигурация
    QUEUE_CONFIG
};