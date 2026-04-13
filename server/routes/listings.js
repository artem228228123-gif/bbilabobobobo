const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/', (req, res) => {
    res.json({ success: true, listings: [] });
});

router.get('/:id', (req, res) => {
    res.json({ success: true, listing: { id: req.params.id } });
});

router.post('/', upload.array('photos', 10), (req, res) => {
    res.json({ success: true, message: 'Listing created', files: req.files?.length || 0 });
});

router.put('/:id', upload.array('photos', 10), (req, res) => {
    res.json({ success: true, message: 'Listing updated' });
});

router.delete('/:id', (req, res) => {
    res.json({ success: true, message: 'Listing deleted' });
});

router.post('/:id/like', (req, res) => {
    res.json({ success: true, liked: true });
});

module.exports = router;
