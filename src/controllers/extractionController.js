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
        // Image input
        inputType = 'image';
        const result = await ocrService.extractFromImage(req.file.buffer);
        rawText = result.text;
        confidence = result.confidence;
      } else if (req.body.text) {
        // Text input
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
          message: 'No numeric amounts detected in the text'
        });
      }

      const result = {
        docId,
        inputType,
        rawText,
        tokens,
        confidence,
        currency: ocrService.detectCurrency(rawText),
        timestamp: new Date()
      };

      // Save to database
      await ExtractionResult.create({
        docId,
        stage: 'extract',
        inputType,
        rawText,
        result: { tokens, currency: result.currency },
        confidence
      });

      res.json({
        status: 'success',
        data: result
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
          status: 'error',
          message: 'Tokens array is required'
        });
      }

      const normalized = normalizationService.normalizeTokens(tokens);
      const confidence = normalizationService.calculateConfidence(tokens, normalized);

      const result = {
        original: tokens,
        normalized,
        currency,
        confidence,
        timestamp: new Date()
      };

      res.json({
        status: 'success',
        data: result
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
          status: 'error',
          message: 'Amounts array is required'
        });
      }

      const classified = classificationService.classifyAmounts(amounts, context || '');
      const confidence = classificationService.calculateConfidence(classified);

      const result = {
        amounts,
        classified,
        currency,
        confidence,
        timestamp: new Date()
      };

      res.json({
        status: 'success',
        data: result
      });

    } catch (error) {
      logger.error('Classify endpoint error:', error);
      res.status(500).json({
        status: 'error',
        message: 'Internal server error during classification'
      });
    }
  }

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
          message: 'No numeric amounts detected in the text'
        });
      }

      const currency = ocrService.detectCurrency(rawText);

      // Step 2: Normalize
      const normalized = normalizationService.normalizeTokens(tokens);
      const normalizationConfidence = normalizationService.calculateConfidence(tokens, normalized);

      // Step 3: Classify (pass currency for filtering)
      const classified = classificationService.classifyAmounts(normalized, rawText, currency);
      const classificationConfidence = classificationService.calculateConfidence(classified);

      // Calculate overall confidence
      const overallConfidence = (ocrConfidence * normalizationConfidence * classificationConfidence) ** (1/3);

      // Build provenance object
      const provenance = {
        source: rawText,
        extractedTokens: tokens,
        normalizedAmounts: normalized
      };

      // Build result object for DB and response
      const resultObj = {
        docId,
        inputType,
        currency,
        amounts: classified,
        confidence: parseFloat(overallConfidence.toFixed(3)),
        provenance,
        timestamp: new Date()
      };

      // Save complete result to database
      await ExtractionResult.create({
        docId,
        stage: 'complete',
        inputType,
        rawText,
        result: resultObj,
        confidence: overallConfidence
      });

      // Respond with the same structure as stored in DB
      res.json({
        status: 'success',
        data: resultObj
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