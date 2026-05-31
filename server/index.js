import express    from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { setupWSS } from './wss.js';
import * as db from './db.js';
import { mkdirSync } from 'fs';
import { readdir, stat, unlink } from 'fs/promises';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { existsSync, readFileSync } from 'fs';
import { createServer as createHTTPS }
  from 'https';
import { createServer as createHTTP }
  from 'http';

const __dir = dirname(fileURLToPath(import.meta.url));
const app    = express();

// ── File storage ───────────────────────────────────────
const UPLOAD_DIR = join(__dir, '../uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg','image/png','image/gif',
  'image/webp','image/svg+xml','image/bmp',
  // Video
  'video/mp4','video/webm','video/ogg',
  // Audio
  'audio/mpeg','audio/ogg','audio/wav',
  'audio/webm',
  // Documents
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument' +
    '.wordprocessingml.document',
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) =>
    cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Sanitise extension — only allow safe ones
    const ext = path.extname(
      file.originalname).toLowerCase();
    const SAFE_EXTS = new Set([
      '.jpg','.jpeg','.png','.gif','.webp',
      '.svg','.mp4','.webm','.ogv','.mp3',
      '.ogg','.wav','.pdf','.zip','.txt',
      '.doc','.docx','.bmp'
    ]);
    const safeExt = SAFE_EXTS.has(ext) ? ext : '.bin';
    cb(null, uuid() + safeExt);
  }
});

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.has(file.mimetype))
    cb(null, true);
  else
    cb(new Error(
      `File type not allowed: ${file.mimetype}`),
      false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB
    files: 1
  }
});

// Delete files older than 30 days
async function cleanUploads() {
  try {
    const files = await readdir(UPLOAD_DIR);
    const cutoff = Date.now() -
                   30 * 24 * 60 * 60 * 1000;

    for (const f of files) {
      const fp = join(UPLOAD_DIR, f);
      let s;
      try { s = await stat(fp); }
      catch { continue; }

      // Only consider files older than 30 days
      if (s.mtimeMs >= cutoff) continue;

      // Check if this file is still referenced
      // in any message in the DB
      const fileUrl = `/uploads/${f}`;
      const ref = db.isFileReferenced(fileUrl);
      if (ref) {
        // File is still in use — skip
        continue;
      }

      await unlink(fp);
      console.log(`[cleanup] Deleted: ${f}`);
    }
  } catch (err) {
    console.error('[cleanup] Error:', err.message);
  }
}

cleanUploads();
setInterval(cleanUploads, 24 * 60 * 60 * 1000);

// Clean expired sessions every hour
setInterval(() => {
  db.cleanExpiredSessions();
}, 60 * 60 * 1000);

// ── Upload endpoint ────────────────────────────────────
// Limit HTTP requests (file uploads)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max:      100,
  message:  { error: 'Too many requests' }
});
app.use(limiter);

// Stricter limit for uploads
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max:      20,
  message:  { error: 'Upload rate limit exceeded' }
});

// Auth check via query param userId (set after login)
// Better error handling for upload endpoint
app.post('/upload',
  uploadLimiter,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE')
          return res.status(413).json({
            error: 'File exceeds 1GB limit'
          });
        return res.status(400).json({
          error: err.message
        });
      }
      if (err)
        return res.status(400).json({
          error: err.message
        });
      next();
    });
  },
  (req, res) => {
    if (!req.file)
      return res.status(400).json({
        error: 'No file uploaded'
      });
    res.json({
      ok:       true,
      url:      `/uploads/${req.file.filename}`,
      filename: req.file.originalname
                  .slice(0, 255), // cap length
      size:     req.file.size,
      mimetype: req.file.mimetype
    });
  }
);

// Serve uploaded files
app.use('/uploads',
  express.static(UPLOAD_DIR));

// Serve static client files
app.use(express.static(join(__dir, '../client')));

app.use((req, res) =>
  res.sendFile(join(__dir, '../client/index.html')));

const certPath = join(__dir, '../cert.pem');
const keyPath  = join(__dir, '../key.pem');
const useHTTPS = existsSync(certPath) &&
                 existsSync(keyPath);
const PORT = 6967;
const proto = useHTTPS ? 'https' : 'http';

const server = useHTTPS
  ? createHTTPS({
      cert: readFileSync(certPath),
      key:  readFileSync(keyPath)
    }, app)
  : createHTTP(app);

setupWSS(server);



server.listen(PORT, '0.0.0.0', () =>
  console.log(
    `SecureChat on ${proto}://0.0.0.0:${PORT}\n` +
    `HTTPS: ${useHTTPS ? 'YES ✓' : 'NO - not secure'}`
  ));