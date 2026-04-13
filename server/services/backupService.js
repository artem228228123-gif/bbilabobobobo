/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/backupService.js
 * Описание: Сервис резервного копирования (БД, файлы, автоматические бэкапы, восстановление)
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const archiver = require('archiver');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const execAsync = promisify(exec);
const { config } = require('../../config/env');
const { get, set, del } = require('../../config/redis');

// ============================================
// КОНФИГУРАЦИЯ
// ============================================

const BACKUP_CONFIG = {
    // Директории
    paths: {
        database: path.join(__dirname, '../../backups/database'),
        uploads: path.join(__dirname, '../../backups/uploads'),
        logs: path.join(__dirname, '../../backups/logs'),
        temp: path.join(__dirname, '../../backups/temp')
    },
    
    // Настройки
    retention: {
        database: 30,    // дней
        uploads: 7,      // дней
        logs: 14,        // дней
        full: 90         // дней для полных бэкапов
    },
    
    // Расписание (cron)
    schedule: {
        database: '0 4 * * *',      // каждый день в 4:00
        uploads: '0 5 * * 0',       // каждое воскресенье в 5:00
        full: '0 3 * * 1'           // каждый понедельник в 3:00 (полный бэкап)
    },
    
    // S3 (облачное хранилище)
    s3: {
        enabled: false,
        bucket: process.env.S3_BACKUP_BUCKET || 'aida-backups',
        region: process.env.S3_REGION || 'ru-msk',
        endpoint: process.env.S3_ENDPOINT || null
    }
};

// Создаём директории
Object.values(BACKUP_CONFIG.paths).forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Инициализация S3 клиента
let s3Client = null;
if (BACKUP_CONFIG.s3.enabled && config.storage.s3.accessKey) {
    s3Client = new S3Client({
        region: BACKUP_CONFIG.s3.region,
        endpoint: BACKUP_CONFIG.s3.endpoint,
        credentials: {
            accessKeyId: config.storage.s3.accessKey,
            secretAccessKey: config.storage.s3.secretKey
        }
    });
}

// ============================================
// БЭКАП БАЗЫ ДАННЫХ
// ============================================

/**
 * Создание резервной копии базы данных PostgreSQL
 * @returns {Promise<string>} - путь к файлу бэкапа
 */
async function backupDatabase() {
    const timestamp = getTimestamp();
    const filename = `database_backup_${timestamp}.sql.gz`;
    const filepath = path.join(BACKUP_CONFIG.paths.database, filename);
    
    console.log(`💾 Создание бэкапа БД: ${filename}`);
    
    try {
        // Создаём дамп БД и сжимаем
        const { database } = config;
        const command = `pg_dump --dbname=${database.url} --format=custom --compress=9 --file=${filepath}`;
        
        await execAsync(command);
        
        // Проверяем размер
        const stats = fs.statSync(filepath);
        console.log(`✅ Бэкап БД создан: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        
        // Очищаем старые бэкапы
        await cleanupOldBackups('database');
        
        // Отправляем в облако
        if (s3Client) {
            await uploadToS3(filepath, `database/${filename}`);
        }
        
        return filepath;
    } catch (error) {
        console.error('❌ Ошибка создания бэкапа БД:', error);
        throw error;
    }
}

/**
 * Восстановление базы данных из бэкапа
 * @param {string} backupFile - путь к файлу бэкапа
 * @returns {Promise<boolean>} - результат восстановления
 */
async function restoreDatabase(backupFile) {
    console.log(`🔄 Восстановление БД из: ${backupFile}`);
    
    try {
        const { database } = config;
        const command = `pg_restore --dbname=${database.url} --clean --if-exists --no-owner --no-privileges ${backupFile}`;
        
        await execAsync(command);
        console.log('✅ База данных восстановлена');
        return true;
    } catch (error) {
        console.error('❌ Ошибка восстановления БД:', error);
        throw error;
    }
}

// ============================================
// БЭКАП ЗАГРУЖЕННЫХ ФАЙЛОВ
// ============================================

/**
 * Создание резервной копии загруженных файлов
 * @returns {Promise<string>} - путь к файлу бэкапа
 */
async function backupUploads() {
    const timestamp = getTimestamp();
    const filename = `uploads_backup_${timestamp}.zip`;
    const filepath = path.join(BACKUP_CONFIG.paths.uploads, filename);
    
    console.log(`💾 Создание бэкапа загруженных файлов: ${filename}`);
    
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(filepath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        output.on('close', () => {
            console.log(`✅ Бэкап загруженных файлов создан: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`);
            cleanupOldBackups('uploads');
            
            if (s3Client) {
                uploadToS3(filepath, `uploads/${filename}`);
            }
            
            resolve(filepath);
        });
        
        archive.on('error', reject);
        archive.pipe(output);
        
        // Добавляем папку uploads
        const uploadsDir = path.join(__dirname, '../../uploads');
        if (fs.existsSync(uploadsDir)) {
            archive.directory(uploadsDir, 'uploads');
        }
        
        archive.finalize();
    });
}

// ============================================
// БЭКАП ЛОГОВ
// ============================================

/**
 * Создание резервной копии логов
 * @returns {Promise<string>} - путь к файлу бэкапа
 */
async function backupLogs() {
    const timestamp = getTimestamp();
    const filename = `logs_backup_${timestamp}.zip`;
    const filepath = path.join(BACKUP_CONFIG.paths.logs, filename);
    
    console.log(`💾 Создание бэкапа логов: ${filename}`);
    
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(filepath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        output.on('close', () => {
            console.log(`✅ Бэкап логов создан: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`);
            cleanupOldBackups('logs');
            
            if (s3Client) {
                uploadToS3(filepath, `logs/${filename}`);
            }
            
            resolve(filepath);
        });
        
        archive.on('error', reject);
        archive.pipe(output);
        
        // Добавляем папку логов
        const logsDir = path.join(__dirname, '../../logs');
        if (fs.existsSync(logsDir)) {
            archive.directory(logsDir, 'logs');
        }
        
        archive.finalize();
    });
}

// ============================================
// ПОЛНЫЙ БЭКАП
// ============================================

/**
 * Создание полного резервного копирования (БД + файлы + логи)
 * @returns {Promise<Object>} - результат бэкапа
 */
async function fullBackup() {
    console.log('🚀 Начало полного бэкапа...');
    
    const timestamp = getTimestamp();
    const filename = `full_backup_${timestamp}.zip`;
    const filepath = path.join(BACKUP_CONFIG.paths.temp, filename);
    
    return new Promise(async (resolve, reject) => {
        try {
            // Сначала создаём дамп БД
            const dbBackup = await backupDatabase();
            
            const output = fs.createWriteStream(filepath);
            const archive = archiver('zip', { zlib: { level: 9 } });
            
            output.on('close', async () => {
                console.log(`✅ Полный бэкап создан: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`);
                
                // Очищаем старые полные бэкапы
                await cleanupOldBackups('full');
                
                // Отправляем в облако
                if (s3Client) {
                    await uploadToS3(filepath, `full/${filename}`);
                }
                
                resolve(filepath);
            });
            
            archive.on('error', reject);
            archive.pipe(output);
            
            // Добавляем бэкап БД
            archive.file(dbBackup, { name: `database/${path.basename(dbBackup)` });
            
            // Добавляем папку uploads
            const uploadsDir = path.join(__dirname, '../../uploads');
            if (fs.existsSync(uploadsDir)) {
                archive.directory(uploadsDir, 'uploads');
            }
            
            // Добавляем папку логов
            const logsDir = path.join(__dirname, '../../logs');
            if (fs.existsSync(logsDir)) {
                archive.directory(logsDir, 'logs');
            }
            
            // Добавляем конфигурацию
            const configDir = path.join(__dirname, '../../config');
            if (fs.existsSync(configDir)) {
                archive.directory(configDir, 'config', (entry) => {
                    return !entry.name.includes('.env');
                });
            }
            
            await archive.finalize();
        } catch (error) {
            reject(error);
        }
    });
}

// ============================================
// ОБЛАЧНОЕ ХРАНЕНИЕ (S3)
// ============================================

/**
 * Загрузка бэкапа в облачное хранилище
 * @param {string} filepath - путь к файлу
 * @param {string} key - ключ в хранилище
 * @returns {Promise<boolean>} - результат загрузки
 */
async function uploadToS3(filepath, key) {
    if (!s3Client) return false;
    
    try {
        const fileContent = fs.readFileSync(filepath);
        const command = new PutObjectCommand({
            Bucket: BACKUP_CONFIG.s3.bucket,
            Key: key,
            Body: fileContent,
            StorageClass: 'GLACIER' // Для долгосрочного хранения
        });
        
        await s3Client.send(command);
        console.log(`📤 Бэкап загружен в S3: ${key}`);
        return true;
    } catch (error) {
        console.error('Ошибка загрузки в S3:', error);
        return false;
    }
}

/**
 * Скачивание бэкапа из облачного хранилища
 * @param {string} key - ключ в хранилище
 * @param {string} destPath - путь для сохранения
 * @returns {Promise<boolean>} - результат скачивания
 */
async function downloadFromS3(key, destPath) {
    if (!s3Client) return false;
    
    try {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const command = new GetObjectCommand({
            Bucket: BACKUP_CONFIG.s3.bucket,
            Key: key
        });
        
        const response = await s3Client.send(command);
        const fileStream = fs.createWriteStream(destPath);
        
        await new Promise((resolve, reject) => {
            response.Body.pipe(fileStream);
            response.Body.on('error', reject);
            fileStream.on('finish', resolve);
        });
        
        console.log(`📥 Бэкап скачан из S3: ${key}`);
        return true;
    } catch (error) {
        console.error('Ошибка скачивания из S3:', error);
        return false;
    }
}

// ============================================
// ОЧИСТКА СТАРЫХ БЭКАПОВ
// ============================================

/**
 * Очистка старых резервных копий
 * @param {string} type - тип бэкапа (database, uploads, logs, full)
 */
async function cleanupOldBackups(type) {
    const dir = BACKUP_CONFIG.paths[type] || BACKUP_CONFIG.paths.temp;
    const retentionDays = BACKUP_CONFIG.retention[type] || BACKUP_CONFIG.retention.full;
    
    if (!fs.existsSync(dir)) return;
    
    const files = fs.readdirSync(dir);
    const now = Date.now();
    const maxAge = retentionDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    
    for (const file of files) {
        const filepath = path.join(dir, file);
        const stats = fs.statSync(filepath);
        
        if (now - stats.mtimeMs > maxAge) {
            fs.unlinkSync(filepath);
            deletedCount++;
        }
    }
    
    console.log(`🧹 Очищено старых бэкапов (${type}): ${deletedCount}`);
}

// ============================================
= СПИСОК БЭКАПОВ
// ============================================

/**
 * Получение списка доступных бэкапов
 * @param {string} type - тип бэкапа (database, uploads, logs, full)
 * @returns {Promise<Array>} - список бэкапов
 */
async function listBackups(type = 'database') {
    const dir = BACKUP_CONFIG.paths[type] || BACKUP_CONFIG.paths.temp;
    
    if (!fs.existsSync(dir)) return [];
    
    const files = fs.readdirSync(dir);
    const backups = [];
    
    for (const file of files) {
        const filepath = path.join(dir, file);
        const stats = fs.statSync(filepath);
        
        backups.push({
            name: file,
            path: filepath,
            size: stats.size,
            sizeFormatted: formatBytes(stats.size),
            createdAt: stats.birthtime,
            modifiedAt: stats.mtime
        });
    }
    
    return backups.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

// ============================================
= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

/**
 * Получение временной метки для имени файла
 * @returns {string} - временная метка
 */
function getTimestamp() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * Форматирование размера в байтах
 * @param {number} bytes - размер в байтах
 * @returns {string} - отформатированный размер
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============================================
= ПЛАНИРОВЩИК
// ============================================

/**
 * Запуск планировщика резервного копирования
 */
function startBackupScheduler() {
    const cron = require('node-cron');
    
    // Ежедневный бэкап БД в 4:00
    cron.schedule(BACKUP_CONFIG.schedule.database, async () => {
        console.log('🕐 Запуск ежедневного бэкапа БД...');
        await backupDatabase();
    });
    
    // Еженедельный бэкап файлов в воскресенье в 5:00
    cron.schedule(BACKUP_CONFIG.schedule.uploads, async () => {
        console.log('🕐 Запуск еженедельного бэкапа файлов...');
        await backupUploads();
        await backupLogs();
    });
    
    // Еженедельный полный бэкап в понедельник в 3:00
    cron.schedule(BACKUP_CONFIG.schedule.full, async () => {
        console.log('🕐 Запуск полного бэкапа...');
        await fullBackup();
    });
    
    console.log('⏰ Планировщик резервного копирования запущен');
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    // Основные бэкапы
    backupDatabase,
    backupUploads,
    backupLogs,
    fullBackup,
    
    // Восстановление
    restoreDatabase,
    
    // Облачное хранилище
    uploadToS3,
    downloadFromS3,
    
    // Управление
    listBackups,
    cleanupOldBackups,
    
    // Планировщик
    startBackupScheduler,
    
    // Конфигурация
    BACKUP_CONFIG,
    getTimestamp,
    formatBytes
};