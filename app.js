import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import crypto from 'crypto';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(morgan('combined'));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

const publicDir = path.join(__dirname, 'public');

const contentTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.ico', 'image/x-icon'],
    ['.webp', 'image/webp'],
]);

function safeResolveFromPublic(requestUrl) {
    const urlPath = requestUrl.split('?')[0].split('#')[0];
    const rawPath = urlPath === '/' ? '/index.html' : urlPath;
    const normalizedPath = path.normalize(rawPath).replace(/^\\+|^\/+/, '');
    const resolved = path.join(publicDir, normalizedPath);
    if (!resolved.startsWith(publicDir)) {
        return null;
    }
    return resolved;
}

function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return contentTypes.get(ext) || 'application/octet-stream';
}

function computeEtag(stat) {
    const etagBase = `${stat.ino}-${stat.size}-${stat.mtimeMs}`;
    return 'W/"' + crypto.createHash('sha1').update(etagBase).digest('hex') + '"';
}

function selectCompression(acceptEncoding) {
    if (!acceptEncoding) return null;
    if (acceptEncoding.includes('br')) return { enc: 'br', stream: zlib.createBrotliCompress() };
    if (acceptEncoding.includes('gzip')) return { enc: 'gzip', stream: zlib.createGzip() };
    if (acceptEncoding.includes('deflate')) return { enc: 'deflate', stream: zlib.createDeflate() };
    return null;
}

app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

app.get('/api/info', (req, res) => {
    res.json({
        name: 'Intermediate Static Server',
        version: '1.0.0',
        features: [
            'Static file serving',
            'Gzip/Brotli compression',
            'ETag caching',
            'Content type detection',
            '404 error handling'
        ]
    });
});

app.use(async (req, res) => {
    try {
        const resolvedPath = safeResolveFromPublic(req.url);
        if (!resolvedPath) {
            return res.status(400).send('Bad Request');
        }

        let filePath = resolvedPath;
        let stat;
        try {
            stat = await fs.promises.stat(filePath);
            if (stat.isDirectory()) {
                filePath = path.join(filePath, 'index.html');
                stat = await fs.promises.stat(filePath);
            }
        } catch (e) {
            const notFoundPath = path.join(publicDir, '404.html');
            try {
                const nf = await fs.promises.readFile(notFoundPath);
                return res.status(404).type('html').send(nf);
            } catch {
                return res.status(404).send('404 Not Found');
            }
        }

        const contentType = getContentType(filePath);
        const etag = computeEtag(stat);
        const lastModified = stat.mtime.toUTCString();

        if (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === lastModified) {
            return res.status(304).end();
        }

        res.set({
            'Content-Type': contentType,
            'Last-Modified': lastModified,
            'ETag': etag,
        });

        if (contentType.startsWith('text/html')) {
            res.set('Cache-Control', 'no-cache');
        } else {
            res.set('Cache-Control', 'public, max-age=3600, immutable');
        }

        const acceptEncoding = String(req.headers['accept-encoding'] || '');
        const compression = selectCompression(acceptEncoding);

        const readStream = fs.createReadStream(filePath);

        readStream.on('error', () => {
            res.status(500).send('Server Error');
        });

        if (compression) {
            res.set('Content-Encoding', compression.enc);
            readStream.pipe(compression.stream).pipe(res);
        } else {
            res.set('Content-Length', stat.size);
            readStream.pipe(res);
        }
    } catch (err) {
        res.status(500).send('Internal Server Error');
    }
});

export default app;
