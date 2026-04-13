/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/utils/validators.js
 * Описание: Валидация данных (email, телефон, пароль, цена, файлы, адреса)
 */

const validator = require('validator');

// ============================================
= ОСНОВНЫЕ ВАЛИДАТОРЫ
// ============================================

/**
 * Проверка email
 * @param {string} value - email
 * @returns {Object}
 */
function validateEmail(value) {
    if (!value) return { valid: false, message: 'Email обязателен' };
    if (!validator.isEmail(value)) {
        return { valid: false, message: 'Введите корректный email' };
    }
    if (value.length > 255) {
        return { valid: false, message: 'Email не должен превышать 255 символов' };
    }
    return { valid: true };
}

/**
 * Проверка пароля
 * @param {string} value - пароль
 * @param {Object} options - настройки
 * @returns {Object}
 */
function validatePassword(value, options = {}) {
    const { minLength = 6, maxLength = 100, requireNumbers = true, requireLetters = true } = options;
    
    if (!value) return { valid: false, message: 'Пароль обязателен' };
    if (value.length < minLength) {
        return { valid: false, message: `Пароль должен содержать минимум ${minLength} символов` };
    }
    if (value.length > maxLength) {
        return { valid: false, message: `Пароль не должен превышать ${maxLength} символов` };
    }
    if (requireNumbers && !/\d/.test(value)) {
        return { valid: false, message: 'Пароль должен содержать хотя бы одну цифру' };
    }
    if (requireLetters && !/[a-zA-Zа-яА-Я]/.test(value)) {
        return { valid: false, message: 'Пароль должен содержать хотя бы одну букву' };
    }
    return { valid: true };
}

/**
 * Проверка совпадения паролей
 * @param {string} password - пароль
 * @param {string} confirmPassword - подтверждение
 * @returns {Object}
 */
function validatePasswordConfirm(password, confirmPassword) {
    if (password !== confirmPassword) {
        return { valid: false, message: 'Пароли не совпадают' };
    }
    return { valid: true };
}

/**
 * Проверка имени
 * @param {string} value - имя
 * @returns {Object}
 */
function validateName(value) {
    if (!value) return { valid: false, message: 'Имя обязательно' };
    if (value.length < 2) {
        return { valid: false, message: 'Имя должно содержать минимум 2 символа' };
    }
    if (value.length > 100) {
        return { valid: false, message: 'Имя не должно превышать 100 символов' };
    }
    if (/[<>{}[\]\\]/.test(value)) {
        return { valid: false, message: 'Имя содержит недопустимые символы' };
    }
    return { valid: true };
}

/**
 * Проверка телефона
 * @param {string} value - телефон
 * @param {boolean} required - обязателен ли
 * @returns {Object}
 */
function validatePhone(value, required = false) {
    if (!value && !required) return { valid: true };
    if (!value && required) return { valid: false, message: 'Телефон обязателен' };
    
    const cleaned = value.replace(/[^\d+]/g, '');
    const isValid = validator.isMobilePhone(cleaned, 'ru-RU') || /^\+?[0-9]{10,15}$/.test(cleaned);
    
    if (!isValid) {
        return { valid: false, message: 'Введите корректный номер телефона' };
    }
    return { valid: true };
}

/**
 * Проверка цены
 * @param {number} value - цена
 * @param {Object} options - настройки
 * @returns {Object}
 */
function validatePrice(value, options = {}) {
    const { min = 0, max = 1000000000, required = true } = options;
    
    if (value === undefined || value === null) {
        if (required) return { valid: false, message: 'Цена обязательна' };
        return { valid: true };
    }
    
    const num = Number(value);
    if (isNaN(num)) {
        return { valid: false, message: 'Цена должна быть числом' };
    }
    if (num < min) {
        return { valid: false, message: `Цена не может быть меньше ${min} ₽` };
    }
    if (num > max) {
        return { valid: false, message: `Цена не может быть больше ${max.toLocaleString()} ₽` };
    }
    if (!Number.isInteger(num)) {
        return { valid: false, message: 'Цена должна быть целым числом' };
    }
    return { valid: true };
}

/**
 * Проверка названия объявления
 * @param {string} value - название
 * @returns {Object}
 */
function validateTitle(value) {
    if (!value) return { valid: false, message: 'Название обязательно' };
    if (value.length < 5) {
        return { valid: false, message: 'Название должно содержать минимум 5 символов' };
    }
    if (value.length > 200) {
        return { valid: false, message: 'Название не должно превышать 200 символов' };
    }
    return { valid: true };
}

/**
 * Проверка описания
 * @param {string} value - описание
 * @param {boolean} required - обязательно ли
 * @returns {Object}
 */
function validateDescription(value, required = false) {
    if (!value && !required) return { valid: true };
    if (value && value.length > 5000) {
        return { valid: false, message: 'Описание не должно превышать 5000 символов' };
    }
    return { valid: true };
}

/**
 * Проверка города
 * @param {string} value - город
 * @param {boolean} required - обязателен ли
 * @returns {Object}
 */
function validateCity(value, required = false) {
    if (!value && !required) return { valid: true };
    if (!value && required) return { valid: false, message: 'Город обязателен' };
    if (value.length < 2) {
        return { valid: false, message: 'Название города должно содержать минимум 2 символа' };
    }
    if (value.length > 100) {
        return { valid: false, message: 'Название города не должно превышать 100 символов' };
    }
    return { valid: true };
}

/**
 * Проверка URL
 * @param {string} value - URL
 * @param {boolean} required - обязателен ли
 * @returns {Object}
 */
function validateUrl(value, required = false) {
    if (!value && !required) return { valid: true };
    if (!value && required) return { valid: false, message: 'URL обязателен' };
    
    if (!validator.isURL(value)) {
        return { valid: false, message: 'Введите корректный URL' };
    }
    return { valid: true };
}

/**
 * Проверка числа
 * @param {number} value - число
 * @param {Object} options - настройки
 * @returns {Object}
 */
function validateNumber(value, options = {}) {
    const { min = null, max = null, integer = true, required = true } = options;
    
    if (value === undefined || value === null) {
        if (required) return { valid: false, message: 'Поле обязательно' };
        return { valid: true };
    }
    
    const num = Number(value);
    if (isNaN(num)) {
        return { valid: false, message: 'Введите число' };
    }
    if (integer && !Number.isInteger(num)) {
        return { valid: false, message: 'Введите целое число' };
    }
    if (min !== null && num < min) {
        return { valid: false, message: `Значение должно быть не меньше ${min}` };
    }
    if (max !== null && num > max) {
        return { valid: false, message: `Значение должно быть не больше ${max}` };
    }
    return { valid: true };
}

/**
 * Проверка даты
 * @param {string} value - дата
 * @param {boolean} required - обязательна ли
 * @returns {Object}
 */
function validateDate(value, required = false) {
    if (!value && !required) return { valid: true };
    if (!value && required) return { valid: false, message: 'Дата обязательна' };
    
    const date = new Date(value);
    if (isNaN(date.getTime())) {
        return { valid: false, message: 'Введите корректную дату' };
    }
    return { valid: true };
}

/**
 * Проверка возраста (18+)
 * @param {string} birthDate - дата рождения
 * @returns {Object}
 */
function validateAge(birthDate) {
    if (!birthDate) return { valid: false, message: 'Дата рождения обязательна' };
    
    const date = new Date(birthDate);
    if (isNaN(date.getTime())) {
        return { valid: false, message: 'Введите корректную дату рождения' };
    }
    
    const today = new Date();
    let age = today.getFullYear() - date.getFullYear();
    const monthDiff = today.getMonth() - date.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < date.getDate())) {
        age--;
    }
    
    if (age < 18) {
        return { valid: false, message: 'Вам должно быть 18 лет или больше' };
    }
    return { valid: true };
}

/**
 * Проверка файла
 * @param {Object} file - файл
 * @param {Object} options - настройки
 * @returns {Object}
 */
function validateFile(file, options = {}) {
    const { maxSize = 10 * 1024 * 1024, allowedTypes = null, required = false } = options;
    
    if (!file && !required) return { valid: true };
    if (!file && required) return { valid: false, message: 'Файл обязателен' };
    
    if (file.size > maxSize) {
        return { valid: false, message: `Файл не должен превышать ${maxSize / 1024 / 1024}MB` };
    }
    
    if (allowedTypes && !allowedTypes.includes(file.mimetype)) {
        return { valid: false, message: `Поддерживаемые форматы: ${allowedTypes.join(', ')}` };
    }
    
    return { valid: true };
}

/**
 * Проверка нескольких файлов
 * @param {Array} files - массив файлов
 * @param {Object} options - настройки
 * @returns {Object}
 */
function validateFiles(files, options = {}) {
    const { maxFiles = 10, maxSize = 10 * 1024 * 1024, allowedTypes = null, required = false } = options;
    
    if ((!files || files.length === 0) && !required) return { valid: true };
    if ((!files || files.length === 0) && required) return { valid: false, message: 'Загрузите хотя бы один файл' };
    
    if (files.length > maxFiles) {
        return { valid: false, message: `Можно загрузить не более ${maxFiles} файлов` };
    }
    
    for (const file of files) {
        if (file.size > maxSize) {
            return { valid: false, message: `Файл ${file.name} превышает ${maxSize / 1024 / 1024}MB` };
        }
        if (allowedTypes && !allowedTypes.includes(file.mimetype)) {
            return { valid: false, message: `Файл ${file.name} имеет неподдерживаемый формат` };
        }
    }
    
    return { valid: true };
}

/**
 * Проверка координат
 * @param {number} lat - широта
 * @param {number} lng - долгота
 * @returns {Object}
 */
function validateCoordinates(lat, lng) {
    if (!lat && !lng) return { valid: true };
    
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    
    if (isNaN(latNum) || isNaN(lngNum)) {
        return { valid: false, message: 'Неверные координаты' };
    }
    
    if (latNum < -90 || latNum > 90) {
        return { valid: false, message: 'Широта должна быть от -90 до 90' };
    }
    
    if (lngNum < -180 || lngNum > 180) {
        return { valid: false, message: 'Долгота должна быть от -180 до 180' };
    }
    
    return { valid: true };
}

/**
 * Проверка VIN номера
 * @param {string} value - VIN
 * @param {boolean} required - обязателен ли
 * @returns {Object}
 */
function validateVIN(value, required = false) {
    if (!value && !required) return { valid: true };
    if (!value && required) return { valid: false, message: 'VIN номер обязателен' };
    
    const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/i;
    if (!vinRegex.test(value)) {
        return { valid: false, message: 'VIN должен содержать 17 символов (цифры и латинские буквы, кроме I, O, Q)' };
    }
    return { valid: true };
}

/**
 * Проверка почтового индекса
 * @param {string} value - индекс
 * @param {boolean} required - обязателен ли
 * @returns {Object}
 */
function validatePostalCode(value, required = false) {
    if (!value && !required) return { valid: true };
    if (!value && required) return { valid: false, message: 'Почтовый индекс обязателен' };
    
    const postalRegex = /^\d{6}$/;
    if (!postalRegex.test(value)) {
        return { valid: false, message: 'Введите корректный почтовый индекс (6 цифр)' };
    }
    return { valid: true };
}

/**
 * Проверка ИНН
 * @param {string} value - ИНН
 * @param {boolean} required - обязателен ли
 * @returns {Object}
 */
function validateINN(value, required = false) {
    if (!value && !required) return { valid: true };
    if (!value && required) return { valid: false, message: 'ИНН обязателен' };
    
    const innRegex = /^\d{10}$|^\d{12}$/;
    if (!innRegex.test(value)) {
        return { valid: false, message: 'ИНН должен содержать 10 или 12 цифр' };
    }
    return { valid: true };
}

/**
 * Проверка ОГРН
 * @param {string} value - ОГРН
 * @param {boolean} required - обязателен ли
 * @returns {Object}
 */
function validateOGRN(value, required = false) {
    if (!value && !required) return { valid: true };
    if (!value && required) return { valid: false, message: 'ОГРН обязателен' };
    
    const ogrnRegex = /^\d{13}$|^\d{15}$/;
    if (!ogrnRegex.test(value)) {
        return { valid: false, message: 'ОГРН должен содержать 13 или 15 цифр' };
    }
    return { valid: true };
}

/**
 * Проверка ссылки на соцсеть
 * @param {string} value - ссылка
 * @param {string} platform - платформа
 * @returns {Object}
 */
function validateSocialLink(value, platform) {
    if (!value) return { valid: true };
    
    const patterns = {
        telegram: /^(https?:\/\/)?(t\.me|telegram\.me)\/[a-zA-Z0-9_]+$/,
        vk: /^(https?:\/\/)?(vk\.com|vkontakte\.ru)\/([a-zA-Z0-9_]+|id\d+)$/,
        instagram: /^(https?:\/\/)?(www\.)?instagram\.com\/[a-zA-Z0-9_.]+$/,
        youtube: /^(https?:\/\/)?(www\.)?(youtube\.com\/@|youtu\.be\/)[a-zA-Z0-9_-]+$/,
        whatsapp: /^(https?:\/\/)?(wa\.me|api\.whatsapp\.com)\/.+$/
    };
    
    const pattern = patterns[platform];
    if (pattern && !pattern.test(value)) {
        return { valid: false, message: `Введите корректную ссылку на ${platform}` };
    }
    
    return { valid: true };
}

// ============================================
= ЭКСПОРТ
// ============================================

module.exports = {
    validateEmail,
    validatePassword,
    validatePasswordConfirm,
    validateName,
    validatePhone,
    validatePrice,
    validateTitle,
    validateDescription,
    validateCity,
    validateUrl,
    validateNumber,
    validateDate,
    validateAge,
    validateFile,
    validateFiles,
    validateCoordinates,
    validateVIN,
    validatePostalCode,
    validateINN,
    validateOGRN,
    validateSocialLink
};