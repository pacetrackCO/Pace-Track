'use strict';

// Explicit development setup only, never a server-start or publish hook.
if (process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production') {
    console.error('This schema setup is development-only. Production schema changes belong to Publish.');
    process.exit(1);
}

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('The development database is not configured.');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        const sql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
        await pool.query(sql);
        console.log('Development schema applied.');
    } finally { await pool.end(); }
}

main().catch(() => {
    console.error('Could not apply the development schema. No connection details were logged.');
    process.exitCode = 1;
});