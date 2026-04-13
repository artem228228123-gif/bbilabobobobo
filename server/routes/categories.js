const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    res.json({ success: true, categories: [] });
});

router.get('/tree', (req, res) => {
    res.json({ success: true, tree: [] });
});

router.get('/:id', (req, res) => {
    res.json({ success: true, category: { id: req.params.id } });
});

router.get('/:id/listings', (req, res) => {
    res.json({ success: true, listings: [] });
});

module.exports = router;
