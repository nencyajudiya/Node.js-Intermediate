import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import zlib from "zlib";
import crypto from "crypto";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// __dirname replacement for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, "public");

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".webp", "image/webp"],
]);

function safeResolveFromPublic(requestUrl) {
  // Remove query/hash, normalize, prevent path traversal
  const urlPath = requestUrl.split("?")[0].split("#")[0];
  const rawPath = urlPath === "/" ? "/index.html" : urlPath;
  const normalizedPath = path.normalize(rawPath).replace(/^\\+|^\/+/, "");
  const resolved = path.join(publicDir, normalizedPath);
  if (!resolved.startsWith(publicDir)) {
    return null; // Attempted path traversal
  }
  return resolved;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return contentTypes.get(ext) || "application/octet-stream";
}

function computeEtag(stat) {
  const etagBase = `${stat.ino}-${stat.size}-${stat.mtimeMs}`;
  return 'W/"' + crypto.createHash("sha1").update(etagBase).digest("hex") + '"';
}

function selectCompression(acceptEncoding) {
  if (!acceptEncoding) return null;
  if (acceptEncoding.includes("br")) return { enc: "br", stream: zlib.createBrotliCompress() };
  if (acceptEncoding.includes("gzip")) return { enc: "gzip", stream: zlib.createGzip() };
  if (acceptEncoding.includes("deflate")) return { enc: "deflate", stream: zlib.createDeflate() };
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    // Simple API route
    if (req.url === "/api/health") {
      const body = JSON.stringify({ status: "ok", uptimeSec: process.uptime() });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    const resolvedPath = safeResolveFromPublic(req.url || "/");
    if (!resolvedPath) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return;
    }

    // If directory is requested, serve index.html inside it
    let filePath = resolvedPath;
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
        stat = await fs.promises.stat(filePath);
      }
    } catch (e) {
      // Not found -> serve 404 page if available
      const notFoundPath = path.join(publicDir, "404.html");
      try {
        const nf = await fs.promises.readFile(notFoundPath);
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(nf);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
      }
      return;
    }

    const contentType = getContentType(filePath);

    // Conditional caching
    const etag = computeEtag(stat);
    const lastModified = stat.mtime.toUTCString();
    if (req.headers["if-none-match"] === etag || req.headers["if-modified-since"] === lastModified) {
      res.writeHead(304);
      res.end();
      return;
    }

    // Set headers
    const headers = {
      "Content-Type": contentType,
      "Last-Modified": lastModified,
      ETag: etag,
    };

    // Cache static assets for 1 hour, but not HTML to avoid staleness
    if (contentType.startsWith("text/html")) {
      headers["Cache-Control"] = "no-cache";
    } else {
      headers["Cache-Control"] = "public, max-age=3600, immutable";
    }

    const acceptEncoding = String(req.headers["accept-encoding"] || "");
    const compression = selectCompression(acceptEncoding);

    // Stream file (efficient memory usage)
    const readStream = fs.createReadStream(filePath);

    // Handle basic stream errors
    readStream.on("error", () => {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server Error");
    });

    if (compression) {
      headers["Content-Encoding"] = compression.enc;
      // Do not send Content-Length when compressing (unknown beforehand)
      res.writeHead(200, headers);
      readStream.pipe(compression.stream).pipe(res);
    } else {
      headers["Content-Length"] = stat.size;
      res.writeHead(200, headers);
      readStream.pipe(res);
    }
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
