const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');

const conn = new Database(':memory:');
exports.all = () => [];
exports.orm = drizzle(conn);
