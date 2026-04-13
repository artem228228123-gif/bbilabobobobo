/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/videoService.js
 * Описание: Обработка видео (транскодинг в HLS, создание превью, оптимизация)
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const axios = require('axios');

const execAsync = promisify(exec);
const { config } = require('../../config/env');
const { addJob } = require('../../config/redis');

// ============================================
// КОНФИГУРАЦИЯ
// ============================================

const UPLOAD_DIR = process.env.UPLOAD_PATH || path.join(__dirname, '../../uploads');
const TEMP_DIR = path.join(__dirname, '../../temp');
const HLS_DIR = path.join(UPLOAD_DIR, 'hls');
const THUMBNAIL_DIR = path.join(UPLOAD_DIR, 'thumbnails');

// Создаём необходимые папки
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });
if (!fs.existsSync(THUMBNAIL_DIR)) fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });

// Разрешения для видео (HLS)
const VIDEO_RESOLUTIONS = [
    { name: '1080p', width: 1920, height: 1080, bitrate: '4000k', maxrate: '5000k', bufsize: '8000k' },
    { name: '720p', width: 1280, height: 720, bitrate: '2500k', maxrate: '3000k', bufsize: '5000k' },
    { name: '480p', width: 854, height: 480, bitrate: '1500k', maxrate: '2000k', bufsize: '3000k' },
    { name: '360p', width: 640, height: 360, bitrate: '800k', maxrate: '1000k', bufsize: '2000k' }
];

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function generateVideoId() {
    return crypto.randomBytes(16).toString('hex');
}

function getVideoDuration(filePath) {
    return new Promise((resolve, reject) => {
        const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
        
        exec(command, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                resolve(parseFloat(stdout.trim()));
            }
        });
    });
}

function getVideoInfo(filePath) {
    return new Promise((resolve, reject) => {
        const command = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name,bit_rate -of json "${filePath}"`;
        
        exec(command, async (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                const info = JSON.parse(stdout);
                const stream = info.streams?.[0] || {};
                const duration = await getVideoDuration(filePath);
                
                resolve({
                    width: stream.width || 0,
                    height: stream.height || 0,
                    codec: stream.codec_name || 'unknown',
                    bitrate: stream.bit_rate ? parseInt(stream.bit_rate) : 0,
                    duration
                });
            }
        });
    });
}

// ============================================
// ОСНОВНАЯ ОБРАБОТКА ВИДЕО (HLS ТРАНСКОДИНГ)
// ============================================

/**
 * Транскодинг видео в HLS формат для стриминга
 * @param {string} inputPath - путь к исходному видео
 * @param {string} videoId - ID видео
 * @returns {Promise<Object>} - информация о HLS плейлистах
 */
async function transcodeToHLS(inputPath, videoId) {
    const outputDir = path.join(HLS_DIR, videoId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    
    const masterPlaylist = path.join(outputDir, 'master.m3u8');
    let playlistContent = '#EXTM3U\n#EXT-X-VERSION:3\n';
    
    const variantStreams = [];
    
    for (const resolution of VIDEO_RESOLUTIONS) {
        const resolutionDir = path.join(outputDir, resolution.name);
        if (!fs.existsSync(resolutionDir)) fs.mkdirSync(resolutionDir, { recursive: true });
        
        const playlistPath = path.join(resolutionDir, 'playlist.m3u8');
        const segmentPattern = path.join(resolutionDir, 'segment_%03d.ts');
        
        // FFmpeg команда для создания HLS
        const command = `ffmpeg -i "${inputPath}" \
            -vf scale=${resolution.width}:${resolution.height} \
            -c:v libx264 -preset medium -crf 23 -maxrate ${resolution.maxrate} -bufsize ${resolution.bufsize} \
            -c:a aac -b:a 128k \
            -hls_time 6 \
            -hls_list_size 0 \
            -hls_segment_filename "${segmentPattern}" \
            -f hls \
            "${playlistPath}"`;
        
        try {
            await execAsync(command);
            
            // Добавляем в мастер-плейлист
            playlistContent += `#EXT-X-STREAM-INF:BANDWIDTH=${parseInt(resolution.bitrate) * 1000},RESOLUTION=${resolution.width}x${resolution.height}\n`;
            playlistContent += `${resolution.name}/playlist.m3u8\n`;
            
            variantStreams.push({
                resolution: resolution.name,
                width: resolution.width,
                height: resolution.height,
                playlist: `/${videoId}/${resolution.name}/playlist.m3u8`
            });
        } catch (error) {
            console.error(`Ошибка транскодинга для ${resolution.name}:`, error);
        }
    }
    
    // Сохраняем мастер-плейлист
    fs.writeFileSync(masterPlaylist, playlistContent);
    
    return {
        videoId,
        masterPlaylist: `/${videoId}/master.m3u8`,
        variants: variantStreams,
        duration: await getVideoDuration(inputPath)
    };
}

// ============================================
// СОЗДАНИЕ ПРЕВЬЮ (ТУМБНЕЙЛОВ)
// ============================================

/**
 * Создание превью видео (один кадр)
 * @param {string} inputPath - путь к видео
 * @param {string} videoId - ID видео
 * @param {number} timestamp - временная метка в секундах
 * @returns {Promise<string>} - путь к превью
 */
async function generateThumbnail(inputPath, videoId, timestamp = 1) {
    const thumbnailPath = path.join(THUMBNAIL_DIR, `${videoId}.jpg`);
    
    const command = `ffmpeg -ss ${timestamp} -i "${inputPath}" -vframes 1 -vf "scale=640:-1" -q:v 2 "${thumbnailPath}"`;
    
    try {
        await execAsync(command);
        return `/thumbnails/${videoId}.jpg`;
    } catch (error) {
        console.error('Ошибка создания превью:', error);
        throw error;
    }
}

/**
 * Создание нескольких превью для видео (сетка)
 * @param {string} inputPath - путь к видео
 * @param {string} videoId - ID видео
 * @param {number} count - количество превью
 * @returns {Promise<Array>} - массив путей к превью
 */
async function generateMultipleThumbnails(inputPath, videoId, count = 4) {
    const duration = await getVideoDuration(inputPath);
    const interval = duration / (count + 1);
    const thumbnails = [];
    
    for (let i = 1; i <= count; i++) {
        const timestamp = interval * i;
        const thumbnailPath = path.join(THUMBNAIL_DIR, `${videoId}_${i}.jpg`);
        
        const command = `ffmpeg -ss ${timestamp} -i "${inputPath}" -vframes 1 -vf "scale=320:-1" -q:v 2 "${thumbnailPath}"`;
        
        try {
            await execAsync(command);
            thumbnails.push(`/thumbnails/${videoId}_${i}.jpg`);
        } catch (error) {
            console.error(`Ошибка создания превью ${i}:`, error);
        }
    }
    
    return thumbnails;
}

// ============================================
// ОПТИМИЗАЦИЯ ВИДЕО
// ============================================

/**
 * Оптимизация видео (сжатие, изменение разрешения)
 * @param {string} inputPath - путь к исходному видео
 * @param {string} outputPath - путь для сохранения
 * @param {Object} options - настройки оптимизации
 * @returns {Promise<string>} - путь к оптимизированному видео
 */
async function optimizeVideo(inputPath, outputPath, options = {}) {
    const {
        width = 1280,
        height = 720,
        crf = 23,
        preset = 'medium',
        audioBitrate = '128k'
    } = options;
    
    const command = `ffmpeg -i "${inputPath}" \
        -vf scale=${width}:${height} \
        -c:v libx264 -preset ${preset} -crf ${crf} \
        -c:a aac -b:a ${audioBitrate} \
        "${outputPath}"`;
    
    try {
        await execAsync(command);
        return outputPath;
    } catch (error) {
        console.error('Ошибка оптимизации видео:', error);
        throw error;
    }
}

// ============================================
// КОНВЕРТАЦИЯ ФОРМАТА
// ============================================

/**
 * Конвертация видео в MP4 формат
 * @param {string} inputPath - путь к исходному видео
 * @param {string} outputPath - путь для сохранения
 * @returns {Promise<string>} - путь к сконвертированному видео
 */
async function convertToMP4(inputPath, outputPath) {
    const command = `ffmpeg -i "${inputPath}" -c:v libx264 -preset medium -crf 23 -c:a aac "${outputPath}"`;
    
    try {
        await execAsync(command);
        return outputPath;
    } catch (error) {
        console.error('Ошибка конвертации в MP4:', error);
        throw error;
    }
}

// ============================================
// ОБРЕЗКА ВИДЕО
// ============================================

/**
 * Обрезка видео
 * @param {string} inputPath - путь к исходному видео
 * @param {string} outputPath - путь для сохранения
 * @param {number} startTime - время начала в секундах
 * @param {number} duration - длительность в секундах
 * @returns {Promise<string>} - путь к обрезанному видео
 */
async function trimVideo(inputPath, outputPath, startTime, duration) {
    const command = `ffmpeg -ss ${startTime} -i "${inputPath}" -t ${duration} -c copy "${outputPath}"`;
    
    try {
        await execAsync(command);
        return outputPath;
    } catch (error) {
        console.error('Ошибка обрезки видео:', error);
        throw error;
    }
}

// ============================================
// ПОЛНАЯ ОБРАБОТКА ВИДЕО ДЛЯ ОБЪЯВЛЕНИЯ
// ============================================

/**
 * Полная обработка видео для объявления
 * @param {string} tempPath - путь к временному файлу
 * @param {Object} options - настройки обработки
 * @returns {Promise<Object>} - информация о обработанном видео
 */
async function processVideo(tempPath, options = {}) {
    const {
        generateHLS = true,
        generateThumbnails = true,
        thumbnailCount = 4,
        listingId = null
    } = options;
    
    const videoId = generateVideoId();
    const videoInfo = await getVideoInfo(tempPath);
    
    // Проверяем длительность (максимум 5 минут)
    if (videoInfo.duration > 300) {
        throw new Error('Видео не должно превышать 5 минут');
    }
    
    // Проверяем размер
    const stats = fs.statSync(tempPath);
    if (stats.size > 100 * 1024 * 1024) {
        throw new Error('Видео не должно превышать 100MB');
    }
    
    const result = {
        videoId,
        duration: videoInfo.duration,
        width: videoInfo.width,
        height: videoInfo.height,
        originalSize: stats.size
    };
    
    // Создаём превью
    if (generateThumbnails) {
        const thumbnails = await generateMultipleThumbnails(tempPath, videoId, thumbnailCount);
        result.thumbnails = thumbnails;
        result.thumbnail = thumbnails[0];
    }
    
    // Транскодинг в HLS
    if (generateHLS) {
        const hlsInfo = await transcodeToHLS(tempPath, videoId);
        result.hls = hlsInfo;
        result.streamUrl = `/api/v1/videos/stream/${videoId}/master.m3u8`;
    }
    
    // Удаляем временный файл
    if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
    }
    
    // Сохраняем информацию в БД (в фоне)
    if (listingId) {
        await addJob('videoProcessing', 'saveVideoMetadata', {
            listingId,
            videoId,
            videoInfo: result
        });
    }
    
    return result;
}

// ============================================
// ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ВИДЕО
// ============================================

/**
 * Получение информации о видео по ID
 * @param {string} videoId - ID видео
 * @returns {Promise<Object>} - информация о видео
 */
async function getVideoInfoById(videoId) {
    const videoDir = path.join(HLS_DIR, videoId);
    const masterPlaylist = path.join(videoDir, 'master.m3u8');
    
    if (!fs.existsSync(masterPlaylist)) {
        return null;
    }
    
    // Получаем информацию из БД (в реальном проекте)
    return {
        videoId,
        masterPlaylist: `/${videoId}/master.m3u8`,
        exists: true
    };
}

// ============================================
// УДАЛЕНИЕ ВИДЕО
// ============================================

/**
 * Удаление видео и всех связанных файлов
 * @param {string} videoId - ID видео
 * @returns {Promise<boolean>} - результат удаления
 */
async function deleteVideo(videoId) {
    const videoDir = path.join(HLS_DIR, videoId);
    const thumbnails = [
        path.join(THUMBNAIL_DIR, `${videoId}.jpg`),
        ...Array.from({ length: 4 }, (_, i) => path.join(THUMBNAIL_DIR, `${videoId}_${i + 1}.jpg`))
    ];
    
    try {
        // Удаляем HLS файлы
        if (fs.existsSync(videoDir)) {
            fs.rmSync(videoDir, { recursive: true, force: true });
        }
        
        // Удаляем превью
        for (const thumbnail of thumbnails) {
            if (fs.existsSync(thumbnail)) {
                fs.unlinkSync(thumbnail);
            }
        }
        
        return true;
    } catch (error) {
        console.error('Ошибка удаления видео:', error);
        return false;
    }
}

// ============================================
// СТРИМИНГ ВИДЕО (HLS)
// ============================================

/**
 * Получение HLS плейлиста для стриминга
 * @param {string} videoId - ID видео
 * @param {string} quality - качество (1080p, 720p, 480p, 360p)
 * @returns {string} - путь к плейлисту
 */
function getStreamUrl(videoId, quality = null) {
    if (quality && VIDEO_RESOLUTIONS.find(r => r.name === quality)) {
        return `/hls/${videoId}/${quality}/playlist.m3u8`;
    }
    return `/hls/${videoId}/master.m3u8`;
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    // Основные
    processVideo,
    transcodeToHLS,
    
    // Превью
    generateThumbnail,
    generateMultipleThumbnails,
    
    // Оптимизация
    optimizeVideo,
    convertToMP4,
    trimVideo,
    
    // Утилиты
    getVideoInfo,
    getVideoDuration,
    getVideoInfoById,
    deleteVideo,
    getStreamUrl,
    generateVideoId,
    
    // Константы
    VIDEO_RESOLUTIONS
};