// src/db/index.js
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { migrate } = require('./migrations');

const DB_PATH = path.join(__dirname, '../../data/db.sqlite');

// Ensure data/ directory exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
migrate(db);

module.exports = db;
