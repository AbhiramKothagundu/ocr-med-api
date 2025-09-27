const winston = require('winston');
const path = require('path');

// Custom log format
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let logEntry = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    
    if (Object.keys(meta).length > 0) {
      logEntry += `\n${JSON.stringify(meta, null, 2)}`;
    }
    
    return logEntry;
  })
);

// Development format (more readable)
const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({
    format: 'HH:mm:ss'
  }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let logEntry = `${timestamp} ${level}: ${message}`;
    
    if (Object.keys(meta).length > 0) {
      logEntry += `\n${JSON.stringify(meta, null, 2)}`;
    }
    
    return logEntry;
  })
);

// Determine log level based on environment
const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), 'logs');

// Transports configuration
const transports = [
  // Console transport
  new winston.transports.Console({
    level: logLevel,
    format: process.env.NODE_ENV === 'production' ? logFormat : devFormat,
    handleExceptions: true
  })
];

// File transports for production
if (process.env.NODE_ENV === 'production') {
  transports.push(
    // All logs
    new winston.transports.File({
      filename: path.join(logsDir, 'app.log'),
      level: 'info',
      format: logFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      handleExceptions: true
    }),
    // Error logs only
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: logFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      handleExceptions: true
    })
  );
}

// Create logger instance
const logger = winston.createLogger({
  level: logLevel,
  format: logFormat,
  transports,
  exitOnError: false,
  silent: process.env.NODE_ENV === 'test'
});

// Handle uncaught exceptions and unhandled rejections
if (process.env.NODE_ENV === 'production') {
  logger.exceptions.handle(
    new winston.transports.File({
      filename: path.join(logsDir, 'exceptions.log'),
      maxsize: 10485760,
      maxFiles: 3
    })
  );

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at Promise:', {
      promise,
      reason: reason.stack || reason
    });
  });
}

// Helper methods for structured logging
logger.logRequest = (req, res, responseTime) => {
  const logData = {
    method: req.method,
    url: req.originalUrl,
    statusCode: res.statusCode,
    responseTime: `${responseTime}ms`,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    contentLength: res.get('Content-Length') || 0
  };

  if (res.statusCode >= 400) {
    logger.warn('HTTP Request', logData);
  } else {
    logger.info('HTTP Request', logData);
  }
};

logger.logOCR = (operation, data) => {
  logger.debug('OCR Operation', {
    operation,
    confidence: data.confidence,
    textLength: data.text ? data.text.length : 0,
    processingTime: data.processingTime
  });
};

logger.logClassification = (amounts, results) => {
  logger.debug('Classification', {
    inputCount: amounts.length,
    outputCount: results.length,
    types: results.map(r => r.type),
    avgConfidence: results.reduce((sum, r) => sum + r.confidence, 0) / results.length
  });
};

logger.logNormalization = (original, normalized) => {
  logger.debug('Normalization', {
    originalCount: original.length,
    normalizedCount: normalized.length,
    corrections: original.length - normalized.length
  });
};

logger.logDatabase = (operation, collection, data = {}) => {
  logger.debug('Database Operation', {
    operation,
    collection,
    ...data
  });
};

logger.logPerformance = (operation, startTime, metadata = {}) => {
  const duration = Date.now() - startTime;
  logger.info('Performance', {
    operation,
    duration: `${duration}ms`,
    ...metadata
  });
};

// Security logging
logger.logSecurity = (event, details) => {
  logger.warn('Security Event', {
    event,
    timestamp: new Date().toISOString(),
    ...details
  });
};

// Business logic logging
logger.logBusiness = (event, data) => {
  logger.info('Business Event', {
    event,
    timestamp: new Date().toISOString(),
    ...data
  });
};

// Create child logger with context
logger.child = (context) => {
  return {
    debug: (message, meta = {}) => logger.debug(message, { ...context, ...meta }),
    info: (message, meta = {}) => logger.info(message, { ...context, ...meta }),
    warn: (message, meta = {}) => logger.warn(message, { ...context, ...meta }),
    error: (message, meta = {}) => logger.error(message, { ...context, ...meta })
  };
};

// Middleware for request ID generation and logging
logger.requestMiddleware = (req, res, next) => {
  const start = Date.now();
  
  // Generate unique request ID
  req.id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Add request ID to response headers
  res.set('X-Request-ID', req.id);
  
  // Log request start
  logger.info('Request started', {
    requestId: req.id,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  // Log response
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.logRequest(req, res, duration);
  });
  
  next();
};

module.exports = logger;