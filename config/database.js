const { Pool } = require('pg');
const { config } = require('./env');

let pool = null;

function createPool() {
    if (pool) return pool;
    
    pool = new Pool({
        connectionString: config.database.url,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });
    
    pool.on('error', (err) => {
        console.error('Unexpected error on idle client', err);
    });
    
    return pool;
}

async function query(sql, params = []) {
    const client = await createPool().connect();
    try {
        const result = await client.query(sql, params);
        return result;
    } finally {
        client.release();
    }
}

async function getConnection() {
    return await createPool().connect();
}

async function transaction(callback) {
    const client = await getConnection();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    createPool,
    getConnection,
    query,
    transaction,
    get pool() { return pool; },
};
