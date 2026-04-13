const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));
app.use(express.static(path.join(__dirname, '../client/pages')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/pages/index.html'));
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/pages/login.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/pages/admin.html'));
});

app.get('/api/v1/listings', (req, res) => {
    res.json({ listings: [] });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
