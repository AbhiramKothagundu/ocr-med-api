const express = require('express');
const multer = require('multer');
const extractionController = require('../controllers/extractionController');
const { validateInput } = require('../middleware/validation');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('../../swagger.json');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images are allowed.'), false);
    }
  }
});

// Individual pipeline endpoints
router.post('/extract', upload.single('image'), validateInput, extractionController.extract);
router.post('/normalize', validateInput, extractionController.normalize);
router.post('/classify', validateInput, extractionController.classify);

// Complete pipeline endpoint
router.post('/final', upload.single('image'), validateInput, extractionController.processComplete);

// Get processing history
router.get('/history', extractionController.getHistory);
router.get('/history/:id', extractionController.getById);

// Swagger docs endpoint
router.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

module.exports = router;