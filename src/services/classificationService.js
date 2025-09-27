const logger = require('../utils/logger');

class ClassificationService {
  constructor() {
    this.classificationRules = {
      total: {
        keywords: ['total', 'grand total', 'amount due', 'final amount', 'net amount', 'bill amount'],
        patterns: [/total\s*:?\s*[\d,\.]+/i, /amount\s*due\s*:?\s*[\d,\.]+/i],
        priority: 10
      },
      subtotal: {
        keywords: ['subtotal', 'sub total', 'sub-total', 'amount before tax'],
        patterns: [/sub\s*total\s*:?\s*[\d,\.]+/i],
        priority: 7
      },
      paid: {
        keywords: ['paid', 'amount paid', 'cash paid', 'payment', 'received'],
        patterns: [/paid\s*:?\s*[\d,\.]+/i, /payment\s*:?\s*[\d,\.]+/i],
        priority: 9
      },
      due: {
        keywords: ['due', 'balance', 'outstanding', 'pending', 'remaining'],
        patterns: [/due\s*:?\s*[\d,\.]+/i, /balance\s*:?\s*[\d,\.]+/i],
        priority: 8
      },
      tax: {
        keywords: ['tax', 'vat', 'gst', 'service tax', 'cgst', 'sgst', 'igst'],
        patterns: [/tax\s*:?\s*[\d,\.]+/i, /gst\s*:?\s*[\d,\.]+/i],
        priority: 6
      },
      discount: {
        keywords: ['discount', 'off', 'savings', 'reduction', 'rebate'],
        patterns: [/discount\s*:?\s*[\d,\.]+/i, /\d+%\s*off/i],
        priority: 5
      },
      tip: {
        keywords: ['tip', 'gratuity', 'service charge'],
        patterns: [/tip\s*:?\s*[\d,\.]+/i, /service\s*charge\s*:?\s*[\d,\.]+/i],
        priority: 4
      },
      item: {
        keywords: ['price', 'cost', 'rate', 'amount'],
        patterns: [/\d+\s*x\s*[\d,\.]+/i, /qty\s*\d+.*[\d,\.]+/i],
        priority: 3
      }
    };
  }

  classifyAmounts(amounts, context = '', currency = 'INR') {
    if (!Array.isArray(amounts) || amounts.length === 0) {
      return [];
    }

    const contextLower = context.toLowerCase();
    const classified = [];

    for (let i = 0; i < amounts.length; i++) {
      const amount = amounts[i];
      // Currency-aware sanity check
      if (!this.validateByCurrency(amount, currency)) continue;
      const classification = this.classifySingleAmount(amount, contextLower, i, amounts);

      classified.push({
        value: amount,
        type: classification.type,
        confidence: classification.confidence,
        source: classification.source
      });
    }

    // Post-process to handle conflicts and improve accuracy
    let results = this.resolveClassificationConflicts(classified, contextLower);

    // Drop anything below confidence 0.3
    results = results.filter(r => r.confidence >= 0.3);

    return results;
  }

  validateByCurrency(amount, currency) {
    if (currency === 'INR' && amount > 50000) return false;
    if (currency === 'USD' && amount > 100000) return false;
    return true;
  }

  classifySingleAmount(amount, context, position, allAmounts) {
    const amountStr = amount.toString();
    const scores = {};

    // Calculate scores for each classification type
    Object.entries(this.classificationRules).forEach(([type, rules]) => {
      scores[type] = this.calculateTypeScore(amountStr, context, rules, position, allAmounts);
    });

    // Enhanced keyword matching for better accuracy
    const enhancedScore = this.enhanceScoreWithDirectMatching(amountStr, context, scores);

    // Find the best classification
    const bestType = Object.entries(enhancedScore).reduce((best, [type, score]) => 
      score > best.score ? { type, score } : best
    , { type: 'unknown', score: 0 });

    // Determine confidence based on score and context
    const confidence = this.calculateClassificationConfidence(bestType.score, context, amount);

    return {
      type: bestType.type,
      confidence,
      source: this.findSourceText(amountStr, context)
    };
  }

  enhanceScoreWithDirectMatching(amountStr, context, scores) {
    const enhancedScores = { ...scores };
    const lowerContext = context.toLowerCase();
    
    // Create patterns that directly link labels to amounts
    const directPatterns = [
      { pattern: new RegExp(`total[\\s:]*[^\\d]*${amountStr.replace('.', '\\.')}`, 'i'), type: 'total', boost: 15 },
      { pattern: new RegExp(`paid[\\s:]*[^\\d]*${amountStr.replace('.', '\\.')}`, 'i'), type: 'paid', boost: 15 },
      { pattern: new RegExp(`due[\\s:]*[^\\d]*${amountStr.replace('.', '\\.')}`, 'i'), type: 'due', boost: 15 },
      { pattern: new RegExp(`gst[\\s:]*[^\\d]*${amountStr.replace('.', '\\.')}`, 'i'), type: 'tax', boost: 15 },
      { pattern: new RegExp(`tax[\\s:]*[^\\d]*${amountStr.replace('.', '\\.')}`, 'i'), type: 'tax', boost: 15 },
      { pattern: new RegExp(`discount[\\s:]*[^\\d]*${amountStr.replace('.', '\\.')}`, 'i'), type: 'discount', boost: 15 },
      { pattern: new RegExp(`subtotal[\\s:]*[^\\d]*${amountStr.replace('.', '\\.')}`, 'i'), type: 'subtotal', boost: 12 },
      { pattern: new RegExp(`${amountStr.replace('.', '\\.')}[^\\d]*total`, 'i'), type: 'total', boost: 12 },
      { pattern: new RegExp(`${amountStr.replace('.', '\\.')}[^\\d]*paid`, 'i'), type: 'paid', boost: 12 }
    ];

    // Apply direct pattern matching with high confidence
    directPatterns.forEach(({ pattern, type, boost }) => {
      if (pattern.test(context)) {
        enhancedScores[type] = (enhancedScores[type] || 0) + boost;
      }
    });

    // Special handling for common receipt structures
    const lines = context.split(/[\n\r]+/);
    for (const line of lines) {
      const trimmedLine = line.trim().toLowerCase();
      if (trimmedLine.includes(amountStr.toLowerCase())) {
        // Direct line analysis for better accuracy
        if (/^total[:\s]/.test(trimmedLine)) {
          enhancedScores.total = (enhancedScores.total || 0) + 20;
        } else if (/^paid[:\s]/.test(trimmedLine)) {
          enhancedScores.paid = (enhancedScores.paid || 0) + 20;
        } else if (/^gst[:\s]|^tax[:\s]/.test(trimmedLine)) {
          enhancedScores.tax = (enhancedScores.tax || 0) + 20;
        } else if (/^due[:\s]|^balance[:\s]/.test(trimmedLine)) {
          enhancedScores.due = (enhancedScores.due || 0) + 20;
        } else if (/^discount[:\s]/.test(trimmedLine)) {
          enhancedScores.discount = (enhancedScores.discount || 0) + 20;
        }
      }
    }

    return enhancedScores;
  }

  calculateTypeScore(amountStr, context, rules, position, allAmounts) {
    let score = 0;

    // Strong proximity: keyword directly adjacent to amount
    rules.keywords.forEach(keyword => {
      const match = context.match(new RegExp(`${keyword}\\s*[:]?\\s*${amountStr}`, 'i'));
      if (match) score += rules.priority * 1.5;
    });

    // Keyword matching
    rules.keywords.forEach(keyword => {
      const keywordIndex = context.indexOf(keyword);
      if (keywordIndex !== -1) {
        const amountIndex = context.indexOf(amountStr);
        if (amountIndex !== -1) {
          const distance = Math.abs(keywordIndex - amountIndex);
          score += Math.max(0, rules.priority * (1 - distance / 100));
        } else {
          score += rules.priority * 0.5; // Base score if keyword present
        }
      }
    });

    // Pattern matching
    rules.patterns.forEach(pattern => {
      if (pattern.test(context)) {
        score += rules.priority * 0.8;
      }
    });

    // Position-based heuristics
    score += this.getPositionalScore(position, allAmounts, rules.priority);

    // Amount-based heuristics
    score += this.getAmountBasedScore(parseFloat(amountStr), allAmounts);

    return score;
  }

  getPositionalScore(position, allAmounts, basePriority) {
    const length = allAmounts.length;
    
    // Last amounts often total
    if (position === length - 1 && basePriority >= 8) {
      return 2;
    }
    
    // First amounts often subtotal or item prices
    if (position === 0 && basePriority <= 7) {
      return 1;
    }

    return 0;
  }

  getAmountBasedScore(amount, allAmounts) {
    if (allAmounts.length <= 1) return 0;

    const numericAmounts = allAmounts.map(a => parseFloat(a)).filter(a => !isNaN(a));
    const maxAmount = Math.max(...numericAmounts);
    const minAmount = Math.min(...numericAmounts);

    // Largest amount likely to be total
    if (amount === maxAmount && amount > minAmount * 1.1) {
      return 3;
    }

    // Very small amounts might be taxes or tips
    if (amount < maxAmount * 0.2) {
      return 1;
    }

    return 0;
  }

  calculateClassificationConfidence(score, context, amount) {
    let confidence = Math.min(0.95, score / 20); // normalize to a higher bar

    if (confidence < 0.3) {
      return 0.1; // treat as very low-confidence, maybe "unknown"
    }
    return confidence;
  }

  findSourceText(amountStr, context) {
    const amountIndex = context.indexOf(amountStr);
    if (amountIndex === -1) return `amount: ${amountStr}`;

    const start = Math.max(0, amountIndex - 20);
    const end = Math.min(context.length, amountIndex + amountStr.length + 20);
    
    return context.slice(start, end).trim();
  }

  resolveClassificationConflicts(classified, context) {
    // Keep only one total: largest value, highest confidence
    const totals = classified.filter(c => c.type === 'total');
    if (totals.length > 1) {
      const mainTotal = totals.reduce((max, current) =>
        (current.value > max.value && current.confidence >= max.confidence) ? current : max
      );
      totals.forEach(total => {
        if (total !== mainTotal) {
          total.type = 'subtotal';
          total.confidence = Math.min(total.confidence, 0.5);
        }
      });
    }

    // Ensure paid <= total
    const total = classified.find(c => c.type === 'total');
    const paid = classified.find(c => c.type === 'paid');
    
    if (total && paid && paid.value > total.value) {
      // Swap if paid amount is larger (likely misclassified)
      [total.type, paid.type] = [paid.type, total.type];
    }

    // Calculate due amount if missing but have total and paid
    if (total && paid && !classified.find(c => c.type === 'due')) {
      const dueAmount = total.value - paid.value;
      if (dueAmount > 0.01) { // Only add positive due amounts (avoid tiny rounding errors)
        classified.push({
          value: Math.round(dueAmount * 100) / 100, // Round to 2 decimal places
          type: 'due',
          confidence: 0.8,
          source: 'calculated: total - paid'
        });
      }
    }

    // Cap confidence for multiple discounts
    const discounts = classified.filter(c => c.type === 'discount');
    if (discounts.length > 1) {
      discounts.forEach(d => { d.confidence = Math.min(d.confidence, 0.5); });
    }

    return classified.sort((a, b) => b.confidence - a.confidence);
  }

  calculateConfidence(classifiedAmounts) {
    if (!Array.isArray(classifiedAmounts) || classifiedAmounts.length === 0) {
      return 0;
    }

    const totalConfidence = classifiedAmounts.reduce((sum, item) => 
      sum + (item.confidence || 0), 0
    );

    const averageConfidence = totalConfidence / classifiedAmounts.length;

    // Bonus for having key amount types
    const hasTotal = classifiedAmounts.some(item => item.type === 'total');
    const hasPaid = classifiedAmounts.some(item => item.type === 'paid');
    
    let bonus = 0;
    if (hasTotal) bonus += 0.1;
    if (hasPaid) bonus += 0.1;

    return Math.min(0.99, averageConfidence + bonus);
  }

  // Advanced classification for specific receipt formats
  classifyReceiptFormat(amounts, fullText) {
    const lines = fullText.split('\n').map(line => line.trim());
    const results = [];

    amounts.forEach(amount => {
      // Find which line contains this amount
      const containingLine = lines.find(line => 
        line.includes(amount.toString())
      );

      if (containingLine) {
        const lineClassification = this.classifyByLineStructure(containingLine, amount);
        results.push(lineClassification);
      } else {
        // Fallback to general classification
        results.push(this.classifySingleAmount(amount, fullText, 0, amounts));
      }
    });

    return results;
  }

  classifyByLineStructure(line, amount) {
    const lineLower = line.toLowerCase();
    
    // Common receipt line patterns
    const patterns = [
      { pattern: /^.*total.*:?\s*[\d,\.]+$/i, type: 'total', confidence: 0.9 },
      { pattern: /^.*paid.*:?\s*[\d,\.]+$/i, type: 'paid', confidence: 0.85 },
      { pattern: /^.*due.*:?\s*[\d,\.]+$/i, type: 'due', confidence: 0.85 },
      { pattern: /^.*tax.*:?\s*[\d,\.]+$/i, type: 'tax', confidence: 0.8 },
      { pattern: /^.*discount.*:?\s*[\d,\.]+$/i, type: 'discount', confidence: 0.8 }
    ];

    for (const { pattern, type, confidence } of patterns) {
      if (pattern.test(line)) {
        return {
          type,
          confidence,
          source: `line: "${line.trim()}"`
        };
      }
    }

    return {
      type: 'item',
      confidence: 0.6,
      source: `line: "${line.trim()}"`
    };
  }
}

module.exports = new ClassificationService();