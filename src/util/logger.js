/**
 * Simple structured logger for the WhatsApp Travel Bot
 */

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

function formatTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level, message, meta = {}) {
  const base = {
    timestamp: formatTimestamp(),
    level,
    message,
  };

  if (Object.keys(meta).length > 0) {
    return JSON.stringify({ ...base, ...meta });
  }

  return JSON.stringify(base);
}

export const logger = {
  error(message, meta = {}) {
    if (currentLevel >= LOG_LEVELS.error) {
      console.error(formatMessage('error', message, meta));
    }
  },

  warn(message, meta = {}) {
    if (currentLevel >= LOG_LEVELS.warn) {
      console.warn(formatMessage('warn', message, meta));
    }
  },

  info(message, meta = {}) {
    if (currentLevel >= LOG_LEVELS.info) {
      console.log(formatMessage('info', message, meta));
    }
  },

  debug(message, meta = {}) {
    if (currentLevel >= LOG_LEVELS.debug) {
      console.log(formatMessage('debug', message, meta));
    }
  },

  // Special method for QR code - prints raw to console
  qr(message) {
    console.log('\n' + '='.repeat(50));
    console.log('SCAN THIS QR CODE WITH WHATSAPP:');
    console.log('='.repeat(50) + '\n');
    console.log(message);
    console.log('\n' + '='.repeat(50) + '\n');
  },
};

export default logger;
