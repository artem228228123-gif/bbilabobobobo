/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/imageService.js
 * Описание: Обработка изображений (конвертация в WebP, создание миниатюр, оптимизация, водяные знаки)
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../../config/env');
const { addJob } = require('../../config/redis');

// ============================================
// КОНФИГУРАЦИЯ
// ============================================

const UPLOAD_DIR = process.env.UPLOAD_PATH || path.join(__dirname, '../../uploads');
const TEMP_DIR = path.join(__dirname, '../../temp');
const THUMBNAIL_SIZES = {
    tiny: 100,     // 100x100 для аватаров
    small: 300,    // 300x300 для миниатюр в ленте
    medium: 600,   // 600x600 для карточек
    large: 1200,   // 1200x1200 для просмотра
    original: null // оригинальный размер (не ресайзим)
};

const IMAGE_QUALITY = {
    high: 90,
    medium: 80,
    low: 70,
    thumbnail: 65
};

// Создаём необходимые папки
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

// Генерация уникального имени файла
function generateUniqueFilename(originalName, size = null) {
    const hash = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const ext = 'webp';
    const sizeSuffix = size ? `_${size}` : '';
    return `${timestamp}_${hash}${sizeSuffix}.${ext}`;
}

// Определение MIME типа
function getMimeType(buffer) {
    const signatures = {
        'ffd8ffe0': 'image/jpeg',
        'ffd8ffe1': 'image/jpeg',
        'ffd8ffe2': 'image/jpeg',
        '89504e47': 'image/png',
        '47494638': 'image/gif',
        '52494646': 'image/webp',
    };
    
    const hex = buffer.toString('hex', 0, 4);
    return signatures[hex] || 'image/webp';
}

// Проверка размера файла
function isWithinSizeLimit(buffer, maxSizeMB = 10) {
    const sizeMB = buffer.length / (1024 * 1024);
    return sizeMB <= maxSizeMB;
}

// ============================================
// ОСНОВНАЯ ОБРАБОТКА ИЗОБРАЖЕНИЯ
// ============================================

/**
 * Обработка одного изображения: конвертация в WebP, ресайз, оптимизация
 * @param {Buffer} inputBuffer - исходный буфер изображения
 * @param {Object} options - настройки обработки
 * @returns {Promise<Object>} - объект с обработанными данными
 */
async function processImage(inputBuffer, options = {}) {
    const {
        width = null,           // целевая ширина (null = пропорционально)
        height = null,          // целевая высота (null = пропорционально)
        fit = 'inside',         // cover, contain, fill, inside, outside
        quality = IMAGE_QUALITY.medium,
        generateThumbnails = false,
        addWatermark = false,
        watermarkText = '© AIDA',
        rotate = 0,
        blur = 0,
        sharpen = false,
        normalize = false
    } = options;
    
    try {
        let pipeline = sharp(inputBuffer);
        
        // Получаем метаданные
        const metadata = await pipeline.metadata();
        
        // Автоматическое определение ориентации (EXIF)
        pipeline = pipeline.rotate();
        
        // Ручной поворот
        if (rotate !== 0) {
            pipeline = pipeline.rotate(rotate);
        }
        
        // Ресайз
        if (width || height) {
            pipeline = pipeline.resize(width, height, {
                fit: fit,
                withoutEnlargement: true,
                kernel: sharp.kernel.lanczos3
            });
        }
        
        // Нормализация цветов
        if (normalize) {
            pipeline = pipeline.normalize();
        }
        
        // Размытие
        if (blur > 0) {
            pipeline = pipeline.blur(blur);
        }
        
        // Увеличение резкости
        if (sharpen) {
            pipeline = pipeline.sharpen({
                sigma: 1.2,
                m1: 1.0,
                m2: 2.0,
                x1: 2.0,
                y2: 10.0,
                y3: 20.0
            });
        }
        
        // Водяной знак
        if (addWatermark) {
            // Создаём SVG с текстом
            const svgWatermark = `
                <svg width="${metadata.width || 800}" height="${metadata.height || 600}">
                    <text x="50%" y="50%" 
                          font-family="Arial" 
                          font-size="24" 
                          fill="rgba(255,255,255,0.3)" 
                          text-anchor="middle" 
                          dominant-baseline="middle"
                          transform="rotate(-30, ${(metadata.width || 800) / 2}, ${(metadata.height || 600) / 2})">
                        ${watermarkText}
                    </text>
                </svg>
            `;
            
            const watermarkBuffer = Buffer.from(svgWatermark);
            const watermarkImage = await sharp(watermarkBuffer).resize(metadata.width, metadata.height).toBuffer();
            
            pipeline = pipeline.composite([{
                input: watermarkImage,
                blend: 'over',
                gravity: 'center'
            }]);
        }
        
        // Конвертация в WebP
        pipeline = pipeline.webp({
            quality: quality,
            effort: 6,           // 0-6, больше = лучше качество, но дольше
            lossless: false,
            nearLossless: false,
            smartSubsample: true,
            alphaQuality: 80
        });
        
        // Получаем результат
        const outputBuffer = await pipeline.toBuffer();
        const outputMetadata = await sharp(outputBuffer).metadata();
        
        return {
            buffer: outputBuffer,
            width: outputMetadata.width,
            height: outputMetadata.height,
            size: outputBuffer.length,
            format: 'webp',
            originalSize: inputBuffer.length,
            compressionRatio: ((1 - outputBuffer.length / inputBuffer.length) * 100).toFixed(1)
        };
        
    } catch (error) {
        console.error('Ошибка обработки изображения:', error);
        throw new Error(`Не удалось обработать изображение: ${error.message}`);
    }
}

// ============================================
// СОЗДАНИЕ МИНИАТЮР
// ============================================

/**
 * Создание нескольких миниатюр разных размеров
 * @param {Buffer} inputBuffer - исходное изображение
 * @param {string} baseFilename - базовое имя файла
 * @param {string} subfolder - подпапка для сохранения
 * @returns {Promise<Object>} - объект с путями к миниатюрам
 */
async function generateAllThumbnails(inputBuffer, baseFilename, subfolder = 'listings') {
    const results = {
        original: null,
        tiny: null,
        small: null,
        medium: null,
        large: null
    };
    
    const folderPath = path.join(UPLOAD_DIR, subfolder);
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
    
    // Обрабатываем каждый размер
    for (const [sizeName, sizeValue] of Object.entries(THUMBNAIL_SIZES)) {
        if (sizeValue === null) {
            // Оригинал (без ресайза, только конвертация)
            const processed = await processImage(inputBuffer, {
                quality: IMAGE_QUALITY.high
            });
            const filename = generateUniqueFilename(baseFilename, sizeName);
            const filepath = path.join(folderPath, filename);
            fs.writeFileSync(filepath, processed.buffer);
            results[sizeName] = `/${subfolder}/${filename}`;
        } else {
            // Миниатюра
            const processed = await processImage(inputBuffer, {
                width: sizeValue,
                height: sizeValue,
                fit: 'cover',
                quality: IMAGE_QUALITY.thumbnail
            });
            const filename = generateUniqueFilename(baseFilename, sizeName);
            const filepath = path.join(folderPath, filename);
            fs.writeFileSync(filepath, processed.buffer);
            results[sizeName] = `/${subfolder}/${filename}`;
        }
    }
    
    return results;
}

// ============================================
// ОБРАБОТКА АВАТАРА
// ============================================

/**
 * Обработка аватара пользователя (круглая обрезка)
 * @param {Buffer} inputBuffer - исходное изображение
 * @param {number} userId - ID пользователя
 * @returns {Promise<string>} - путь к сохранённому аватару
 */
async function processAvatar(inputBuffer, userId) {
    const folderPath = path.join(UPLOAD_DIR, 'avatars');
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
    
    // Обрезаем до квадрата 300x300 и делаем круг
    const processed = await sharp(inputBuffer)
        .resize(300, 300, {
            fit: 'cover',
            position: 'centre'
        })
        .composite([{
            input: Buffer.from(
                `<svg><circle cx="150" cy="150" r="150" /></svg>`
            ),
            blend: 'dest-in'
        }])
        .webp({ quality: 85 })
        .toBuffer();
    
    const filename = `avatar_${userId}_${Date.now()}.webp`;
    const filepath = path.join(folderPath, filename);
    fs.writeFileSync(filepath, processed);
    
    return `/avatars/${filename}`;
}

// ============================================
// ПАКЕТНАЯ ОБРАБОТКА ФОТОГРАФИЙ
// ============================================

/**
 * Пакетная обработка нескольких изображений
 * @param {Array<Buffer>} images - массив буферов изображений
 * @param {Object} options - настройки обработки
 * @returns {Promise<Array<Object>>} - массив результатов
 */
async function processMultipleImages(images, options = {}) {
    const results = [];
    
    for (let i = 0; i < images.length; i++) {
        try {
            const result = await processImage(images[i], options);
            results.push({
                index: i,
                success: true,
                ...result
            });
        } catch (error) {
            results.push({
                index: i,
                success: false,
                error: error.message
            });
        }
    }
    
    return results;
}

// ============================================
// ОПТИМИЗАЦИЯ СУЩЕСТВУЮЩИХ ИЗОБРАЖЕНИЙ
// ============================================

/**
 * Оптимизация изображения по пути (перезапись)
 * @param {string} filepath - путь к файлу
 * @param {Object} options - настройки оптимизации
 * @returns {Promise<Object>} - результат оптимизации
 */
async function optimizeExistingImage(filepath, options = {}) {
    const {
        quality = IMAGE_QUALITY.medium,
        backup = true,
        removeMetadata = true
    } = options;
    
    try {
        // Читаем файл
        const inputBuffer = fs.readFileSync(filepath);
        const originalSize = inputBuffer.length;
        
        // Создаём бэкап
        if (backup) {
            const backupPath = `${filepath}.backup`;
            if (!fs.existsSync(backupPath)) {
                fs.writeFileSync(backupPath, inputBuffer);
            }
        }
        
        // Оптимизируем
        let pipeline = sharp(inputBuffer);
        
        if (removeMetadata) {
            pipeline = pipeline.withMetadata().rotate();
        }
        
        pipeline = pipeline.webp({ quality: quality });
        
        const outputBuffer = await pipeline.toBuffer();
        
        // Сохраняем
        fs.writeFileSync(filepath, outputBuffer);
        
        const newSize = outputBuffer.length;
        const savedPercent = ((1 - newSize / originalSize) * 100).toFixed(1);
        
        return {
            success: true,
            originalSize,
            newSize,
            savedPercent,
            filepath
        };
        
    } catch (error) {
        console.error('Ошибка оптимизации:', error);
        return {
            success: false,
            error: error.message,
            filepath
        };
    }
}

// ============================================
// ПРОВЕРКА КАЧЕСТВА ИЗОБРАЖЕНИЯ
// ============================================

/**
 * Проверка качества изображения (размытие, шумы, яркость)
 * @param {Buffer} inputBuffer - буфер изображения
 * @returns {Promise<Object>} - оценка качества
 */
async function analyzeImageQuality(inputBuffer) {
    try {
        const pipeline = sharp(inputBuffer);
        const metadata = await pipeline.metadata();
        
        // Проверяем минимальные требования
        const checks = {
            minWidth: metadata.width >= 300,
            minHeight: metadata.height >= 300,
            minResolution: (metadata.width * metadata.height) >= 90000, // 300x300
            isWebP: metadata.format === 'webp',
            hasAlpha: metadata.hasAlpha || false
        };
        
        // Оценка качества (0-100)
        let qualityScore = 70; // базовая оценка
        
        if (metadata.width >= 1200) qualityScore += 10;
        if (metadata.height >= 1200) qualityScore += 10;
        if (metadata.format === 'webp') qualityScore += 5;
        if (!metadata.hasAlpha) qualityScore += 5;
        if (metadata.width / metadata.height > 2) qualityScore -= 10; // слишком вытянуто
        
        qualityScore = Math.min(100, Math.max(0, qualityScore));
        
        const isAcceptable = checks.minWidth && checks.minHeight && qualityScore >= 50;
        
        return {
            acceptable: isAcceptable,
            qualityScore,
            checks,
            metadata: {
                width: metadata.width,
                height: metadata.height,
                format: metadata.format,
                size: inputBuffer.length,
                hasAlpha: metadata.hasAlpha
            },
            suggestions: []
        };
        
    } catch (error) {
        return {
            acceptable: false,
            qualityScore: 0,
            error: error.message
        };
    }
}

// ============================================
// ОЧИСТКА ВРЕМЕННЫХ ФАЙЛОВ
// ============================================

/**
 * Очистка временных файлов старше N часов
 * @param {number} hours - возраст в часах
 * @returns {Promise<number>} - количество удалённых файлов
 */
async function cleanupTempFiles(hours = 24) {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    const maxAge = hours * 60 * 60 * 1000;
    let deleted = 0;
    
    for (const file of files) {
        const filepath = path.join(TEMP_DIR, file);
        const stats = fs.statSync(filepath);
        
        if (now - stats.mtimeMs > maxAge) {
            fs.unlinkSync(filepath);
            deleted++;
        }
    }
    
    console.log(`🧹 Очищено временных файлов: ${deleted}`);
    return deleted;
}

// ============================================
// КОНВЕРТАЦИЯ В РАЗНЫЕ ФОРМАТЫ
// ============================================

/**
 * Конвертация изображения в указанный формат
 * @param {Buffer} inputBuffer - исходное изображение
 * @param {string} format - целевой формат (jpeg, png, webp, avif)
 * @param {number} quality - качество (1-100)
 * @returns {Promise<Buffer>} - сконвертированный буфер
 */
async function convertFormat(inputBuffer, format = 'webp', quality = 80) {
    let pipeline = sharp(inputBuffer);
    
    switch (format) {
        case 'jpeg':
        case 'jpg':
            pipeline = pipeline.jpeg({ quality, progressive: true });
            break;
        case 'png':
            pipeline = pipeline.png({ quality, compressionLevel: 9 });
            break;
        case 'webp':
            pipeline = pipeline.webp({ quality, effort: 6 });
            break;
        case 'avif':
            pipeline = pipeline.avif({ quality, effort: 9 });
            break;
        default:
            pipeline = pipeline.webp({ quality });
    }
    
    return await pipeline.toBuffer();
}

// ============================================
// НАЛОЖЕНИЕ ТЕКСТА НА ИЗОБРАЖЕНИЕ
// ============================================

/**
 * Наложение текста на изображение
 * @param {Buffer} inputBuffer - исходное изображение
 * @param {string} text - текст для наложения
 * @param {Object} options - настройки
 * @returns {Promise<Buffer>} - изображение с текстом
 */
async function addTextOverlay(inputBuffer, text, options = {}) {
    const {
        fontSize = 24,
        fontFamily = 'Arial',
        color = '#ffffff',
        backgroundColor = 'rgba(0,0,0,0.5)',
        position = 'bottom',
        padding = 10
    } = options;
    
    const metadata = await sharp(inputBuffer).metadata();
    
    // Позиционирование
    let x = metadata.width / 2;
    let y = metadata.height - 50;
    
    if (position === 'top') y = 50;
    if (position === 'center') y = metadata.height / 2;
    
    const svg = `
        <svg width="${metadata.width}" height="${metadata.height}">
            <rect x="0" y="${y - fontSize - padding}" 
                  width="${metadata.width}" 
                  height="${fontSize + padding * 2}"
                  fill="${backgroundColor}" />
            <text x="${x}" y="${y}" 
                  font-family="${fontFamily}" 
                  font-size="${fontSize}" 
                  fill="${color}" 
                  text-anchor="middle" 
                  dominant-baseline="middle">
                ${text}
            </text>
        </svg>
    `;
    
    const overlay = Buffer.from(svg);
    
    return await sharp(inputBuffer)
        .composite([{ input: overlay, blend: 'over' }])
        .toBuffer();
}

// ============================================
// СКЛЕЙКА ИЗОБРАЖЕНИЙ (ДЛЯ КОЛЛАЖЕЙ)
// ============================================

/**
 * Склейка нескольких изображений в одно (горизонтально или вертикально)
 * @param {Array<Buffer>} images - массив буферов изображений
 * @param {string} direction - 'horizontal' или 'vertical'
 * @returns {Promise<Buffer>} - склеенное изображение
 */
async function stitchImages(images, direction = 'horizontal') {
    const sharpImages = images.map(img => sharp(img));
    const metadata = await Promise.all(images.map(img => sharp(img).metadata()));
    
    let totalWidth = 0;
    let totalHeight = 0;
    
    if (direction === 'horizontal') {
        totalWidth = metadata.reduce((sum, m) => sum + m.width, 0);
        totalHeight = Math.max(...metadata.map(m => m.height));
    } else {
        totalWidth = Math.max(...metadata.map(m => m.width));
        totalHeight = metadata.reduce((sum, m) => sum + m.height, 0);
    }
    
    const composite = [];
    let offset = 0;
    
    for (let i = 0; i < images.length; i++) {
        const m = metadata[i];
        composite.push({
            input: await sharpImages[i].toBuffer(),
            left: direction === 'horizontal' ? offset : 0,
            top: direction === 'vertical' ? offset : 0
        });
        
        offset += direction === 'horizontal' ? m.width : m.height;
    }
    
    return await sharp({
        create: {
            width: totalWidth,
            height: totalHeight,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
    })
        .composite(composite)
        .webp()
        .toBuffer();
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    // Основные
    processImage,
    processMultipleImages,
    
    // Миниатюры
    generateAllThumbnails,
    
    // Аватары
    processAvatar,
    
    // Оптимизация
    optimizeExistingImage,
    analyzeImageQuality,
    
    // Конвертация
    convertFormat,
    
    // Дополнительные эффекты
    addTextOverlay,
    stitchImages,
    
    // Утилиты
    cleanupTempFiles,
    generateUniqueFilename,
    isWithinSizeLimit,
    getMimeType,
    
    // Константы
    THUMBNAIL_SIZES,
    IMAGE_QUALITY
};