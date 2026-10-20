'use strict';
/**
 * logger.js
 * Writes timestamped log lines to %APPDATA%\EdgeNest\logs\app-YYYY-MM-DD.log
 * and to stdout. Keeps a rolling in-memory buffer of 500 lines for diagnostics.
 */

const fs   = require('fs');
const path = require('path');
const { getConfigDir } = require('./config-store');

const MAX_BUFFER = 500;
const _buffer    = [];

function logLine(level, ...args) {
  const ts  = new Date().toISOString();
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `[${ts}] [${level}] ${msg}`;

  // In-memory ring buffer
  _buffer.push(line);
  if (_buffer.length > MAX_BUFFER) _buffer.shift();

  // Console
  // eslint-disable-next-line no-console
  console.log(line);

  // File (best-effort — never crash on log failure)
  try {
    const logDir = path.join(getConfigDir(), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const dayFile = path.join(logDir, `app-${ts.slice(0, 10)}.log`);
    fs.appendFileSync(dayFile, line + '\n');
  } catch (_) { /* silent — log failures must never crash the app */ }
}

const log = {
  info:  (...a) => logLine('INFO',  ...a),
  warn:  (...a) => logLine('WARN',  ...a),
  error: (...a) => logLine('ERROR', ...a),
  debug: (...a) => logLine('DEBUG', ...a),
  getBuffer: () => [..._buffer],
};

module.exports = log;
