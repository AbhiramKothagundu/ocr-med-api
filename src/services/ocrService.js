const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const logger = require('../utils/logger');

class OCRService {
  constructor() {
    this.currencyPatterns = {
      INR: /(?:₹|rs\.?|inr|rupees?)/i,
      USD: /(?:\$|usd|dollars?)/i,
      EUR: /(?:€|eur|euros?)/i,
      GBP: /(?:£|gbp|pounds?)/i
    };

    this.numericPattern = /(?:\$|₹|€|£)?\s*\d+(?:[,\.]\d+)*(?:\.\d{2})?%?/g;
  }

  async preprocessImage(buffer) {
    try {
      // Get image metadata first
      const metadata = await sharp(buffer).metadata();
      
      // Enhanced image preprocessing pipeline for better OCR
      let processedBuffer = await sharp(buffer)
        .rotate() // Auto-rotate based on EXIF
        .greyscale()
        .normalise() // Enhance contrast
        .sharpen({ sigma: 1.0, m1: 1.0, m2: 2.0 }) // Moderate sharpening
        .resize(null, Math.max(1200, metadata.height), { 
          withoutEnlargement: true,
          kernel: sharp.kernel.lanczos3 
        })
        .median(1) // Reduce noise
        .modulate({
          brightness: 1.1, // Slightly brighter
          contrast: 1.2    // Higher contrast
        })
        .png({ 
          quality: 100,
          compressionLevel: 0 // No compression for OCR
        })
        .toBuffer();

      return processedBuffer;
    } catch (error) {
      logger.error('Image preprocessing failed:', error);
      return buffer; // Fallback to original
    }
  }

  async extractFromImage(imageBuffer) {
    try {
      const processedImage = await this.preprocessImage(imageBuffer);
      
      const { data: { text, confidence } } = await Tesseract.recognize(
        processedImage,
        'eng',
        {
          logger: (m) => {
            if (m.status === 'recognizing text') {
              logger.debug(`OCR Progress: ${Math.round(m.progress * 100)}%`);
            }
          },
          // Enhanced OCR configuration for better accuracy
          tessedit_pageseg_mode: '1', // Automatic page segmentation with OSD
          tessedit_ocr_engine_mode: '2', // Legacy + LSTM engines
          preserve_interword_spaces: '1',
          tessedit_char_whitelist: '0123456789.,ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz$₹€£:%()-/\\|. \n\r\t',
          // Improve number recognition
          classify_enable_learning: '0',
          classify_enable_adaptive_matcher: '0'
        }
      );

      // Post-process OCR text for better quality
      const cleanedText = this.postProcessOCRText(text);

      return {
        text: cleanedText,
        confidence: confidence / 100 // Convert to 0-1 range
      };

    } catch (error) {
      logger.error('OCR extraction failed:', error);
      throw new Error('Failed to extract text from image');
    }
  }

  postProcessOCRText(text) {
    if (!text) return '';
    
    // Clean up common OCR artifacts
    let cleaned = text
      .replace(/[|\\]/g, 'l') // Common misreads
      .replace(/[{}]/g, '') // Remove brackets that are usually artifacts
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/([a-zA-Z])\s+([a-zA-Z])/g, '$1$2') // Fix broken words
      .trim();
    
    return cleaned;
  }

  extractNumericTokens(text) {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const matches = text.match(this.numericPattern) || [];
    
    // Filter out obvious non-monetary values
    return matches.filter(token => {
      const num = this.parseNumericToken(token);
      
      // Basic range check
      if (num < 0.01 || num > 1000000) return false;
      
      // Filter standalone percentages without context
      if (token.includes('%') && num < 100) return false;
      
      // Hard filters for common non-monetary patterns
      
      // ZIP codes (5 digits, 10000-99999 range)
      if (num >= 10000 && num <= 99999 && token.match(/^\s*\d{5}$/)) return false;
      
      // Phone number patterns
      if (token.includes('.') && token.match(/^\d{3}\.\d{3}$/)) return false;
      
      // Years
      if (num >= 1900 && num <= 2100) return false;
      
      // Very small numbers without currency symbols
      if (num <= 10 && !token.match(/[\$₹€£]/)) {
        if (!this.hasStrongMonetaryContext(token, text)) return false;
      }
      
      // Account/ID numbers (6+ digits)
      if (num >= 100000 && token.match(/^\s*\d{6,}$/)) return false;
      
      return true;
    });
  }

  isLikelyNonMonetary(num, token, fullText) {
    // ZIP codes (US format: 5 digits, often 60000-99999 range)
    if (num >= 10000 && num <= 99999 && token.match(/^\d{5}$/)) {
      return true; // Always filter 5-digit numbers that look like ZIP codes
    }
    
    // Phone numbers (various patterns)
    if (token.includes('.') && token.match(/^\d{3}\.\d{3}$/)) {
      return true; // Pattern like 555.555
    }
    
    if (token.match(/^\d{3,4}$/) && num >= 100 && num <= 9999) {
      const context = this.getTokenContext(token, fullText, 30);
      if (/\b(phone|tel|call|contact|555|800|866|877|888)\b/i.test(context)) {
        return true;
      }
    }
    
    // Account numbers and reference numbers
    if (num >= 100000 || (num >= 1000 && token.match(/^\d{4,}$/))) {
      const context = this.getTokenContext(token, fullText, 25);
      if (/\b(account|number|#|no|ref|id|patient|bill|receipt)\b/i.test(context)) {
        return true;
      }
    }
    
    // Years and dates
    if (num >= 1900 && num <= 2100) {
      return true; // Always filter years
    }
    
    if (num >= 1 && num <= 31) {
      const context = this.getTokenContext(token, fullText, 15);
      if (/\b(date|day|month|\d{1,2}\/\d{1,2}|\d{4})\b/i.test(context)) {
        return true;
      }
    }
    
    // Street addresses and building numbers
    if (num >= 1 && num <= 9999) {
      const context = this.getTokenContext(token, fullText, 25);
      if (/\b(street|st|avenue|ave|blvd|boulevard|road|rd|suite|apt|building)\b/i.test(context)) {
        return true;
      }
    }
    
    // Very small amounts without clear monetary context
    if (num <= 10 && !this.hasStrongMonetaryContext(token, fullText)) {
      return true;
    }
    
    // Quantities and counts (often single/double digits)
    if (num <= 50 && token.match(/^\d{1,2}$/) && !this.hasStrongMonetaryContext(token, fullText)) {
      const context = this.getTokenContext(token, fullText, 20);
      if (/\b(qty|quantity|count|units|pieces|items|x|times)\b/i.test(context)) {
        return true;
      }
    }
    
    return false;
  }

  hasStrongMonetaryContext(token, text) {
    const context = this.getTokenContext(token, text, 30);
    
    // Strong monetary indicators
    const strongMoneyPattern = /\b(rs\.?|usd|dollar|total|amount|paid|due|cost|price|bill|charge|fee|payment|balance|subtotal|tax|gst|discount)\b/i;
    
    // Currency symbols nearby
    const currencySymbols = /[\$₹€£]/;
    
    // Typical monetary formatting
    const monetaryFormat = /\d+[,\.]\d{2}(?!\d)/; // Ends with .XX format
    
    return strongMoneyPattern.test(context) || 
           currencySymbols.test(context) || 
           (monetaryFormat.test(token) && token.includes('.'));
  }

  getTokenContext(token, text, windowSize) {
    const index = text.indexOf(token);
    if (index === -1) return '';
    
    const start = Math.max(0, index - windowSize);
    const end = Math.min(text.length, index + token.length + windowSize);
    return text.slice(start, end).toLowerCase();
  }

  hasMonetaryContext(token, text) {
    return this.hasStrongMonetaryContext(token, text);
  }

  parseNumericToken(token) {
    if (!token) return 0;
    
    // Remove percentage sign for parsing but keep track of it
    const cleanToken = token.replace(/[,%]/g, '').replace(/₹|rs\.?|inr|\$|usd|€|eur|£|gbp/gi, '');
    const num = parseFloat(cleanToken);
    
    return isNaN(num) ? 0 : num;
  }

  detectCurrency(text) {
    if (!text || typeof text !== 'string') {
      return 'USD'; // Default to USD for international compatibility
    }

    const lowerText = text.toLowerCase();
    
    // Enhanced currency detection with priority scoring
    const currencyScores = { USD: 0, INR: 0, EUR: 0, GBP: 0 };
    
    // Direct currency symbol/code detection (high weight)
    if (/\$/.test(text)) currencyScores.USD += 15;
    if (/₹|rs\.?(?!\w)|rupees?/i.test(text)) currencyScores.INR += 15;
    if (/€|euros?/i.test(text)) currencyScores.EUR += 15;
    if (/£|pounds?/i.test(text)) currencyScores.GBP += 15;
    
    // USD-specific patterns (high weight)
    if (/usd\s*[\d,\.]+|[\d,\.]+\s*usd/i.test(text)) currencyScores.USD += 12;
    if (/\$[\d,\.]+/g.test(text)) currencyScores.USD += 10;
    
    // Medical/healthcare context (strong USD indicator in many cases)
    if (/\b(doctor|medical|hospital|clinic|orthopedics|patient|insurance|copay|deductible)\b/i.test(lowerText)) {
      currencyScores.USD += 8;
    }
    
    // Geographic/cultural indicators (medium weight)
    if (/\b(usa|america|american|united states|chicago|new york|california|texas|florida|illinois|midtown)\b/i.test(lowerText)) {
      currencyScores.USD += 6;
    }
    if (/\b(india|indian|delhi|mumbai|bangalore|chennai|kolkata|pune|hyderabad|gst|cgst|sgst)\b/i.test(lowerText)) {
      currencyScores.INR += 6;
    }
    if (/\b(europe|european|germany|france|spain|italy)\b/i.test(lowerText)) {
      currencyScores.EUR += 6;
    }
    if (/\b(uk|britain|british|england|london)\b/i.test(lowerText)) {
      currencyScores.GBP += 6;
    }
    
    // Business context indicators (medium weight)
    if (/\b(llc|inc|corp|corporation)\b/i.test(lowerText)) {
      currencyScores.USD += 4;
    }
    if (/\b(pvt\.?\s*ltd|private limited)\b/i.test(lowerText)) {
      currencyScores.INR += 4;
    }
    
    // State/regional indicators (medium weight for US)
    if (/\b(il|ny|ca|tx|fl|pa|oh|mi|ga|nc|nj)\s*\d{5}\b/i.test(lowerText)) {
      currencyScores.USD += 5; // US state abbreviation with ZIP
    }
    
    // Phone number patterns (US format suggests USD)
    if (/1-\d{3}-\d{3}-\d{4}|\(\d{3}\)\s*\d{3}-\d{4}/g.test(text)) {
      currencyScores.USD += 3;
    }
    
    // Find currency with highest score
    const detectedCurrency = Object.entries(currencyScores).reduce((best, [currency, score]) => 
      score > best.score ? { currency, score } : best
    , { currency: 'USD', score: 0 });
    
    // If no strong indicators, default to USD
    return detectedCurrency.score > 0 ? detectedCurrency.currency : 'USD';
  }

  calculateContextualRelevance(token, surroundingText, position) {
    // Check for monetary keywords near the token
    const moneyKeywords = [
      'total', 'amount', 'paid', 'due', 'balance', 'cost', 'price', 'bill', 'invoice',
      'subtotal', 'tax', 'discount', 'tip', 'charge', 'fee', 'sum', 'payment',
      'gst', 'cgst', 'sgst', 'vat', 'copay', 'deductible', 'adjustment'
    ];

    const contextWindow = 50; // Characters before and after
    const startPos = Math.max(0, position - contextWindow);
    const endPos = Math.min(surroundingText.length, position + token.length + contextWindow);
    const context = surroundingText.slice(startPos, endPos).toLowerCase();

    let score = 0.4; // Base score
    
    // Keyword proximity scoring
    const keywordCount = moneyKeywords.filter(keyword => 
      context.includes(keyword)
    ).length;
    score += keywordCount * 0.3;

    // Currency symbol bonus
    if (/[\$₹€£]/.test(context)) {
      score += 0.4;
    }
    
    // Proper monetary formatting bonus
    if (token.match(/\d+\.\d{2}$/)) { // Ends with .XX
      score += 0.3;
    }
    
    // Decimal amounts are more likely to be monetary
    if (token.includes('.') && !token.includes('%')) {
      score += 0.2;
    }
    
    // Currency prefix/suffix bonus
    if (token.startsWith('$') || token.startsWith('₹') || token.startsWith('€') || token.startsWith('£') || /usd|inr|eur|gbp/i.test(context)) {
      score += 0.3;
    }
    
    // Reasonable monetary range bonus
    const value = this.parseNumericToken(token);
    if (value >= 1 && value <= 100000) {
      score += 0.2;
    }
    
    // Penalty for very small numbers without strong context
    if (value < 10 && keywordCount === 0) {
      score -= 0.3;
    }

    return Math.min(1.0, Math.max(0.0, score));
  }

  extractTokensWithContext(text) {
    const tokens = [];
    let match;
    const regex = new RegExp(this.numericPattern.source, 'g');

    while ((match = regex.exec(text)) !== null) {
      const token = match[0];
      const position = match.index;
      const value = this.parseNumericToken(token);
      
      // Skip if likely non-monetary
      if (this.isLikelyNonMonetary(value, token, text)) {
        continue;
      }
      
      const relevance = this.calculateContextualRelevance(token, text, position);
      
      tokens.push({
        token,
        value,
        position,
        relevance,
        context: text.slice(Math.max(0, position - 30), position + token.length + 30).trim()
      });
    }

    // Sort by relevance and filter to most relevant amounts
    const sortedTokens = tokens.sort((a, b) => b.relevance - a.relevance);
    
    // For noisy OCR, limit to top 10 most relevant amounts
    const limitedTokens = sortedTokens.slice(0, 10);
    
    return limitedTokens;
  }
}

module.exports = new OCRService();