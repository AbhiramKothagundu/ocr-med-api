const Joi = require('joi');
const logger = require('../utils/logger');

// Schema definitions
const schemas = {
  extractInput: Joi.object({
    // SIMPLIFIED: Since both branches are the same, just use one schema
    text: Joi.string().allow('').max(10000).optional()
  }).unknown(true), // Allow other fields like multer adds

  normalizeInput: Joi.object({
    tokens: Joi.array().items(Joi.string()).min(1).required(),
    currency: Joi.string().valid('INR', 'USD', 'EUR', 'GBP').default('INR')
  }),

  classifyInput: Joi.object({
    amounts: Joi.array().items(Joi.number().positive()).min(1).required(),
    context: Joi.string().max(10000).default(''),
    currency: Joi.string().valid('INR', 'USD', 'EUR', 'GBP').default('INR')
  }),

  completeInput: Joi.object({
    // FIXED: Include .allow('') in the conditional branches
    text: Joi.when('$hasFile', {
      is: false,
      then: Joi.string().allow('').max(10000).optional(),
      otherwise: Joi.string().allow('').max(10000).optional()
    })
  }).unknown(true)
};

const validateInput = (req, res, next) => {
  try {
    const endpoint = req.path.split('/').pop();
    let schema;
    
    // Determine which schema to use based on endpoint
    switch (endpoint) {
      case 'extract':
        schema = schemas.extractInput;
        break;
      case 'normalize':
        schema = schemas.normalizeInput;
        break;
      case 'classify':
        schema = schemas.classifyInput;
        break;
      case 'final':
        schema = schemas.completeInput;
        break;
      default:
        return next(); // Skip validation for unknown endpoints
    }

    // Check if file is present
    const hasFile = !!req.file;
    
    // Validate the request body
    const { error, value } = schema.validate(req.body, {
      context: { hasFile },
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
        value: detail.context.value
      }));

      logger.warn('Validation failed', { endpoint, errors, body: req.body });

      return res.status(400).json({
        status: 'validation_error',
        message: 'Invalid request data',
        errors
      });
    }

    // Additional file validation for image endpoints
    if ((endpoint === 'extract' || endpoint === 'final') && hasFile) {
      const fileValidation = validateFile(req.file);
      if (fileValidation.error) {
        return res.status(400).json({
          status: 'file_validation_error',
          message: fileValidation.error
        });
      }
    }

    // FIXED: Check for missing text field (undefined), not empty text ('')
    // This allows empty strings to pass through to controller for proper handling
    if ((endpoint === 'extract' || endpoint === 'final') && !hasFile && req.body.text === undefined) {
      return res.status(400).json({
        status: 'error',
        message: 'Either image file or text input is required'
      });
    }

    // Set validated data
    req.validatedData = value;
    next();

  } catch (err) {
    logger.error('Validation middleware error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Internal validation error'
    });
  }
};

const validateFile = (file) => {
  if (!file) {
    return { error: 'No file provided' };
  }

  // Check file size (10MB limit)
  if (file.size > 10 * 1024 * 1024) {
    return { error: 'File size exceeds 10MB limit' };
  }

  // Check file type
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp'];
  if (!allowedTypes.includes(file.mimetype)) {
    return { error: 'Invalid file type. Only images (JPEG, PNG, GIF, BMP) are allowed' };
  }

  // Check if file has content
  if (!file.buffer || file.buffer.length === 0) {
    return { error: 'Empty file provided' };
  }

  return { valid: true };
};

// Additional validation helpers
const validatePagination = (req, res, next) => {
  const schema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(10),
    stage: Joi.string().valid('extract', 'normalize', 'classify', 'complete').optional()
  });

  const { error, value } = schema.validate(req.query);
  
  if (error) {
    return res.status(400).json({
      status: 'validation_error',
      message: 'Invalid pagination parameters',
      errors: error.details.map(d => d.message)
    });
  }

  req.pagination = value;
  next();
};

const validateDocId = (req, res, next) => {
  const schema = Joi.object({
    id: Joi.string().uuid().required()
  });

  const { error } = schema.validate(req.params);
  
  if (error) {
    return res.status(400).json({
      status: 'validation_error',
      message: 'Invalid document ID format'
    });
  }

  next();
};

// Rate limiting validation
const validateRateLimit = (maxRequests = 100, windowMs = 15 * 60 * 1000) => {
  const requests = new Map();

  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    // Clean old requests
    if (requests.has(key)) {
      requests.set(key, requests.get(key).filter(time => time > windowStart));
    } else {
      requests.set(key, []);
    }

    const userRequests = requests.get(key);

    if (userRequests.length >= maxRequests) {
      return res.status(429).json({
        status: 'rate_limit_exceeded',
        message: `Too many requests. Limit: ${maxRequests} per ${windowMs/1000/60} minutes`,
        retryAfter: Math.ceil((userRequests[0] + windowMs - now) / 1000)
      });
    }

    userRequests.push(now);
    requests.set(key, userRequests);

    next();
  };
};

// Content-Type validation
const validateContentType = (allowedTypes = ['application/json', 'multipart/form-data']) => {
  return (req, res, next) => {
    const contentType = req.get('Content-Type');
    
    if (!contentType) {
      return res.status(400).json({
        status: 'validation_error',
        message: 'Content-Type header is required'
      });
    }

    const isValid = allowedTypes.some(type => contentType.includes(type));
    
    if (!isValid) {
      return res.status(400).json({
        status: 'validation_error',
        message: `Invalid Content-Type. Allowed: ${allowedTypes.join(', ')}`
      });
    }

    next();
  };
};

module.exports = {
  validateInput,
  validateFile,
  validatePagination,
  validateDocId,
  validateRateLimit,
  validateContentType,
  schemas
};