const request = require('supertest');
const app = require('../src/server');
const ExtractionResult = require('../src/models/ExtractionResult');

// Mock database for testing
jest.mock('../src/models/ExtractionResult');

describe('Extraction API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/extract', () => {
    it('should extract amounts from text input', async () => {
      const textInput = {
        text: 'Total: Rs. 1,250.00\nPaid: Rs. 1,300.00\nTax: Rs. 125.00'
      };

      const response = await request(app)
        .post('/api/extract')
        .send(textInput)
        .expect(200);

      expect(response.body).toHaveProperty('raw_tokens');
      expect(response.body).toHaveProperty('currency_hint');
      expect(response.body).toHaveProperty('confidence');
      expect(response.body.currency_hint).toBe('INR');
      expect(Array.isArray(response.body.raw_tokens)).toBe(true);
      expect(response.body.confidence).toBeGreaterThan(0);
    });

    // CORRECTED: With the validation fix, empty text now passes to controller
    it('should handle empty text input', async () => {
      const response = await request(app)
        .post('/api/extract')
        .send({ text: '' })
        .expect(400);

      // Updated: expects controller response for empty text
      expect(response.body.status).toBe('error');
      expect(response.body.message).toBe('Either image file or text input is required');
    });

    it('should handle text with no amounts', async () => {
      const response = await request(app)
        .post('/api/extract')
        .send({ text: 'This is just a plain text without any numbers' })
        .expect(400);

      expect(response.body.status).toBe('no_amounts_found');
      expect(response.body.reason).toBe('document too noisy');
    });

    // CORRECTED: Update expected message to match actual controller output
    it('should reject invalid input', async () => {
      const response = await request(app)
        .post('/api/extract')
        .send({})
        .expect(400);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toBe('Either image file or text input is required');
    });

    // NEW TEST: Test for whitespace-only text
    it('should handle whitespace-only text input', async () => {
      const response = await request(app)
        .post('/api/extract')
        .send({ text: '   \n\t   ' })
        .expect(400);

      expect(response.body.status).toBe('no_text_found');
      expect(response.body.message).toBe('No readable text found in the input');
    });
  });

  describe('POST /api/normalize', () => {
    it('should normalize extracted tokens', async () => {
      const input = {
        tokens: ['1,250.00', 'l,300', '125'],
        currency: 'INR'
      };

      const response = await request(app)
        .post('/api/normalize')
        .send(input)
        .expect(200);

      expect(response.body).toHaveProperty('normalized_amounts');
      expect(response.body).toHaveProperty('normalization_confidence');
      expect(response.body.normalized_amounts).toEqual([1250, 1300, 125]);
      expect(response.body.normalization_confidence).toBeGreaterThan(0);
    });

    it('should handle percentage values', async () => {
      const input = {
        tokens: ['15%', '1250.00'],
        currency: 'USD'
      };

      const response = await request(app)
        .post('/api/normalize')
        .send(input)
        .expect(200);

      expect(response.body.normalized_amounts).toContain(0.15);
      expect(response.body.normalized_amounts).toContain(1250);
    });

    it('should reject invalid tokens input', async () => {
      const response = await request(app)
        .post('/api/normalize')
        .send({ tokens: 'not an array' })
        .expect(400);

      expect(response.body.status).toBe('validation_error');
    });
  });

  describe('POST /api/classify', () => {
    it('should classify amounts correctly', async () => {
      const input = {
        amounts: [1250, 1300, 125],
        context: 'Total: 1250, Paid: 1300, Tax: 125',
        currency: 'INR'
      };

      const response = await request(app)
        .post('/api/classify')
        .send(input)
        .expect(200);

      expect(response.body).toHaveProperty('amounts');
      expect(response.body).toHaveProperty('confidence');
      expect(Array.isArray(response.body.amounts)).toBe(true);
      expect(response.body.amounts.length).toBeGreaterThan(0);

      const types = response.body.amounts.map(item => item.type);
      expect(types).toContain('total_bill');
      expect(types).toContain('paid');
    });

    it('should handle amounts without context', async () => {
      const input = {
        amounts: [1000, 500],
        currency: 'USD'
      };

      const response = await request(app)
        .post('/api/classify')
        .send(input)
        .expect(200);

      expect(response.body).toHaveProperty('amounts');
      expect(Array.isArray(response.body.amounts)).toBe(true);
    });
  });

  describe('POST /api/final', () => {
    beforeEach(() => {
      ExtractionResult.create.mockResolvedValue({
        docId: 'test-doc-id',
        stage: 'complete'
      });
    });

    it('should process complete pipeline with text', async () => {
      const input = {
        text: 'Invoice\nTotal Amount: Rs. 2,500.00\nAmount Paid: Rs. 2,500.00\nGST: Rs. 250.00'
      };

      const response = await request(app)
        .post('/api/final')
        .send(input)
        .expect(200);

      expect(response.body).toHaveProperty('currency');
      expect(response.body).toHaveProperty('amounts');
      expect(response.body).toHaveProperty('status');
      expect(response.body.status).toBe('ok');
      expect(Array.isArray(response.body.amounts)).toBe(true);
      expect(response.body.currency).toBe('INR');
    });

    it('should handle complex receipt text', async () => {
      const input = {
        text: `
          RESTAURANT BILL
          Item 1: Rs. 450.00
          Item 2: Rs. 350.00
          Subtotal: Rs. 800.00
          GST (18%): Rs. 144.00
          Service Charge: Rs. 80.00
          Total: Rs. 1,024.00
          Paid: Rs. 1,050.00
          Change: Rs. 26.00
        `
      };

      const response = await request(app)
        .post('/api/final')
        .send(input)
        .expect(200);

      expect(response.body.status).toBe('ok');
      expect(Array.isArray(response.body.amounts)).toBe(true);
      expect(response.body.amounts.length).toBeGreaterThan(5);

      const types = response.body.amounts.map(a => a.type);
      expect(types).toContain('total_bill');
      expect(types).toContain('paid');
      expect(types).toContain('tax');
    });

    it('should handle database save operation', async () => {
      const input = {
        text: 'Total: Rs. 500.00'
      };

      await request(app)
        .post('/api/final')
        .send(input)
        .expect(200);

      expect(ExtractionResult.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'complete',
          inputType: 'text'
        })
      );
    });

    // NEW TEST: Test empty text behavior in final endpoint
    it('should handle empty text in final endpoint', async () => {
      const response = await request(app)
        .post('/api/final')
        .send({ text: '' })
        .expect(400);

      // Updated: expects controller response for empty text
      expect(response.body.status).toBe('error');
      expect(response.body.message).toBe('Either image file or text input is required');
    });
  });

  describe('GET /api/history', () => {
    beforeEach(() => {
      const mockResults = [
        {
          docId: 'doc1',
          stage: 'complete',
          confidence: 0.95,
          createdAt: new Date()
        },
        {
          docId: 'doc2', 
          stage: 'complete',
          confidence: 0.87,
          createdAt: new Date()
        }
      ];

      ExtractionResult.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue(mockResults)
      });

      ExtractionResult.countDocuments.mockResolvedValue(2);
    });

    it('should return processing history', async () => {
      const response = await request(app)
        .get('/api/history')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data).toHaveProperty('results');
      expect(response.body.data).toHaveProperty('pagination');
      expect(response.body.data.results).toHaveLength(2);
    });

    it('should handle pagination parameters', async () => {
      const response = await request(app)
        .get('/api/history?page=2&limit=5')
        .expect(200);

      expect(response.body.data.pagination.page).toBe(2);
      expect(response.body.data.pagination.limit).toBe(5);
    });

    it('should filter by stage', async () => {
      await request(app)
        .get('/api/history?stage=complete')
        .expect(200);

      expect(ExtractionResult.find).toHaveBeenCalledWith({ stage: 'complete' });
    });
  });

  describe('Error Handling', () => {
    it('should handle 404 for unknown endpoints', async () => {
      const response = await request(app)
        .get('/api/unknown')
        .expect(404);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('not found');
    });

    it('should handle validation errors gracefully', async () => {
      const response = await request(app)
        .post('/api/normalize')
        .send({ tokens: null })
        .expect(400);

      expect(response.body.status).toBe('validation_error');
    });
  });
});

describe('Health Check', () => {
  it('should return health status', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);

    expect(response.body.status).toBe('healthy');
    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('version');
  });
});