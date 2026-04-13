/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: config/redis.js
 * Описание: Подключение к Redis, кеширование, очереди задач, сессии, рейтинги
 */

const Redis = require('ioredis');
const { config } = require('./env');

// ============================================
// ПОДКЛЮЧЕНИЕ К REDIS
// ============================================

let redisClient = null;
let subscriber = null;
let publisher = null;

// Создание подключения
function createRedisClient() {
    if (redisClient) return redisClient;
    
    const options = {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT, 10) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: parseInt(process.env.REDIS_DB, 10) || 0,
        retryStrategy: (times) => {
            const delay = Math.min(times * 50, 2000);
            console.log(`🔄 Переподключение к Redis через ${delay}ms (попытка ${times})`);
            return delay;
        },
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
    };
    
    redisClient = new Redis(options);
    
    redisClient.on('connect', () => {
        console.log('✅ Redis подключён');
    });
    
    redisClient.on('ready', () => {
        console.log('🎯 Redis готов к работе');
    });
    
    redisClient.on('error', (error) => {
        console.error('❌ Ошибка Redis:', error.message);
    });
    
    redisClient.on('close', () => {
        console.warn('⚠️ Соединение с Redis закрыто');
    });
    
    redisClient.on('reconnecting', () => {
        console.log('🔄 Переподключение к Redis...');
    });
    
    return redisClient;
}

// Создание подписчика (для Pub/Sub)
function createSubscriber() {
    if (subscriber) return subscriber;
    subscriber = createRedisClient();
    return subscriber;
}

// Создание издателя (для Pub/Sub)
function createPublisher() {
    if (publisher) return publisher;
    publisher = createRedisClient();
    return publisher;
}

// ============================================
// ОСНОВНЫЕ ФУНКЦИИ РАБОТЫ С КЕШЕМ
// ============================================

// Получение значения из кеша
async function get(key) {
    try {
        const value = await redisClient.get(key);
        if (!value) return null;
        
        // Пытаемся распарсить JSON
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    } catch (error) {
        console.error(`❌ Ошибка получения ключа ${key}:`, error.message);
        return null;
    }
}

// Установка значения в кеш
async function set(key, value, ttlSeconds = null) {
    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        
        if (ttlSeconds) {
            await redisClient.setex(key, ttlSeconds, serialized);
        } else {
            await redisClient.set(key, serialized);
        }
        return true;
    } catch (error) {
        console.error(`❌ Ошибка установки ключа ${key}:`, error.message);
        return false;
    }
}

// Удаление ключа из кеша
async function del(key) {
    try {
        await redisClient.del(key);
        return true;
    } catch (error) {
        console.error(`❌ Ошибка удаления ключа ${key}:`, error.message);
        return false;
    }
}

// Проверка существования ключа
async function exists(key) {
    try {
        return await redisClient.exists(key) === 1;
    } catch (error) {
        return false;
    }
}

// Установка времени жизни ключа
async function expire(key, ttlSeconds) {
    try {
        await redisClient.expire(key, ttlSeconds);
        return true;
    } catch (error) {
        return false;
    }
}

// Инкремент счётчика
async function incr(key, by = 1) {
    try {
        return await redisClient.incrby(key, by);
    } catch (error) {
        console.error(`❌ Ошибка инкремента ${key}:`, error.message);
        return null;
    }
}

// Получение нескольких ключей
async function mget(keys) {
    try {
        const values = await redisClient.mget(keys);
        return values.map(v => {
            if (!v) return null;
            try {
                return JSON.parse(v);
            } catch {
                return v;
            }
        });
    } catch (error) {
        console.error('❌ Ошибка mget:', error.message);
        return [];
    }
}

// Установка нескольких ключей
async function mset(keyValuePairs, ttlSeconds = null) {
    try {
        const args = [];
        for (const [key, value] of Object.entries(keyValuePairs)) {
            const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
            args.push(key, serialized);
        }
        await redisClient.mset(...args);
        
        if (ttlSeconds) {
            for (const key of Object.keys(keyValuePairs)) {
                await redisClient.expire(key, ttlSeconds);
            }
        }
        return true;
    } catch (error) {
        console.error('❌ Ошибка mset:', error.message);
        return false;
    }
}

// ============================================
// РАБОТА СО СПИСКАМИ (LIST)
// ============================================

// Добавление в начало списка
async function lpush(key, value) {
    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return await redisClient.lpush(key, serialized);
    } catch (error) {
        console.error(`❌ Ошибка lpush ${key}:`, error.message);
        return 0;
    }
}

// Добавление в конец списка
async function rpush(key, value) {
    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return await redisClient.rpush(key, serialized);
    } catch (error) {
        console.error(`❌ Ошибка rpush ${key}:`, error.message);
        return 0;
    }
}

// Получение из начала списка (и удаление)
async function lpop(key) {
    try {
        const value = await redisClient.lpop(key);
        if (!value) return null;
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    } catch (error) {
        console.error(`❌ Ошибка lpop ${key}:`, error.message);
        return null;
    }
}

// Получение из конца списка (и удаление)
async function rpop(key) {
    try {
        const value = await redisClient.rpop(key);
        if (!value) return null;
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    } catch (error) {
        console.error(`❌ Ошибка rpop ${key}:`, error.message);
        return null;
    }
}

// Получение диапазона списка
async function lrange(key, start, stop) {
    try {
        const values = await redisClient.lrange(key, start, stop);
        return values.map(v => {
            try {
                return JSON.parse(v);
            } catch {
                return v;
            }
        });
    } catch (error) {
        console.error(`❌ Ошибка lrange ${key}:`, error.message);
        return [];
    }
}

// Получение длины списка
async function llen(key) {
    try {
        return await redisClient.llen(key);
    } catch (error) {
        return 0;
    }
}

// ============================================
// РАБОТА СО МНОЖЕСТВАМИ (SET)
// ============================================

// Добавление в множество
async function sadd(key, value) {
    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return await redisClient.sadd(key, serialized);
    } catch (error) {
        console.error(`❌ Ошибка sadd ${key}:`, error.message);
        return 0;
    }
}

// Удаление из множества
async function srem(key, value) {
    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return await redisClient.srem(key, serialized);
    } catch (error) {
        console.error(`❌ Ошибка srem ${key}:`, error.message);
        return 0;
    }
}

// Проверка принадлежности множеству
async function sismember(key, value) {
    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return await redisClient.sismember(key, serialized);
    } catch (error) {
        return false;
    }
}

// Получение всех элементов множества
async function smembers(key) {
    try {
        const values = await redisClient.smembers(key);
        return values.map(v => {
            try {
                return JSON.parse(v);
            } catch {
                return v;
            }
        });
    } catch (error) {
        console.error(`❌ Ошибка smembers ${key}:`, error.message);
        return [];
    }
}

// ============================================
// РАБОТА СО СОРТИРОВАННЫМИ МНОЖЕСТВАМИ (ZSET)
// ============================================

// Добавление с оценкой
async function zadd(key, score, value) {
    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return await redisClient.zadd(key, score, serialized);
    } catch (error) {
        console.error(`❌ Ошибка zadd ${key}:`, error.message);
        return 0;
    }
}

// Инкремент оценки
async function zincrby(key, increment, value) {
    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return await redisClient.zincrby(key, increment, serialized);
    } catch (error) {
        console.error(`❌ Ошибка zincrby ${key}:`, error.message);
        return 0;
    }
}

// Получение рейтинга (по убыванию)
async function zrevrange(key, start, stop, withScores = false) {
    try {
        let result;
        if (withScores) {
            result = await redisClient.zrevrange(key, start, stop, 'WITHSCORES');
            // Преобразуем в массив объектов { value, score }
            const items = [];
            for (let i = 0; i < result.length; i += 2) {
                let value = result[i];
                try {
                    value = JSON.parse(value);
                } catch {}
                items.push({
                    value,
                    score: parseFloat(result[i + 1])
                });
            }
            return items;
        } else {
            result = await redisClient.zrevrange(key, start, stop);
            return result.map(v => {
                try {
                    return JSON.parse(v);
                } catch {
                    return v;
                }
            });
        }
    } catch (error) {
        console.error(`❌ Ошибка zrevrange ${key}:`, error.message);
        return [];
    }
}

// Получение ранга элемента (позиция в рейтинге)
async function zrevrank(key, value) {
    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        const rank = await redisClient.zrevrank(key, serialized);
        return rank !== null ? rank + 1 : null;
    } catch (error) {
        return null;
    }
}

// Получение оценки элемента
async function zscore(key, value) {
    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        const score = await redisClient.zscore(key, serialized);
        return score ? parseFloat(score) : null;
    } catch (error) {
        return null;
    }
}

// Удаление элемента
async function zrem(key, value) {
    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return await redisClient.zrem(key, serialized);
    } catch (error) {
        return 0;
    }
}

// Получение количества элементов
async function zcard(key) {
    try {
        return await redisClient.zcard(key);
    } catch (error) {
        return 0;
    }
}

// ============================================
// РАБОТА С ХЭШАМИ (HASH)
// ============================================

// Установка поля в хэше
async function hset(key, field, value) {
    try {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return await redisClient.hset(key, field, serialized);
    } catch (error) {
        console.error(`❌ Ошибка hset ${key}.${field}:`, error.message);
        return 0;
    }
}

// Установка нескольких полей
async function hmset(key, obj) {
    try {
        const args = [];
        for (const [field, value] of Object.entries(obj)) {
            const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
            args.push(field, serialized);
        }
        return await redisClient.hmset(key, ...args);
    } catch (error) {
        console.error(`❌ Ошибка hmset ${key}:`, error.message);
        return false;
    }
}

// Получение поля из хэша
async function hget(key, field) {
    try {
        const value = await redisClient.hget(key, field);
        if (!value) return null;
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    } catch (error) {
        return null;
    }
}

// Получение всех полей хэша
async function hgetall(key) {
    try {
        const obj = await redisClient.hgetall(key);
        if (!obj) return {};
        
        const result = {};
        for (const [field, value] of Object.entries(obj)) {
            try {
                result[field] = JSON.parse(value);
            } catch {
                result[field] = value;
            }
        }
        return result;
    } catch (error) {
        console.error(`❌ Ошибка hgetall ${key}:`, error.message);
        return {};
    }
}

// Удаление поля из хэша
async function hdel(key, field) {
    try {
        return await redisClient.hdel(key, field);
    } catch (error) {
        return 0;
    }
}

// Инкремент поля в хэше
async function hincrby(key, field, increment) {
    try {
        return await redisClient.hincrby(key, field, increment);
    } catch (error) {
        return null;
    }
}

// ============================================
// PUB/SUB (ДЛЯ РЕАЛЬНОГО ВРЕМЕНИ)
// ============================================

// Публикация сообщения
async function publish(channel, message) {
    try {
        const pub = createPublisher();
        const serialized = typeof message === 'object' ? JSON.stringify(message) : message;
        return await pub.publish(channel, serialized);
    } catch (error) {
        console.error(`❌ Ошибка publish в канал ${channel}:`, error.message);
        return 0;
    }
}

// Подписка на канал
async function subscribe(channel, callback) {
    try {
        const sub = createSubscriber();
        await sub.subscribe(channel);
        
        sub.on('message', (ch, message) => {
            if (ch === channel) {
                try {
                    const data = JSON.parse(message);
                    callback(data);
                } catch {
                    callback(message);
                }
            }
        });
        
        return true;
    } catch (error) {
        console.error(`❌ Ошибка подписки на ${channel}:`, error.message);
        return false;
    }
}

// Отписка от канала
async function unsubscribe(channel) {
    try {
        const sub = createSubscriber();
        await sub.unsubscribe(channel);
        return true;
    } catch (error) {
        return false;
    }
}

// ============================================
// КЕШ ДЛЯ СПЕЦИФИЧЕСКИХ СЛУЧАЕВ
// ============================================

// Кеш ленты TikTok пользователя
async function cacheUserFeed(userId, listings, ttlSeconds = 3600) {
    const key = `feed:user:${userId}`;
    await del(key);
    for (const listing of listings) {
        await rpush(key, listing);
    }
    await expire(key, ttlSeconds);
}

// Получение кеша ленты
async function getUserFeed(userId, count = 10) {
    const key = `feed:user:${userId}`;
    const feed = await lrange(key, 0, count - 1);
    return feed;
}

// Кеш популярных объявлений
async function cachePopularListings(listings, ttlSeconds = 600) {
    const key = 'trending:listings';
    await del(key);
    for (const listing of listings) {
        await zadd(key, listing.score || listing.views, listing);
    }
    await expire(key, ttlSeconds);
}

// Получение популярных объявлений
async function getPopularListings(limit = 20) {
    const key = 'trending:listings';
    return await zrevrange(key, 0, limit - 1, true);
}

// Кеш категорий
async function cacheCategories(categories, ttlSeconds = 3600) {
    await set('categories:tree', categories, ttlSeconds);
}

// Получение кеша категорий
async function getCachedCategories() {
    return await get('categories:tree');
}

// ============================================
// УПРАВЛЕНИЕ СЕССИЯМИ
// ============================================

// Создание сессии
async function createSession(sessionId, data, ttlSeconds = 7 * 24 * 3600) {
    await set(`session:${sessionId}`, data, ttlSeconds);
}

// Получение сессии
async function getSession(sessionId) {
    return await get(`session:${sessionId}`);
}

// Удаление сессии
async function destroySession(sessionId) {
    await del(`session:${sessionId}`);
}

// Удаление всех сессий пользователя
async function destroyAllUserSessions(userId) {
    const pattern = `session:*`;
    const keys = await redisClient.keys(pattern);
    for (const key of keys) {
        const session = await get(key);
        if (session && session.userId === userId) {
            await del(key);
        }
    }
}

// ============================================
// РЕЙТИНГИ И ЛИДЕРБОРДЫ
// ============================================

// Обновление рейтинга продавца
async function updateSellerRating(sellerId, newRating) {
    await zadd('leaderboard:sellers', newRating, sellerId);
}

// Получение топ продавцов
async function getTopSellers(limit = 100) {
    return await zrevrange('leaderboard:sellers', 0, limit - 1, true);
}

// Обновление рейтинга объявления
async function updateListingScore(listingId, views, likes) {
    const score = (views * 1) + (likes * 10);
    await zadd('leaderboard:listings', score, listingId);
}

// ============================================
// ОЧЕРЕДИ ЗАДАЧ (BULL)
// ============================================

const Queue = require('bull');

// Создание очереди
function createQueue(name, options = {}) {
    const defaultOptions = {
        redis: {
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT, 10) || 6379,
            password: process.env.REDIS_PASSWORD,
        },
        defaultJobOptions: {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 5000,
            },
            removeOnComplete: 100,
            removeOnFail: 1000,
        },
    };
    
    return new Queue(name, { ...defaultOptions, ...options });
}

// Основные очереди
const queues = {
    // Обработка изображений
    imageProcessing: null,
    // Отправка email
    emailQueue: null,
    // Отправка уведомлений
    notificationQueue: null,
    // Обработка видео (TikTok-лента)
    videoProcessing: null,
    // Аналитика
    analyticsQueue: null,
};

// Инициализация очередей
function initQueues() {
    queues.imageProcessing = createQueue('image-processing', {
        defaultJobOptions: {
            attempts: 2,
            timeout: 60000, // 60 секунд
        },
    });
    
    queues.emailQueue = createQueue('email-queue');
    queues.notificationQueue = createQueue('notification-queue');
    queues.videoProcessing = createQueue('video-processing', {
        defaultJobOptions: {
            attempts: 1,
            timeout: 300000, // 5 минут
        },
    });
    queues.analyticsQueue = createQueue('analytics-queue');
    
    console.log('📦 Очереди задач инициализированы');
    return queues;
}

// Добавление задачи в очередь
async function addJob(queueName, jobName, data, options = {}) {
    const queue = queues[queueName];
    if (!queue) {
        console.error(`❌ Очередь ${queueName} не найдена`);
        return null;
    }
    
    try {
        const job = await queue.add(jobName, data, options);
        return job;
    } catch (error) {
        console.error(`❌ Ошибка добавления задачи в ${queueName}:`, error.message);
        return null;
    }
}

// ============================================
// УТИЛИТЫ
// ============================================

// Очистка всех ключей по паттерну
async function flushPattern(pattern) {
    try {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) {
            await redisClient.del(...keys);
        }
        return keys.length;
    } catch (error) {
        console.error(`❌ Ошибка очистки паттерна ${pattern}:`, error.message);
        return 0;
    }
}

// Получение статистики Redis
async function getRedisStats() {
    try {
        const info = await redisClient.info();
        const memory = await redisClient.info('memory');
        const stats = await redisClient.info('stats');
        
        return {
            version: info.match(/redis_version:(\d+\.\d+\.\d+)/)?.[1] || 'unknown',
            uptime: parseInt(info.match(/uptime_in_seconds:(\d+)/)?.[1] || 0),
            connectedClients: parseInt(info.match(/connected_clients:(\d+)/)?.[1] || 0),
            usedMemory: parseInt(memory.match(/used_memory_human:(\d+\.\d+[KMGT]?)/)?.[1] || 0),
            totalCommandsProcessed: parseInt(stats.match(/total_commands_processed:(\d+)/)?.[1] || 0),
            keysCount: await redisClient.dbsize(),
        };
    } catch (error) {
        console.error('❌ Ошибка получения статистики Redis:', error.message);
        return null;
    }
}

// ============================================
// ЭКСПОРТ МОДУЛЯ
// ============================================

// Инициализация клиента
createRedisClient();

module.exports = {
    // Клиенты
    client: redisClient,
    getClient: createRedisClient,
    getSubscriber: createSubscriber,
    getPublisher: createPublisher,
    
    // Основные операции
    get,
    set,
    del,
    exists,
    expire,
    incr,
    mget,
    mset,
    
    // Списки
    lpush,
    rpush,
    lpop,
    rpop,
    lrange,
    llen,
    
    // Множества
    sadd,
    srem,
    sismember,
    smembers,
    
    // Сортированные множества
    zadd,
    zincrby,
    zrevrange,
    zrevrank,
    zscore,
    zrem,
    zcard,
    
    // Хэши
    hset,
    hmset,
    hget,
    hgetall,
    hdel,
    hincrby,
    
    // Pub/Sub
    publish,
    subscribe,
    unsubscribe,
    
    // Специальное кеширование
    cacheUserFeed,
    getUserFeed,
    cachePopularListings,
    getPopularListings,
    cacheCategories,
    getCachedCategories,
    
    // Сессии
    createSession,
    getSession,
    destroySession,
    destroyAllUserSessions,
    
    // Рейтинги
    updateSellerRating,
    getTopSellers,
    updateListingScore,
    
    // Очереди
    queues,
    initQueues,
    addJob,
    
    // Утилиты
    flushPattern,
    getRedisStats,
};

// Выводим информацию в development режиме
if (config.app.isDevelopment) {
    setTimeout(async () => {
        const stats = await getRedisStats();
        if (stats) {
            console.log(`📊 Redis статистика: ${stats.keysCount} ключей, ${stats.connectedClients} клиентов`);
        }
    }, 1000);
}