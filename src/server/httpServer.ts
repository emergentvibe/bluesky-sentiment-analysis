import http from 'http';
// Removed fs, path, mime, crypto, pool, reloadDynamicSignals as they are no longer used.
// Removed AvailableSignal. Kept MetricSignal as it might be used by imported state.
import { MetricSignal } from '../types.js';
// Removed state imports as no API endpoints use them currently.
// import { currentEmotionKeys, dynamicSignals, baseMetricKeysMap } from './state.js';

// --- Helper Function to Read Request Body (Potentially useful for future APIs) ---
async function readRequestBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                // Handle empty body case
                if (body.trim() === '') {
                    resolve({}); // Resolve with empty object for empty body
                    return;
                }
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('Invalid JSON in request body'));
            }
        });
        req.on('error', (err) => {
            reject(err);
        });
    });
}

// Create and export the HTTP server instance
export const server = http.createServer(async (req, res) => {
    if (!req.url) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: URL is missing');
        return;
    }
    console.log(`HTTP Request: ${req.method} ${req.url}`);

    // --- API Endpoint Handling ---
    // No API endpoints are currently active.
    if (req.url.startsWith('/api/')) {
        console.log('Request to API endpoint, but none are active.');
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('API Endpoint Not Found');
        return; // Important: Return after handling API path
    }

    // --- Fallback for Non-API Requests ---
    // Static file serving has been removed.
    console.log('Request did not match API path, returning 404.');
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});