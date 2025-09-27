const ocrService = require('../services/ocrService');
const normalizationService = require('../services/normalizationService');
const classificationService = require('../services/classificationService');
const ExtractionResult = require('../models/ExtractionResult');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

class ExtractionController {
  async extract(req, res) {
    try {
      const docId = uuidv4();
      let inputType, rawText, confidence;

      if (req.file) {
        inputType = 'image';
        const result = await ocrService.extractFromImage(req.file.buffer);
        rawText = result.text;
        confidence = result.confidence;
      } else if (req.body.text) {
        inputType = 'text';
        rawText = req.body.text;
        confidence = 1.0;
      } else {
        return res.status(400).json({
          status: 'error',
          message: 'Either image file or text input is required'
        });
      }

      if (!rawText || rawText.trim().length === 0) {
        return res.status(400).json({
          status: 'no_text_found',
          message: 'No readable text found in the input'
        });
      }

      const tokens = ocrService.extractNumericTokens(rawText);

      if (tokens.length === 0) {
        return res.status(400).json({
          status: 'no_amounts_found',
          reason: 'document too noisy'
        });
      }

      const currencyHint = ocrService.detectCurrency(rawText);
      confidence = typeof confidence === 'number' ? confidence : 0.7;

      res.json({
        raw_tokens: tokens,
        currency_hint: currencyHint,
        confidence
      });
    } catch (error) {
      logger.error('Extract endpoint error:', error);
      res.status(500).json({
        status: 'error',
        message: 'Internal server error during extraction'
      });
    }
  }

  async normalize(req, res) {
    try {
      const { tokens, currency = 'INR' } = req.body;

      if (!tokens || !Array.isArray(tokens)) {
        return res.status(400).json({
          status: 'validation_error',
          message: 'Tokens array is required'
        });
      }

      const normalized = normalizationService.normalizeTokens(tokens);
      const normalization_confidence = normalizationService.calculateConfidence(tokens, normalized);

      res.json({
        normalized_amounts: normalized,
        normalization_confidence
      });
    } catch (error) {
      logger.error('Normalize endpoint error:', error);
      res.status(500).json({
        status: 'error',
        message: 'Internal server error during normalization'
      });
    }
  }

  async classify(req, res) {
    try {
      const { amounts, context, currency = 'INR' } = req.body;

      if (!amounts || !Array.isArray(amounts)) {
        return res.status(400).json({
          status: 'validation_error',
          message: 'Amounts array is required'
        });
      }

      const classified = classificationService.classifyAmounts(amounts, context || '', currency);
      const confidence = classificationService.calculateConfidence(classified);

      res.json({
        amounts: classified.map(a => ({
          type: a.type === 'total' ? 'total_bill' : a.type,
          value: a.value
        })),
        confidence
      });
    } catch (error) {
      logger.error('Classify endpoint error:', error);
      res.status(500).json({
        status: 'error',
        message: 'Internal server error during classification'
      });
    }
  }

  // FIX: Updated processComplete to save to database
  async processComplete(req, res) {
    try {
      const docId = uuidv4();
      let inputType, rawText, ocrConfidence;

      // Step 1: Extract
      if (req.file) {
        inputType = 'image';
        const ocrResult = await ocrService.extractFromImage(req.file.buffer);
        rawText = ocrResult.text;
        ocrConfidence = ocrResult.confidence;
      } else if (req.body.text) {
        inputType = 'text';
        rawText = req.body.text;
        ocrConfidence = 1.0;
      } else {
        return res.status(400).json({
          status: 'error',
          message: 'Either image file or text input is required'
        });
      }

      if (!rawText || rawText.trim().length === 0) {
        return res.status(400).json({
          status: 'no_text_found',
          message: 'No readable text found in the input'
        });
      }

      const tokens = ocrService.extractNumericTokens(rawText);

      if (tokens.length === 0) {
        return res.status(400).json({
          status: 'no_amounts_found',
          reason: 'document too noisy'
        });
      }

      const currency = ocrService.detectCurrency(rawText);

      // Step 2: Normalize
      const normalized = normalizationService.normalizeTokens(tokens);

      // Step 3: Classify
      const classified = classificationService.classifyAmounts(normalized, rawText, currency);

      // Build provenance
      const provenance = [];
      classified.forEach(a => {
        provenance.push({
          type: a.type === 'total' ? 'total_bill' : a.type,
          value: a.value,
          source: `text: '${a.source}'`
        });
      });

      // Calculate overall confidence
      const overallConfidence = classificationService.calculateConfidence(classified);

      // SAVE TO DATABASE
      const extractionResult = await ExtractionResult.create({
        docId,
        stage: 'complete',
        inputType,
        result: {
          currency,
          amounts: provenance,
          confidence: overallConfidence,
          provenance: {
            source: inputType === 'image' ? 'OCR from uploaded image' : 'Direct text input',
            extractedTokens: tokens,
            normalizedAmounts: normalized,
            rawText: inputType === 'text' ? rawText : '[Image content]'
          }
        },
        confidence: overallConfidence,
        metadata: {
          processingSteps: ['extract', 'normalize', 'classify'],
          tokensFound: tokens.length,
          amountsClassified: classified.length,
          currency
        }
      });

      logger.info(`Document ${docId} processed and saved successfully`);

      // Return response matching Problem Statement Step 4
      res.json({
        currency,
        amounts: provenance,
        status: "ok"
      });
    } catch (error) {
      logger.error('Complete processing error:', error);
      res.status(500).json({
        status: 'error',
        message: 'Internal server error during processing'
      });
    }
  }

  async getHistory(req, res) {
    try {
      const { page = 1, limit = 10, stage } = req.query;
      const query = stage ? { stage } : {};

      const results = await ExtractionResult.find(query)
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit)
        .select('-result.provenance.source');

      const total = await ExtractionResult.countDocuments(query);

      res.json({
        status: 'success',
        data: {
          results,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Get history error:', error);
      res.status(500).json({
        status: 'error',
        message: 'Internal server error fetching history'
      });
    }
  }

  async getById(req, res) {
    try {
      const { id } = req.params;
      const result = await ExtractionResult.findOne({ docId: id });

      if (!result) {
        return res.status(404).json({
          status: 'error',
          message: 'Document not found'
        });
      }

      res.json({
        status: 'success',
        data: result
      });
    } catch (error) {
      logger.error('Get by ID error:', error);
      res.status(500).json({
        status: 'error',
        message: 'Internal server error fetching document'
      });
    }
  }
}

module.exports = new ExtractionController();