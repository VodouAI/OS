import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { open as openDb } from './db.js';
const OUTPUT_DIR = '/tmp/vodou-dalle';
// Resolve paths relative to this file's location
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVERS_DIR = path.resolve(__dirname, '../..'); // MCP-servers/
const GATEWAY_DB_PATH = path.join(SERVERS_DIR, 'Vodou-Console', 'gateway.db');
const VC_DB_PATH = path.resolve(SERVERS_DIR, '..', 'vodou-core.db');
export class DalleServer {
    client = null;
    constructor() {
        // Ensure output directory exists
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }
    }
    getApiKey() {
        // 1. Check environment variable
        if (process.env.OPENAI_API_KEY) {
            return process.env.OPENAI_API_KEY;
        }
        // 2. Check gateway.db settings
        try {
            const dbPath = GATEWAY_DB_PATH;
            console.error(`[dalle] Looking for gateway.db at: ${dbPath}`);
            if (fs.existsSync(dbPath)) {
                const db = openDb(dbPath, { readOnly: true });
                const row = db.prepare('SELECT value FROM gateway_settings WHERE key = ?').get('openai_api_key');
                db.close();
                if (row?.value) {
                    console.error('[dalle] Found OpenAI API key in gateway.db');
                    return row.value;
                }
            }
        }
        catch (err) {
            console.error(`[dalle] Could not read gateway.db: ${err}`);
        }
        // 3. Check vodou-core.db (alternative location)
        try {
            const vcDbPath = VC_DB_PATH;
            if (fs.existsSync(vcDbPath)) {
                const db = openDb(vcDbPath, { readOnly: true });
                try {
                    const row = db.prepare("SELECT value FROM settings WHERE key = 'openai_api_key'").get();
                    if (row?.value) {
                        db.close();
                        console.error('[dalle] Found OpenAI API key in vodou-core.db');
                        return row.value;
                    }
                }
                catch { /* table may not exist */ }
                db.close();
            }
        }
        catch (err) {
            console.error(`[dalle] Could not read vodou-core.db: ${err}`);
        }
        throw new Error('OpenAI API key not found. Set it in Vodou web dashboard settings or OPENAI_API_KEY environment variable.');
    }
    getClient() {
        if (!this.client) {
            const apiKey = this.getApiKey();
            this.client = new OpenAI({ apiKey });
        }
        return this.client;
    }
    generateFilename(prefix = 'dalle') {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        return `${prefix}_${timestamp}.png`;
    }
    async generateImage(options) {
        const client = this.getClient();
        console.error(`[dalle] Generating image: "${options.prompt.slice(0, 80)}..." (${options.model}, ${options.size}, ${options.quality})`);
        const response = await client.images.generate({
            model: options.model,
            prompt: options.prompt,
            n: 1,
            size: options.size,
            quality: options.quality,
            style: options.model === 'dall-e-3' ? options.style : undefined,
            response_format: 'b64_json',
        });
        const data = response.data;
        if (!data || !data[0]?.b64_json) {
            throw new Error('No image data returned from DALL-E API');
        }
        const imageData = data[0];
        // Save to disk
        const filename = this.generateFilename('gen');
        const savePath = options.save_path || path.join(OUTPUT_DIR, filename);
        const saveDir = path.dirname(savePath);
        if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true });
        }
        const buffer = Buffer.from(imageData.b64_json, 'base64');
        fs.writeFileSync(savePath, buffer);
        console.error(`[dalle] Image saved: ${savePath} (${(buffer.length / 1024).toFixed(0)}KB)`);
        return {
            metadata: {
                file_path: savePath,
                prompt: options.prompt,
                revised_prompt: imageData.revised_prompt,
                model: options.model,
                size: options.size,
                quality: options.quality,
                style: options.style,
                created_at: new Date().toISOString(),
            },
            base64: imageData.b64_json,
        };
    }
    async editImage(options) {
        const client = this.getClient();
        if (!fs.existsSync(options.image_path)) {
            throw new Error(`Source image not found: ${options.image_path}`);
        }
        console.error(`[dalle] Editing image: ${options.image_path}`);
        const imageFile = fs.createReadStream(options.image_path);
        const maskFile = options.mask_path ? fs.createReadStream(options.mask_path) : undefined;
        const params = {
            model: 'dall-e-2',
            image: imageFile,
            prompt: options.prompt,
            n: 1,
            size: options.size,
            response_format: 'b64_json',
        };
        if (maskFile) {
            params.mask = maskFile;
        }
        const response = await client.images.edit(params);
        const editData = response.data;
        if (!editData || !editData[0]?.b64_json) {
            throw new Error('No image data returned from DALL-E edit API');
        }
        const imageData = editData[0];
        const filename = this.generateFilename('edit');
        const savePath = options.save_path || path.join(OUTPUT_DIR, filename);
        const saveDir = path.dirname(savePath);
        if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true });
        }
        const buffer = Buffer.from(imageData.b64_json, 'base64');
        fs.writeFileSync(savePath, buffer);
        console.error(`[dalle] Edited image saved: ${savePath}`);
        return {
            metadata: {
                file_path: savePath,
                prompt: options.prompt,
                revised_prompt: imageData.revised_prompt,
                model: 'dall-e-2',
                size: options.size,
                quality: 'standard',
                style: 'natural',
                created_at: new Date().toISOString(),
            },
            base64: imageData.b64_json,
        };
    }
    async createVariation(options) {
        const client = this.getClient();
        if (!fs.existsSync(options.image_path)) {
            throw new Error(`Source image not found: ${options.image_path}`);
        }
        console.error(`[dalle] Creating ${options.n} variation(s) of: ${options.image_path}`);
        const imageFile = fs.createReadStream(options.image_path);
        const response = await client.images.createVariation({
            model: 'dall-e-2',
            image: imageFile,
            n: options.n,
            size: options.size,
            response_format: 'b64_json',
        });
        const results = [];
        const varData = response.data || [];
        for (let i = 0; i < varData.length; i++) {
            const imageData = varData[i];
            if (!imageData?.b64_json)
                continue;
            const filename = this.generateFilename(`var_${i + 1}`);
            const saveDir = options.save_path || OUTPUT_DIR;
            if (!fs.existsSync(saveDir)) {
                fs.mkdirSync(saveDir, { recursive: true });
            }
            const savePath = path.join(saveDir, filename);
            const buffer = Buffer.from(imageData.b64_json, 'base64');
            fs.writeFileSync(savePath, buffer);
            results.push({
                file_path: savePath,
                created_at: new Date().toISOString(),
            });
        }
        console.error(`[dalle] Created ${results.length} variations`);
        return { images: results };
    }
    listGeneratedImages(limit = 20) {
        if (!fs.existsSync(OUTPUT_DIR)) {
            return { images: [] };
        }
        const files = fs.readdirSync(OUTPUT_DIR)
            .filter(f => f.endsWith('.png'))
            .map(f => {
            const fullPath = path.join(OUTPUT_DIR, f);
            const stats = fs.statSync(fullPath);
            return {
                file_path: fullPath,
                size_kb: Math.round(stats.size / 1024),
                modified: stats.mtime.toISOString(),
            };
        })
            .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
            .slice(0, limit);
        return { images: files };
    }
}
//# sourceMappingURL=dalle-server.js.map