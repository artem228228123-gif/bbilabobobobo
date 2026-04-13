/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/cluster.js
 * Описание: Кластеризация для использования всех ядер CPU
 */

const cluster = require('cluster');
const os = require('os');
const process = require('process');
const { config } = require('../config/env');

// ============================================
// КОНСТАНТЫ
// ============================================

const CPU_COUNT = os.cpus().length;
const IS_CLUSTER_ENABLED = process.env.CLUSTER_ENABLED === 'true' && config.app.isProduction;
const WORKER_COUNT = IS_CLUSTER_ENABLED ? CPU_COUNT : 1;

// Цвета для вывода
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    red: '\x1b[31m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

// ============================================
// МАСТЕР-ПРОЦЕСС
// ============================================

if (cluster.isPrimary && IS_CLUSTER_ENABLED) {
    // Запуск мастер-процесса
    log('╔══════════════════════════════════════════════════════════════════╗', 'cyan');
    log('║                    AIDA CLUSTER MASTER                          ║', 'cyan');
    log('╠══════════════════════════════════════════════════════════════════╣', 'cyan');
    log(`║  🖥️  CPU ядер: ${CPU_COUNT}                                           ║`, 'cyan');
    log(`║  👷 Воркеров: ${CPU_COUNT}                                            ║`, 'cyan');
    log(`║  📍 PID мастер: ${process.pid}                                      ║`, 'cyan');
    log('╚══════════════════════════════════════════════════════════════════╝', 'cyan');
    log('', 'reset');
    
    // Счётчик перезапусков воркеров
    const restartCount = new Map();
    
    // Функция форка воркера
    function forkWorker() {
        const worker = cluster.fork();
        const workerId = worker.id;
        
        log(`🟢 Воркер ${workerId} (PID: ${worker.process.pid}) запущен`, 'green');
        
        // Обработка сообщений от воркера
        worker.on('message', (msg) => {
            if (msg.type === 'health_check') {
                log(`💚 Воркер ${workerId} здоров`, 'green');
            }
            
            if (msg.type === 'error') {
                log(`⚠️ Воркер ${workerId} сообщил об ошибке: ${msg.error}`, 'yellow');
            }
        });
        
        // Обработка выхода воркера
        worker.on('exit', (code, signal) => {
            const count = (restartCount.get(workerId) || 0) + 1;
            restartCount.set(workerId, count);
            
            log(`🔴 Воркер ${workerId} (PID: ${worker.process.pid}) завершил работу`, 'red');
            log(`   Код: ${code}, Сигнал: ${signal}`, 'yellow');
            log(`   Перезапуск #${count}...`, 'yellow');
            
            // Перезапускаем воркера
            setTimeout(() => {
                forkWorker();
                restartCount.delete(workerId);
            }, 1000);
        });
        
        return worker;
    }
    
    // Запуск всех воркеров
    const workers = [];
    for (let i = 0; i < WORKER_COUNT; i++) {
        workers.push(forkWorker());
    }
    
    // Graceful shutdown для мастер-процесса
    function gracefulShutdown() {
        log('\n🛑 Получен сигнал завершения, закрываем воркеров...', 'yellow');
        
        let completed = 0;
        const totalWorkers = workers.length;
        
        for (const worker of workers) {
            worker.disconnect();
            worker.on('exit', () => {
                completed++;
                if (completed === totalWorkers) {
                    log('✅ Все воркеры завершены, мастер завершает работу', 'green');
                    process.exit(0);
                }
            });
        }
        
        // Таймаут принудительного завершения
        setTimeout(() => {
            log('⚠️ Таймаут ожидания, принудительное завершение', 'yellow');
            process.exit(1);
        }, 10000);
    }
    
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
    
    // Мониторинг воркеров (каждые 10 секунд)
    setInterval(() => {
        for (const worker of workers) {
            if (worker.isConnected()) {
                worker.send({ type: 'ping' });
            }
        }
    }, 10000);
    
    // Вывод статистики каждые 30 секунд
    setInterval(() => {
        const memoryUsage = process.memoryUsage();
        log('\n📊 Статистика мастер-процесса:', 'cyan');
        log(`   RSS: ${Math.round(memoryUsage.rss / 1024 / 1024)} MB`, 'cyan');
        log(`   Heap Total: ${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`, 'cyan');
        log(`   Heap Used: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`, 'cyan');
        
        for (const worker of workers) {
            const status = worker.isConnected() ? '🟢 активен' : '🔴 отключён';
            log(`   Воркер ${worker.id}: PID ${worker.process.pid} - ${status}`, 'cyan');
        }
    }, 30000);
    
} else {
    // ============================================
    // ВОРКЕР-ПРОЦЕСС
    // ============================================
    
    const app = require('./app');
    const http = require('http');
    const { initSocket } = require('./socket');
    const { initJobs } = require('./jobs/cleanupJob');
    const { db, redis } = require('../config/database');
    const { config } = require('../config/env');
    
    const PORT = process.env.PORT || 3000;
    
    // Функция отправки health check
    function sendHealthCheck() {
        if (process.send) {
            process.send({ type: 'health_check', timestamp: Date.now() });
        }
    }
    
    // Обработка сообщений от мастера
    process.on('message', (msg) => {
        if (msg.type === 'ping') {
            sendHealthCheck();
        }
    });
    
    // Запуск сервера
    async function startWorker() {
        try {
            // Подключение к БД и Redis
            await db.connect();
            await redis.ping();
            
            log(`✅ Воркер ${cluster.worker.id} (PID: ${process.pid}) подключён к БД и Redis`, 'green');
            
            // Создание HTTP сервера
            const server = http.createServer(app);
            
            // Инициализация WebSocket
            const io = initSocket(server);
            app.set('io', io);
            
            // Инициализация фоновых задач
            initJobs();
            
            // Запуск сервера
            server.listen(PORT, () => {
                log(`🚀 Воркер ${cluster.worker.id} (PID: ${process.pid}) запущен на порту ${PORT}`, 'green');
                sendHealthCheck();
            });
            
            // Graceful shutdown для воркера
            function gracefulShutdown() {
                log(`🛑 Воркер ${cluster.worker.id} (PID: ${process.pid}) завершает работу...`, 'yellow');
                
                server.close(async () => {
                    await db.end();
                    await redis.quit();
                    log(`✅ Воркер ${cluster.worker.id} завершил работу`, 'green');
                    process.exit(0);
                });
                
                setTimeout(() => {
                    log(`⚠️ Воркер ${cluster.worker.id} принудительно завершён`, 'yellow');
                    process.exit(1);
                }, 5000);
            }
            
            process.on('SIGTERM', gracefulShutdown);
            process.on('SIGINT', gracefulShutdown);
            
        } catch (error) {
            log(`❌ Воркер ${cluster.worker.id} (PID: ${process.pid}) ошибка: ${error.message}`, 'red');
            if (process.send) {
                process.send({ type: 'error', error: error.message });
            }
            process.exit(1);
        }
    }
    
    // Запуск воркера
    startWorker();
}

// ============================================
= ЭКСПОРТ ДЛЯ ТЕСТИРОВАНИЯ
// ============================================

module.exports = {
    CPU_COUNT,
    IS_CLUSTER_ENABLED,
    WORKER_COUNT
};