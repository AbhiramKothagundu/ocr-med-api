const logger = require('../utils/logger');

class AppError extends Error {
  constructor(message, statusCode, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

const errorHandler = (err, req, res, next) => {
  // Set default error values
  let error = { ...err };
  error.message = err.message;

  // Log error details
  logger.error('Error occurred:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    body: req.body,
    query: req.query,
    params: req.params
  });

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    const message = 'Invalid document ID format';
    error = new AppError(message, 400, 'INVALID_ID');
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    const message = `Duplicate value for field: ${field}`;
    error = new AppError(message, 400, 'DUPLICATE_FIELD');
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map(val => val.message);
    const message = `Validation Error: ${errors.join(', ')}`;
    error = new AppError(message, 400, 'VALIDATION_ERROR');
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    const message = 'Invalid token. Please log in again';
    error = new AppError(message, 401, 'INVALID_TOKEN');
  }

  if (err.name === 'TokenExpiredError') {
    const message = 'Token expired. Please log in again';
    error = new AppError(message, 401, 'TOKEN_EXPIRED');
  }

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    const message = 'File size too large. Maximum size is 10MB';
    error = new AppError(message, 400, 'FILE_TOO_LARGE');
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    const message = 'Unexpected file field. Only "image" field is allowed';
    error = new AppError(message, 400, 'UNEXPECTED_FILE');
  }

  // OCR specific errors
  if (err.message && err.message.includes('tesseract')) {
    const message = 'OCR processing failed. Please try with a clearer image';
    error = new AppError(message, 422, 'OCR_FAILED');
  }

  // MongoDB connection errors
  if (err.name === 'MongooseServerSelectionError') {
    const message = 'Database connection failed. Please try again later';
    error = new AppError(message, 503, 'DATABASE_ERROR');
  }

  // File processing errors
  if (err.message && err.message.includes('sharp')) {
    const message = 'Image processing failed. Please check image format';
    error = new AppError(message, 422, 'IMAGE_PROCESSING_FAILED');
  }

  // Network/timeout errors
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
    const message = 'Service temporarily unavailable. Please try again later';
    error = new AppError(message, 503, 'SERVICE_UNAVAILABLE');
  }

  // Send error response
  const statusCode = error.statusCode || 500;
  const response = {
    status: 'error',
    message: error.message,
    ...(error.code && { code: error.code }),
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
  };

  // Add request ID for tracking
  if (req.id) {
    response.requestId = req.id;
  }

  // Different response for different error types
  if (statusCode >= 500) {
    // Server errors - don't expose internal details
    response.message = 'Internal server error. Please try again later';
    
    // Log critical errors with more context
    logger.error('Critical server error:', {
      error: error.message,
      stack: error.stack,
      requestData: {
        path: req.path,
        method: req.method,
        headers: req.headers,
        body: req.body
      }
    });
  }

  res.status(statusCode).json(response);
};

// Async error wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// 404 handler
const notFound = (req, res, next) => {
  const error = new AppError(`Route ${req.originalUrl} not found`, 404, 'ROUTE_NOT_FOUND');
  next(error);
};

// Graceful shutdown handler
const gracefulShutdown = (server) => {
  return (signal) => {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);
    
    server.close((err) => {
      if (err) {
        logger.error('Error during server shutdown:', err);
        process.exit(1);
      }
      
      logger.info('Server closed successfully');
      process.exit(0);
    });

    // Force exit after 30 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30000);
  };
};

// Custom error classes
class ValidationError extends AppError {
  constructor(message, field = null) {
    super(message, 400, 'VALIDATION_ERROR');
    this.field = field;
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

class ConflictError extends AppError {
  constructor(message) {
    super(message, 409, 'CONFLICT');
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized access') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super(message, 503, 'SERVICE_UNAVAILABLE');
  }
}

module.exports = {
  errorHandler,
  asyncHandler,
  notFound,
  gracefulShutdown,
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  ServiceUnavailableError
};