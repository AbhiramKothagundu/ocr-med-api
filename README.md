# OCR Medical Receipt Extraction API

Extract, normalize, and classify amounts from medical receipts using OCR and AI.

## Setup Instructions

1. **Clone the repository:**
   ```bash
   git clone https://github.com/AbhiramKothagundu/ocr-med-api.git
   cd ocr_med_api
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   - Copy `.env.example` to `.env` and adjust as needed.

4. **Start MongoDB:**
   - Ensure MongoDB is running locally (`mongodb://localhost:27017/receipt-extractor` by default).

5. **Run the server:**
   ```bash
   npm run dev
   # or for production
   npm start
   ```

## Running Locally

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   - Copy `.env.example` to `.env` and update as needed.

3. **Start MongoDB (if not running):**
   ```bash
   mongod
   ```

4. **Start the server:**
   ```bash
   npm start
   ```
   The API will run on `http://localhost:3000`.

## Expose Local Server with ngrok

1. **Install ngrok:**
   - Download from [ngrok.com](https://ngrok.com/download) or install via npm:
     ```bash
     npm install -g ngrok
     ```

2. **Expose your local API:**
   ```bash
   ngrok http 3000
   ```
   - You will get a public URL (e.g., `https://abcd1234.ngrok.io`) that forwards to your local server.

3. **Test your endpoints:**
   - Use the ngrok URL in Postman/curl:
     ```
     curl -X POST https://abcd1234.ngrok.io/api/extract -H "Content-Type: application/json" -d '{"text":"Total: Rs. 1,250.00"}'
     ```

## Architecture Overview

- **Express.js**: Main API server.
- **Mongoose**: MongoDB ODM for storing extraction results.
- **Tesseract.js**: OCR engine for image processing.
- **Services**: Modular services for OCR, normalization, and classification.
- **Controllers**: Handle API logic and chaining.
- **Middleware**: Validation, error handling, logging, and guardrails.
- **Swagger**: API documentation at `/api/docs`.

## Features

- **OCR Extraction**: Extracts text and numeric tokens from images or raw text.
- **Normalization**: Cleans and converts tokens to numeric values.
- **Classification**: Classifies amounts (total, paid, tax, etc.) using context-aware AI.
- **Full Pipeline**: `/api/final` endpoint runs all steps and returns detailed provenance.
- **History & Retrieval**: Query processed documents and history.
- **Guardrails & Error Handling**: Input validation, file type/size checks, and structured error responses.
- **Swagger Docs**: Interactive API documentation at `/api/docs`.

## API Endpoints

| Endpoint         | Method | Description                                 |
|------------------|--------|---------------------------------------------|
| `/api/extract`   | POST   | Extract numeric tokens from image/text      |
| `/api/normalize` | POST   | Normalize extracted tokens                  |
| `/api/classify`  | POST   | Classify normalized amounts                 |
| `/api/final`     | POST   | Complete pipeline (extract, normalize, classify) |
| `/api/history`   | GET    | Get paginated processing history            |
| `/api/history/:id` | GET  | Get document by docId                       |
| `/api/docs`      | GET    | Swagger API documentation                   |

## Usage Examples

### 1. Extract

```bash
curl -X POST http://localhost:3000/api/extract -F "image=@receipt.jpg"
curl -X POST http://localhost:3000/api/extract -H "Content-Type: application/json" -d '{"text":"Total: Rs. 500.00"}'
```

### 2. Normalize

```bash
curl -X POST http://localhost:3000/api/normalize -H "Content-Type: application/json" -d '{"tokens":["500.00","125"]}'
```

### 3. Classify

```bash
curl -X POST http://localhost:3000/api/classify -H "Content-Type: application/json" -d '{"amounts":[500,125],"context":"Total: 500, Tax: 125"}'
```

### 4. Complete Pipeline

```bash
curl -X POST http://localhost:3000/api/final -F "image=@receipt.jpg"
curl -X POST http://localhost:3000/api/final -H "Content-Type: application/json" -d '{"text":"Total: Rs. 500.00"}'
```

### 5. History

```bash
curl -X GET http://localhost:3000/api/history
curl -X GET http://localhost:3000/api/history/{docId}
```

### 6. Swagger Docs

Visit [http://localhost:3000/api/docs](http://localhost:3000/api/docs) in your browser.

## Testing

- **Run all tests:**
  ```bash
  npm test
  ```
- **Test coverage:**
  ```bash
  npm run test:coverage
  ```
- **Watch mode:**
  ```bash
  npm run test:watch
  ```

## Error Handling & Guardrails

- All endpoints validate input and file types/sizes.
- Errors return structured JSON responses with status and message.
- See `.env.example` for configuration options.

## Screen Recording

- Please submit a short screen recording showing your endpoints working with sample inputs (text and image).

## License

MIT

## Author

Abhiram Kothagundu
