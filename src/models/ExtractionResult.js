const mongoose = require('mongoose');

const extractionResultSchema = new mongoose.Schema({
  docId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  stage: {
    type: String,
    required: true,
    enum: ['extract', 'normalize', 'classify', 'complete'],
    index: true
  },
  inputType: {
    type: String,
    required: true,
    enum: ['image', 'text']
  },
  rawText: {
    type: String,
    required: true
  },
  result: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  confidence: {
    type: Number,
    required: true,
    min: 0,
    max: 1
  },
  metadata: {
    processingTime: Number,
    fileSize: Number,
    imageFormat: String,
    ocrEngine: {
      type: String,
      default: 'tesseract'
    },
    version: {
      type: String,
      default: '1.0.0'
    }
  },
  errors: [{
    stage: String,
    message: String,
    code: String,
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  tags: [String],
  isDeleted: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  }
});

// Indexes for better query performance
extractionResultSchema.index({ createdAt: -1 });
extractionResultSchema.index({ stage: 1, createdAt: -1 });
extractionResultSchema.index({ inputType: 1, createdAt: -1 });
extractionResultSchema.index({ confidence: -1 });
extractionResultSchema.index({ 'metadata.ocrEngine': 1 });

// Pre-save middleware to add metadata
extractionResultSchema.pre('save', function(next) {
  if (this.isNew) {
    this.metadata = this.metadata || {};
    this.metadata.version = this.metadata.version || '1.0.0';
    
    // Add processing metadata if not present
    if (!this.metadata.processingTime) {
      this.metadata.processingTime = Date.now() - (this.createdAt || Date.now());
    }
  }
  next();
});

// Instance methods
extractionResultSchema.methods.addError = function(stage, message, code) {
  this.errors.push({
    stage,
    message,
    code,
    timestamp: new Date()
  });
  return this.save();
};

extractionResultSchema.methods.updateConfidence = function(newConfidence) {
  this.confidence = Math.max(0, Math.min(1, newConfidence));
  return this.save();
};

extractionResultSchema.methods.addTag = function(tag) {
  if (!this.tags.includes(tag)) {
    this.tags.push(tag);
    return this.save();
  }
  return Promise.resolve(this);
};

// Static methods
extractionResultSchema.statics.findByStage = function(stage, limit = 10) {
  return this.find({ stage, isDeleted: false })
             .sort({ createdAt: -1 })
             .limit(limit);
};

extractionResultSchema.statics.findLowConfidence = function(threshold = 0.5) {
  return this.find({ 
    confidence: { $lt: threshold }, 
    isDeleted: false 
  }).sort({ confidence: 1 });
};

extractionResultSchema.statics.getStatistics = function() {
  return this.aggregate([
    { $match: { isDeleted: false } },
    {
      $group: {
        _id: '$stage',
        count: { $sum: 1 },
        avgConfidence: { $avg: '$confidence' },
        minConfidence: { $min: '$confidence' },
        maxConfidence: { $max: '$confidence' }
      }
    },
    { $sort: { _id: 1 } }
  ]);
};

extractionResultSchema.statics.cleanup = function(daysOld = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  
  return this.updateMany(
    { 
      createdAt: { $lt: cutoffDate },
      stage: { $ne: 'complete' } // Keep complete results longer
    },
    { $set: { isDeleted: true } }
  );
};

// Virtual for result summary
extractionResultSchema.virtual('summary').get(function() {
  const result = this.result;
  
  if (this.stage === 'complete' && result.amounts) {
    const total = result.amounts.find(a => a.type === 'total');
    const paid = result.amounts.find(a => a.type === 'paid');
    
    return {
      currency: result.currency,
      totalAmount: total ? total.value : null,
      paidAmount: paid ? paid.value : null,
      amountCount: result.amounts.length,
      confidence: this.confidence
    };
  }
  
  return {
    stage: this.stage,
    confidence: this.confidence,
    hasResult: !!result
  };
});

const ExtractionResult = mongoose.model('ExtractionResult', extractionResultSchema);

module.exports = ExtractionResult;