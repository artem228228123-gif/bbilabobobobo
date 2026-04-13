/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/worker.js
 * Описание: Фоновый воркер для обработки очередей (отдельный процесс)
 */

const { redis } = require('../config/redis');
const { config } = require('../config/env');

// ============================================
// КОНФИГУРАЦИЯ
// ============================================

const WORKER_TYPE = process.env.WORKER_TYPE || 'all'; // all, email, notification, image, video, analytics, export, telegram, cleanup

// Цвета для вывода
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    red: '\x1b[31m',
    magenta: '\x1b[35m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

// ============================================
// ИНИЦИАЛИЗАЦИЯ ОЧЕРЕДЕЙ
// ============================================

const {
    emailQueue,
    notificationQueue,
    imageQueue,
    videoQueue,
    analyticsQueue,
    exportQueue,
    telegramQueue,
    cleanupQueue,
    QUEUE_CONFIG
} = require('./queue');

// ============================================
= ФУНКЦИЯ ЗАПУСКА ВОРКЕРА
// ============================================

async function startWorker() {
    log('╔══════════════════════════════════════════════════════════════════╗', 'cyan');
    log('║                    AIDA BACKGROUND WORKER                        ║', 'cyan');
    log('╠══════════════════════════════════════════════════════════════════╣', 'cyan');
    log(`║  🏷️  Тип воркера: ${WORKER_TYPE.padEnd(50)}║`, 'cyan');
    log(`║  📍 PID: ${process.pid.toString().padEnd(50)}║`, 'cyan');
    log('╚══════════════════════════════════════════════════════════════════╝', 'cyan');
    log('', 'reset');

    try {
        // Проверка подключения к Redis
        await redis.ping();
        log('✅ Подключение к Redis установлено', 'green');

        // Запуск обработчиков в зависимости от типа воркера
        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'email') {
            emailQueue.process();
            log('📧 Email воркер запущен', 'green');
        }

        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'notification') {
            notificationQueue.process();
            log('🔔 Notification воркер запущен', 'green');
        }

        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'image') {
            imageQueue.process();
            log('🖼️ Image воркер запущен', 'green');
        }

        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'video') {
            videoQueue.process();
            log('🎬 Video воркер запущен', 'green');
        }

        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'analytics') {
            analyticsQueue.process();
            log('📊 Analytics воркер запущен', 'green');
        }

        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'export') {
            exportQueue.process();
            log('📤 Export воркер запущен', 'green');
        }

        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'telegram') {
            telegramQueue.process();
            log('📱 Telegram воркер запущен', 'green');
        }

        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'cleanup') {
            cleanupQueue.process();
            log('🧹 Cleanup воркер запущен', 'green');
        }

        // Обработка ошибок очередей
        const queues = [];
        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'email') queues.push(emailQueue);
        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'notification') queues.push(notificationQueue);
        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'image') queues.push(imageQueue);
        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'video') queues.push(videoQueue);
        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'analytics') queues.push(analyticsQueue);
        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'export') queues.push(exportQueue);
        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'telegram') queues.push(telegramQueue);
        if (WORKER_TYPE === 'all' || WORKER_TYPE === 'cleanup') queues.push(cleanupQueue);

        for (const queue of queues) {
            queue.on('error', (error) => {
                log(`❌ Ошибка очереди ${queue.name}: ${error.message}`, 'red');
            });

            queue.on('failed', (job, err) => {
                log(`❌ Задача ${job.id} в очереди ${queue.name} провалилась: ${err.message}`, 'red');
            });

            queue.on('completed', (job) => {
                log(`✅ Задача ${job.id} в очереди ${queue.name} выполнена`, 'green');
            });

            queue.on('stalled', (job) => {
                log(`⚠️ Задача ${job.id} в очереди ${queue.name} застряла`, 'yellow');
            });
        }

        // Периодический вывод статистики (каждые 30 секунд)
        setInterval(async () => {
            const stats = {};
            
            for (const queue of queues) {
                const [waiting, active, completed, failed, delayed] = await Promise.all([
                    queue.getWaitingCount(),
                    queue.getActiveCount(),
                    queue.getCompletedCount(),
                    queue.getFailedCount(),
                    queue.getDelayedCount()
                ]);
                
                stats[queue.name] = { waiting, active, completed, failed, delayed };
            }
            
            log('\n📊 Статистика очередей:', 'cyan');
            for (const [name, stat] of Object.entries(stats)) {
                log(`   ${name}: waiting=${stat.waiting}, active=${stat.active}, completed=${stat.completed}, failed=${stat.failed}`, 'cyan');
            }
        }, 30000);

        log('\n✅ Воркер успешно запущен и ожидает задачи', 'green');
        log('⏹️ Нажмите Ctrl+C для остановки\n', 'yellow');

    } catch (error) {
        log(`❌ Ошибка запуска воркера: ${error.message}`, 'red');
        process.exit(1);
    }
}

// ============================================
= GRACEFUL SHUTDOWN
// ============================================

async function gracefulShutdown() {
    log('\n🛑 Получен сигнал завершения, закрываем воркер...', 'yellow');
    
    const queues = [];
    if (WORKER_TYPE === 'all' || WORKER_TYPE === 'email') queues.push(emailQueue);
    if (WORKER_TYPE === 'all' || WORKER_TYPE === 'notification') queues.push(notificationQueue);
    if (WORKER_TYPE === 'all' || WORKER_TYPE === 'image') queues.push(imageQueue);
    if (WORKER_TYPE === 'all' || WORKER_TYPE === 'video') queues.push(videoQueue);
    if (WORKER_TYPE === 'all' || WORKER_TYPE === 'analytics') queues.push(analyticsQueue);
    if (WORKER_TYPE === 'all' || WORKER_TYPE === 'export') queues.push(exportQueue);
    if (WORKER_TYPE === 'all' || WORKER_TYPE === 'telegram') queues.push(telegramQueue);
    if (WORKER_TYPE === 'all' || WORKER_TYPE === 'cleanup') queues.push(cleanupQueue);
    
    for (const queue of queues) {
        await queue.close();
    }
    
    await redis.quit();
    
    log('✅ Воркер завершил работу', 'green');
    process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ============================================
= ЗАПУСК
// ============================================

if (require.main === module) {
    startWorker();
}

module.exports = { startWorker };