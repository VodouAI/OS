/**
 * Files API — serve local files (images, screenshots) to the chat UI
 * Security: only serves files with allowed extensions, validates no directory traversal
 */
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
const router = Router();
const ALLOWED_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico',
    '.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt',
    '.odt', '.ods', '.odp', '.rtf',
    '.mp3', '.wav', '.m4a', '.ogg', '.flac',
    '.mp4', '.mov', '.webm',
    '.zip', '.tar', '.gz',
]);
const MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.doc': 'application/msword',
    '.xls': 'application/vnd.ms-excel',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.rtf': 'application/rtf',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.zip': 'application/zip',
};
// GET /api/files?path=/absolute/path/to/file.png
router.get('/', (req, res) => {
    try {
        const filePath = req.query.path;
        if (!filePath || typeof filePath !== 'string') {
            res.status(400).json({ error: 'path query parameter is required' });
            return;
        }
        // Must be absolute path
        if (!path.isAbsolute(filePath)) {
            res.status(400).json({ error: 'path must be absolute' });
            return;
        }
        // Resolve to prevent directory traversal
        const resolved = path.resolve(filePath);
        if (resolved !== filePath.replace(/\/+$/, '')) {
            res.status(403).json({ error: 'invalid path' });
            return;
        }
        // Check extension
        const ext = path.extname(resolved).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) {
            res.status(403).json({ error: `file type ${ext} not allowed` });
            return;
        }
        // Check file exists
        if (!fs.existsSync(resolved)) {
            res.status(404).json({ error: 'file not found' });
            return;
        }
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
            res.status(400).json({ error: 'not a file' });
            return;
        }
        // Serve the file
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Cache-Control', 'private, max-age=300');
        fs.createReadStream(resolved).pipe(res);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// POST /api/files/upload — save a base64 file to /tmp for serving
router.post('/upload', (req, res) => {
    try {
        const { name, data } = req.body;
        if (!name || !data) {
            res.status(400).json({ error: 'name and data are required' });
            return;
        }
        // Accept any base64 data URI (image, pdf, document, audio, video, etc.)
        const match = data.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
            res.status(400).json({ error: 'invalid data URI (expected data:<mime>;base64,...)' });
            return;
        }
        // Sanitize filename
        const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const timestamp = Date.now();
        const filename = `vodou-drop-${timestamp}-${safeName}`;
        const filePath = path.join('/tmp', filename);
        // Write the file
        const buffer = Buffer.from(match[2], 'base64');
        fs.writeFileSync(filePath, buffer);
        console.error(`[Files] Saved dropped file: ${filePath} (${buffer.length} bytes, ${match[1]})`);
        res.json({ path: filePath, size: buffer.length });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
export { router as filesRouter };
