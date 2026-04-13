/**
 * AIDA — Премиальная доска объявлений
 * Версия: 3.0 ULTRA
 * Файл: server/services/exportService.js
 * Описание: Сервис экспорта данных (CSV, JSON, Excel, PDF)
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { get, set, del } = require('../../config/redis');
const { addJob } = require('../../config/redis');
const { User, Listing, Payment } = require('../models');

// ============================================
// КОНСТАНТЫ
// ============================================

const CACHE_TTL = {
    export: 3600        // 1 час
};

const EXPORT_DIR = path.join(__dirname, '../../exports');

// Создаём папку для экспорта
if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

const EXPORT_FORMATS = {
    CSV: 'csv',
    JSON: 'json',
    EXCEL: 'xlsx',
    PDF: 'pdf'
};

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function generateExportFilename(type, format, userId) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${type}_${userId}_${timestamp}.${format}`;
}

function getExportPath(filename) {
    return path.join(EXPORT_DIR, filename);
}

async function saveExportRecord(userId, filename, type, format, recordCount) {
    const result = await User.query(
        `INSERT INTO export_history (user_id, filename, type, format, record_count, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + INTERVAL '7 days')
         RETURNING id`,
        [userId, filename, type, format, recordCount]
    );
    
    return result.rows[0].id;
}

// ============================================
// ЭКСПОРТ В CSV
// ============================================

async function exportToCSV(data, headers, filename) {
    const filepath = getExportPath(filename);
    
    let csvContent = headers.map(h => `"${h}"`).join(',') + '\n';
    
    for (const row of data) {
        const values = headers.map(header => {
            let value = row[header];
            if (value === undefined || value === null) value = '';
            if (typeof value === 'string') value = `"${value.replace(/"/g, '""')}"`;
            return value;
        });
        csvContent += values.join(',') + '\n';
    }
    
    fs.writeFileSync(filepath, '\uFEFF' + csvContent, 'utf8');
    return filepath;
}

// ============================================
// ЭКСПОРТ В JSON
// ============================================

async function exportToJSON(data, filename) {
    const filepath = getExportPath(filename);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    return filepath;
}

// ============================================
// ЭКСПОРТ В EXCEL
// ============================================

async function exportToExcel(data, headers, sheetName, filename) {
    const filepath = getExportPath(filename);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(sheetName);
    
    // Добавляем заголовки
    worksheet.addRow(headers);
    
    // Стиль заголовков
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF10B981' }
    };
    
    // Добавляем данные
    for (const row of data) {
        const excelRow = headers.map(header => {
            let value = row[header];
            if (value === undefined || value === null) value = '';
            return value;
        });
        worksheet.addRow(excelRow);
    }
    
    // Авто-ширина колонок
    worksheet.columns.forEach(column => {
        let maxLength = 10;
        column.eachCell({ includeEmpty: true }, cell => {
            const cellLength = cell.value ? cell.value.toString().length : 10;
            maxLength = Math.max(maxLength, cellLength);
        });
        column.width = Math.min(maxLength + 2, 50);
    });
    
    await workbook.xlsx.writeFile(filepath);
    return filepath;
}

// ============================================
// ЭКСПОРТ В PDF
// ============================================

async function exportToPDF(data, headers, title, filename) {
    const filepath = getExportPath(filename);
    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    const stream = fs.createWriteStream(filepath);
    
    doc.pipe(stream);
    
    // Заголовок
    doc.fontSize(18).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).font('Helvetica');
    doc.text(`Дата экспорта: ${new Date().toLocaleString('ru-RU')}`, { align: 'right' });
    doc.moveDown();
    
    // Таблица
    const tableTop = doc.y + 20;
    const colWidths = headers.map(() => 80);
    const rowHeight = 25;
    
    // Рисуем заголовки
    let x = 30;
    doc.font('Helvetica-Bold').fontSize(9);
    headers.forEach((header, i) => {
        doc.text(header, x, tableTop, { width: colWidths[i], align: 'center' });
        x += colWidths[i];
    });
    
    // Рисуем линию под заголовками
    doc.moveTo(30, tableTop + 15).lineTo(30 + colWidths.reduce((a, b) => a + b, 0), tableTop + 15).stroke();
    
    // Рисуем данные
    doc.font('Helvetica').fontSize(8);
    let y = tableTop + 25;
    
    for (let i = 0; i < Math.min(data.length, 50); i++) {
        const row = data[i];
        x = 30;
        
        headers.forEach((header, j) => {
            let value = row[header];
            if (value === undefined || value === null) value = '';
            if (typeof value === 'string' && value.length > 20) {
                value = value.substring(0, 17) + '...';
            }
            doc.text(String(value), x, y, { width: colWidths[j], align: 'center' });
            x += colWidths[j];
        });
        
        y += rowHeight;
        
        if (y > doc.page.height - 50) {
            doc.addPage();
            y = 50;
        }
    }
    
    doc.end();
    
    return new Promise((resolve) => {
        stream.on('finish', () => resolve(filepath));
    });
}

// ============================================
// ЭКСПОРТ ПОЛЬЗОВАТЕЛЕЙ
// ============================================

async function exportUsers(userId, format, dateFrom, dateTo) {
    let sql = `
        SELECT id, name, email, phone, city, role, status, bonus_balance, 
               email_verified, created_at, last_seen
        FROM users
        WHERE deleted_at IS NULL
    `;
    const params = [];
    
    if (dateFrom) {
        sql += ` AND created_at >= $${params.length + 1}`;
        params.push(dateFrom);
    }
    if (dateTo) {
        sql += ` AND created_at <= $${params.length + 1}`;
        params.push(dateTo);
    }
    
    sql += ` ORDER BY created_at DESC`;
    
    const result = await User.query(sql, params);
    const data = result.rows;
    const headers = ['id', 'name', 'email', 'phone', 'city', 'role', 'status', 'bonus_balance', 'email_verified', 'created_at', 'last_seen'];
    const filename = generateExportFilename('users', format, userId);
    
    let filepath;
    switch (format) {
        case EXPORT_FORMATS.CSV:
            filepath = await exportToCSV(data, headers, filename);
            break;
        case EXPORT_FORMATS.JSON:
            filepath = await exportToJSON(data, filename);
            break;
        case EXPORT_FORMATS.EXCEL:
            filepath = await exportToExcel(data, headers, 'Пользователи', filename);
            break;
        case EXPORT_FORMATS.PDF:
            filepath = await exportToPDF(data, headers, 'Экспорт пользователей', filename);
            break;
        default:
            throw new Error(`Unsupported format: ${format}`);
    }
    
    await saveExportRecord(userId, filename, 'users', format, data.length);
    return { filepath, filename, count: data.length };
}

// ============================================
// ЭКСПОРТ ОБЪЯВЛЕНИЙ
// ============================================

async function exportListings(userId, format, dateFrom, dateTo, status) {
    let sql = `
        SELECT l.id, l.title, l.description, l.price, l.city, l.status, 
               l.views, l.likes, l.created_at, u.name as user_name, u.email as user_email
        FROM listings l
        JOIN users u ON u.id = l.user_id
        WHERE l.deleted_at IS NULL
    `;
    const params = [];
    
    if (dateFrom) {
        sql += ` AND l.created_at >= $${params.length + 1}`;
        params.push(dateFrom);
    }
    if (dateTo) {
        sql += ` AND l.created_at <= $${params.length + 1}`;
        params.push(dateTo);
    }
    if (status) {
        sql += ` AND l.status = $${params.length + 1}`;
        params.push(status);
    }
    
    sql += ` ORDER BY l.created_at DESC`;
    
    const result = await Listing.query(sql, params);
    const data = result.rows;
    const headers = ['id', 'title', 'description', 'price', 'city', 'status', 'views', 'likes', 'user_name', 'user_email', 'created_at'];
    const filename = generateExportFilename('listings', format, userId);
    
    let filepath;
    switch (format) {
        case EXPORT_FORMATS.CSV:
            filepath = await exportToCSV(data, headers, filename);
            break;
        case EXPORT_FORMATS.JSON:
            filepath = await exportToJSON(data, filename);
            break;
        case EXPORT_FORMATS.EXCEL:
            filepath = await exportToExcel(data, headers, 'Объявления', filename);
            break;
        case EXPORT_FORMATS.PDF:
            filepath = await exportToPDF(data, headers, 'Экспорт объявлений', filename);
            break;
        default:
            throw new Error(`Unsupported format: ${format}`);
    }
    
    await saveExportRecord(userId, filename, 'listings', format, data.length);
    return { filepath, filename, count: data.length };
}

// ============================================
// ЭКСПОРТ ПЛАТЕЖЕЙ
// ============================================

async function exportPayments(userId, format, dateFrom, dateTo) {
    let sql = `
        SELECT id, user_id, amount, currency, type, status, description, created_at, completed_at
        FROM payments
        WHERE 1=1
    `;
    const params = [];
    
    if (dateFrom) {
        sql += ` AND created_at >= $${params.length + 1}`;
        params.push(dateFrom);
    }
    if (dateTo) {
        sql += ` AND created_at <= $${params.length + 1}`;
        params.push(dateTo);
    }
    
    sql += ` ORDER BY created_at DESC`;
    
    const result = await Payment.query(sql, params);
    const data = result.rows;
    const headers = ['id', 'user_id', 'amount', 'currency', 'type', 'status', 'description', 'created_at', 'completed_at'];
    const filename = generateExportFilename('payments', format, userId);
    
    let filepath;
    switch (format) {
        case EXPORT_FORMATS.CSV:
            filepath = await exportToCSV(data, headers, filename);
            break;
        case EXPORT_FORMATS.JSON:
            filepath = await exportToJSON(data, filename);
            break;
        case EXPORT_FORMATS.EXCEL:
            filepath = await exportToExcel(data, headers, 'Платежи', filename);
            break;
        case EXPORT_FORMATS.PDF:
            filepath = await exportToPDF(data, headers, 'Экспорт платежей', filename);
            break;
        default:
            throw new Error(`Unsupported format: ${format}`);
    }
    
    await saveExportRecord(userId, filename, 'payments', format, data.length);
    return { filepath, filename, count: data.length };
}

// ============================================
// ПОЛУЧЕНИЕ ЭКСПОРТОВ ПОЛЬЗОВАТЕЛЯ
// ============================================

async function getUserExports(userId, limit = 20, offset = 0) {
    const result = await User.query(
        `SELECT * FROM export_history 
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
    );
    
    const countResult = await User.query(
        `SELECT COUNT(*) FROM export_history WHERE user_id = $1`,
        [userId]
    );
    
    return {
        exports: result.rows,
        total: parseInt(countResult.rows[0].count)
    };
}

// ============================================
// СКАЧИВАНИЕ ЭКСПОРТА
// ============================================

async function downloadExport(userId, exportId) {
    const result = await User.query(
        `SELECT * FROM export_history WHERE id = $1 AND user_id = $2 AND expires_at > NOW()`,
        [exportId, userId]
    );
    
    if (result.rows.length === 0) {
        return { success: false, error: 'Export not found or expired' };
    }
    
    const exportRecord = result.rows[0];
    const filepath = getExportPath(exportRecord.filename);
    
    if (!fs.existsSync(filepath)) {
        return { success: false, error: 'File not found' };
    }
    
    return {
        success: true,
        filepath,
        filename: exportRecord.filename,
        contentType: getContentType(exportRecord.format)
    };
}

function getContentType(format) {
    switch (format) {
        case EXPORT_FORMATS.CSV:
            return 'text/csv';
        case EXPORT_FORMATS.JSON:
            return 'application/json';
        case EXPORT_FORMATS.EXCEL:
            return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        case EXPORT_FORMATS.PDF:
            return 'application/pdf';
        default:
            return 'application/octet-stream';
    }
}

// ============================================
= ОЧИСТКА СТАРЫХ ЭКСПОРТОВ
// ============================================

async function cleanupOldExports() {
    const result = await User.query(
        `SELECT filename FROM export_history WHERE expires_at < NOW()`
    );
    
    for (const record of result.rows) {
        const filepath = getExportPath(record.filename);
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
        }
    }
    
    await User.query(`DELETE FROM export_history WHERE expires_at < NOW()`);
    
    console.log(`🧹 Очищено старых экспортов: ${result.rows.length}`);
    return result.rows.length;
}

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = {
    exportUsers,
    exportListings,
    exportPayments,
    getUserExports,
    downloadExport,
    cleanupOldExports,
    EXPORT_FORMATS
};