const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { runImport } = require('./import');

const app = express();
const PORT = 3000;

const UPLOADS_DIR = process.env.ELECTRON_USER_DATA
  ? path.join(process.env.ELECTRON_USER_DATA, 'uploads')
  : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const jobId = randomUUID();
    req.jobId = jobId;
    cb(null, `${jobId}.xlsx`);
  },
});
const upload = multer({ storage, fileFilter: (req, file, cb) => {
  cb(null, file.mimetype.includes('spreadsheet') || file.originalname.endsWith('.xlsx'));
}});

// In-memory job store: jobId -> { status, logs, outputFile }
const jobs = {};

// SSE helper
function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { email, password, site, kategorieCol, neuerProduktnameCol, amazonUrlCol } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const jobId = req.jobId || path.basename(req.file.filename, '.xlsx');
  jobs[jobId] = { status: 'pending', logs: [], outputFile: req.file.path };

  console.log('[server] column config received:', { kategorieCol, neuerProduktnameCol, amazonUrlCol });

  res.json({ jobId });

  const excelPath = req.file.path;
  const credentials = {
    email,
    password,
    site: site || '',
    kategorieCol: kategorieCol || '',
    neuerProduktnameCol: neuerProduktnameCol || '',
    amazonUrlCol: amazonUrlCol || '',
  };

  runImport(excelPath, credentials, (msg) => {
    jobs[jobId].logs.push(msg);
  }).then(({ outputFile }) => {
    jobs[jobId].status = 'done';
    jobs[jobId].outputFile = outputFile;
  }).catch((e) => {
    jobs[jobId].status = 'error';
    jobs[jobId].logs.push(`Fatal error: ${e.message}`);
  });
});

// SSE stream — client polls for new log lines
app.get('/stream/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let sent = 0;

  const interval = setInterval(() => {
    // Send any new log lines
    while (sent < job.logs.length) {
      sendEvent(res, 'log', { line: job.logs[sent] });
      sent++;
    }

    if (job.status === 'done') {
      sendEvent(res, 'done', { jobId: req.params.jobId });
      clearInterval(interval);
      res.end();
    } else if (job.status === 'error') {
      sendEvent(res, 'error', { jobId: req.params.jobId });
      clearInterval(interval);
      res.end();
    }
  }, 300);

  req.on('close', () => clearInterval(interval));
});

app.get('/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !job.outputFile) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: 'Job not finished yet' });

  res.download(job.outputFile, 'amazon-prod-results.xlsx');
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\nEvolup Importer UI running at http://localhost:${PORT}\n`);
});
