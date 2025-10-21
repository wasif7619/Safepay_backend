// src/config/db.js
const { Pool } = require('pg');

// create connection pool
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'safepaydatabase',
    password: '12345',
    port: 5000,
  });


// test connection
pool.connect()
  .then(() => console.log('✅ Connected to PostgreSQL'))
  .catch(err => console.error('❌ Database connection error:', err));

module.exports = pool;
