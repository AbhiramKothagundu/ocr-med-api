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

      expect(response.body.status).toBe('success');
      expect(response.body.data).toHaveProperty('tokens');
      expect(response.body.data).toHaveProperty('currency');
      expect(response.body.data).toHaveProperty('confidence');
      expect(response.body.data.currency).toBe('INR');
    });

    it('should handle empty text input', async () => {
      const response = await request(app)
        .post('/api/extract')
        .send({ text: '' })
        .expect(400);

      expect(response.body.status).toBe('no_text_found');
    });

    it('should handle text with no amounts', async () => {
      const response = await request(app)
        .post('/api/extract')
        .send({ text: 'This is just a plain text without any numbers' })
        .expect(400);

      expect(response.body.status).toBe('no_amounts_found');
    });

    it('should reject invalid input', async () => {
      const response = await request(app)
        .post('/api/extract')
        .send({})
        .expect(400);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('required');
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

      expect(response.body.status).toBe('success');
      expect(response.body.data.normalized).toEqual([1250, 1300, 125]);
      expect(response.body.data.confidence).toBeGreaterThan(0);
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

      expect(response.body.data.normalized).toContain(0.15);
      expect(response.body.data.normalized).toContain(1250);
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

      expect(response.body.status).toBe('success');
      expect(response.body.data.classified).toHaveLength(3);
      
      const total = response.body.data.classified.find(item => item.type === 'total');
      const paid = response.body.data.classified.find(item => item.type === 'paid');
      const tax = response.body.data.classified.find(item => item.type === 'tax');
      
      expect(total).toBeDefined();
      expect(paid).toBeDefined();
      expect(tax).toBeDefined();
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

      expect(response.body.status).toBe('success');
      expect(response.body.data.classified).toHaveLength(2);
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

      expect(response.body.status).toBe('success');
      expect(response.body.data).toHaveProperty('docId');
      expect(response.body.data).toHaveProperty('amounts');
      expect(response.body.data).toHaveProperty('confidence');
      expect(response.body.data).toHaveProperty('provenance');
      expect(response.body.data.currency).toBe('INR');
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

      expect(response.body.status).toBe('success');
      expect(response.body.data.amounts.length).toBeGreaterThan(5);
      
      const total = response.body.data.amounts.find(a => a.type === 'total');
      const paid = response.body.data.amounts.find(a => a.type === 'paid');
      const tax = response.body.data.amounts.find(a => a.type === 'tax');
      
      expect(total?.value).toBe(1024);
      expect(paid?.value).toBe(1050);
      expect(tax?.value).toBe(144);
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