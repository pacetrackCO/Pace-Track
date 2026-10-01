'use strict';

const { createApp } = require('./app.cjs');

const app = createApp();

const rawPort = process.argv[2] || '5000';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Port must be an integer between 1 and 65535.');
}

app.listen(port, '0.0.0.0');