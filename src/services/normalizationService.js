const logger = require('../utils/logger');

class NormalizationService {
  constructor() {
    // Common OCR misreads for digits
    this.digitCorrections = {
      'l': '1',
      'I': '1',
      'i': '1',
      'O': '0',
      'o': '0',
      'S': '5',
      's': '5',
      'Z': '2',
      'z': '2',
      'G': '6',
      'g': '6',
      'B': '8',
      'T': '7'
    };

    // Common OCR misreads for currency/text
    this.textCorrections = {
      'T0tal': 'Total',
      'T0TAL': 'TOTAL',
      'Amunt': 'Amount',
      'Tota1': 'Total',
      'Paid': 'Paid',
      'Due': 'Due',
      'SubT0tal': 'Subtotal',
      'Balanc3': 'Balance',
      'Discunt': 'Discount'
    };
  }

  normalizeTokens(tokens) {
    if (!Array.isArray(tokens)) {
      return [];
    }

    return tokens.map(token => this.normalizeToken(token))
                 .filter(val => val !== null && !isNaN(val) && val >= 0);
  }

  normalizeToken(token) {
    if (!token || typeof token !== 'string') {
      return null;
    }

    try {
      let normalized = token.trim();

      // Step 1: Fix common OCR digit errors
      normalized = this.correctDigitErrors(normalized);

      // Step 2: Handle percentage separately
      const isPercentage = normalized.includes('%');
      
      // Step 3: Remove currency symbols and non-numeric chars except decimal points
      normalized = normalized.replace(/[₹$€£,\s%]/g, '');
      
      // Step 4: Handle decimal separators (both . and ,)
      normalized = this.normalizeDecimalSeparators(normalized);

      // Step 5: Parse to number
      const value = parseFloat(normalized);
      
      if (isNaN(value)) {
        return null;
      }

      // Step 6: Handle percentage values
      if (isPercentage && value <= 100) {
        return value / 100; // Convert percentage to decimal
      }

      return value;

    } catch (error) {
      logger.warn(`Failed to normalize token: ${token}`, error);
      return null;
    }
  }

  correctDigitErrors(text) {
    let corrected = text;
    
    // Apply digit corrections
    for (const [wrong, right] of Object.entries(this.digitCorrections)) {
      const regex = new RegExp(wrong, 'g');
      corrected = corrected.replace(regex, right);
    }

    return corrected;
  }

  normalizeDecimalSeparators(text) {
    // Handle European style (1.234,56) vs US style (1,234.56)
    const commaCount = (text.match(/,/g) || []).length;
    const dotCount = (text.match(/\./g) || []).length;

    if (commaCount === 0 && dotCount <= 1) {
      // Simple case: 1234 or 1234.56
      return text;
    }

    if (commaCount === 1 && dotCount === 0) {
      // Could be European decimal: 1234,56
      const parts = text.split(',');
      if (parts[1] && parts[1].length <= 2) {
        return parts[0] + '.' + parts[1];
      }
      // Or thousands separator: 1,234
      return text.replace(',', '');
    }

    if (commaCount > 1 && dotCount === 0) {
      // Multiple commas as thousands separators: 1,234,567
      return text.replace(/,/g, '');
    }

    if (dotCount > 1 && commaCount === 0) {
      // Multiple dots as thousands separators: 1.234.567
      const lastDotIndex = text.lastIndexOf('.');
      return text.substring(0, lastDotIndex).replace(/\./g, '') + 
             text.substring(lastDotIndex);
    }

    // Mixed separators - determine which is decimal
    const lastCommaIndex = text.lastIndexOf(',');
    const lastDotIndex = text.lastIndexOf('.');

    if (lastCommaIndex > lastDotIndex) {
      // Comma is likely decimal separator
      return text.substring(0, lastCommaIndex).replace(/[,.]/g, '') + 
             '.' + text.substring(lastCommaIndex + 1);
    } else {
      // Dot is likely decimal separator
      return text.substring(0, lastDotIndex).replace(/[,.]/g, '') + 
             text.substring(lastDotIndex);
    }
  }

  calculateConfidence(originalTokens, normalizedValues) {
    if (!originalTokens.length) return 0;

    let corrections = 0;
    let total = originalTokens.length;

    for (let i = 0; i < originalTokens.length; i++) {
      const original = originalTokens[i];
      
      // Check if we had to make corrections
      if (this.requiredCorrection(original)) {
        corrections++;
      }
    }

    // Confidence decreases with more corrections needed
    const correctionRatio = corrections / total;
    return Math.max(0.1, 1 - (correctionRatio * 0.5));
  }

  requiredCorrection(token) {
    if (!token) return false;

    // Check if token contained OCR error patterns
    const hasDigitErrors = Object.keys(this.digitCorrections).some(error => 
      token.includes(error)
    );

    // Check for unusual number formats that needed normalization
    const hasFormatIssues = /[lIOoSsZzGgBT]/.test(token) || 
                           (token.match(/[,.]/g) || []).length > 1;

    return hasDigitErrors || hasFormatIssues;
  }

  // Advanced normalization for specific receipt formats
  normalizeReceiptNumbers(text, context = '') {
    const patterns = [
      // Match amounts like "Rs. 1,250.00" or "₹ 1250"
      /(?:Rs\.?\s*|₹\s*)(\d+(?:[,\.]\d+)*)/gi,
      // Match standalone numbers that look like amounts
      /\b(\d{1,3}(?:[,\.]\d{3})*(?:\.\d{2})?)\b/g,
      // Match percentages
      /(\d+(?:\.\d+)?)\s*%/g
    ];

    const amounts = [];
    
    patterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const normalized = this.normalizeToken(match[1] || match[0]);
        if (normalized !== null) {
          amounts.push({
            original: match[0],
            normalized,
            position: match.index,
            pattern: pattern.source
          });
        }
      }
    });

    return amounts.sort((a, b) => a.position - b.position);
  }
}

module.exports = new NormalizationService();