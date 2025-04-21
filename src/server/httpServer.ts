import http from 'http';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { AvailableSignal } from '../types.js';
import { currentEmotionKeys, dynamicSignals, baseMetricKeysMap } from './state.js';

// Path Setup
const PROJECT_ROOT = process.cwd();
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

// Create and export the HTTP server instance
export const server = http.createServer(async (req, res) => {
    if (!req.url) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: URL is missing');
        return;
    }
    console.log(`HTTP Request: ${req.method} ${req.url}`);

    // API Endpoint Handling
    if (req.url.startsWith('/api/')) {
        if (req.url === '/api/metrics' && req.method === 'GET') {
            try {
                const emotionMetricNames = currentEmotionKeys;
                const filterSignals = dynamicSignals;
                const responsePayload: AvailableSignal[] = [];

                emotionMetricNames.forEach(name => {
                    responsePayload.push({ id: name, name: name, type: 'metric' });
                });

                filterSignals.forEach(signal => {
                    if (!baseMetricKeysMap.has(signal.name.toLowerCase())) {
                         responsePayload.push({ id: signal.id, name: signal.name, type: 'filter' });
                    } else {
                        console.warn(`Filter signal name "${signal.name}" conflicts with base metric. Skipping.`);
                    }
                });

                responsePayload.sort((a, b) => a.name.localeCompare(b.name));

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(responsePayload));
                console.log(`Served /api/metrics with ${responsePayload.length} signals`);
            } catch (error: any) {
                console.error('Error serving /api/metrics:', error.message || error);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
            }
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('API Endpoint Not Found');
        }
        return;
    }

    // Static File Serving
    const safeSuffix = path.normalize(req.url).replace(/^(\.\.[\/\\])+/, '');
    let requestedPath = path.join(PUBLIC_DIR, safeSuffix);

    if (safeSuffix === '/' || safeSuffix === '' || !path.extname(requestedPath)) {
        requestedPath = path.join(PUBLIC_DIR, 'index.html');
    }

    const resolvedPath = path.resolve(requestedPath);
    if (!resolvedPath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    fs.readFile(resolvedPath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                if (!path.extname(safeSuffix)) {
                    const indexPath = path.join(PUBLIC_DIR, 'index.html');
                    fs.readFile(indexPath, (indexError, indexContent) => {
                        if (indexError) {
                            console.error(`Error serving index.html fallback for ${safeSuffix}: ${indexError}`);
                            res.writeHead(404, { 'Content-Type': 'text/plain' });
                            res.end('Not Found');
                        } else {
                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(indexContent, 'utf-8');
                        }
                    });
                } else {
                    console.warn(`Static file not found: ${resolvedPath}`);
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                }
            } else {
                console.error(`Server error reading file ${resolvedPath}:`, error);
                res.writeHead(500);
                res.end('Internal Server Error');
            }
        } else {
            const contentType = mime.lookup(resolvedPath) || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
}); 