import http from 'http';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import crypto from 'crypto'; // Import crypto for hashing
import { AvailableSignal, MetricSignal } from '../types.js';
import { currentEmotionKeys, dynamicSignals, baseMetricKeysMap, reloadDynamicSignals } from './state.js';
import { pool } from './db.js'; // Import pool for DB operations

// Path Setup
const PROJECT_ROOT = process.cwd();
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

// --- Helper Function to Read Request Body ---
async function readRequestBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
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

// --- Helper Function to Create Hash --- 
function createSimpleHash(input: string): string {
    return crypto.createHash('sha1').update(input).digest('hex').substring(0, 8);
}

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
        } else if (req.url === '/api/filters' && req.method === 'POST') {
            let client = null;
            try {
                const body = await readRequestBody(req);
                const { baseMetricKey, language, keywords } = body;

                // Basic Validation
                if (!baseMetricKey || typeof baseMetricKey !== 'string' || !language || typeof language !== 'string' || !keywords || typeof keywords !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing or invalid fields: baseMetricKey, language, and keywords are required.' }));
                    return;
                }
                if (keywords.trim().length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Keywords cannot be empty.' }));
                    return;
                }
                // TODO: Add validation for language code format/existence?
                // TODO: Add validation for baseMetricKey existence?

                // Prepare keywords structure and hash
                const keywordsList = keywords.toLowerCase().split(/\s+/).filter(k => k.length > 0); // Split by whitespace, lowercase, remove empty
                const keywordsJson = { include: keywordsList }; 
                const keywordsString = keywordsList.sort().join(','); // Normalize for hashing/comparison
                const keywordHash = createSimpleHash(keywordsString);

                // Generate unique filter name
                const filterName = `filter_${baseMetricKey}_${language}_${keywordHash}`;

                client = await pool.connect();

                const checkResult = await client.query(
                    `SELECT id, name, keywords_json, description, is_active, base_metric_key, filter_language_code
                     FROM complex_keyword_filters
                     WHERE name = $1`,
                    [filterName]
                );

                if (checkResult.rowCount !== null && checkResult.rowCount > 0) {
                    const existingFilter = checkResult.rows[0];
                    console.log(`Filter '${filterName}' already exists (ID: ${existingFilter.id}). Returning existing definition.`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(existingFilter));
                } else {
                    // Insert new filter
                    console.log(`Creating new filter: '${filterName}'`);
                    const insertResult = await client.query(
                        `INSERT INTO complex_keyword_filters (name, keywords_json, base_metric_key, filter_language_code, is_active, description)
                         VALUES ($1, $2, $3, $4, TRUE, $5)
                         RETURNING id, name, keywords_json, description, is_active, base_metric_key, filter_language_code`,
                        [filterName, JSON.stringify(keywordsJson), baseMetricKey, language, `Filter for ${baseMetricKey} in ${language} with keywords: ${keywords}`]
                    );
                    const newFilter = insertResult.rows[0];

                    // Reload dynamic signals state asynchronously (don't wait for it)
                    reloadDynamicSignals().catch(err => {
                         console.error("Error during background reload of dynamic signals:", err);
                    }); 

                    res.writeHead(201, { 'Content-Type': 'application/json' }); // 201 Created
                    res.end(JSON.stringify(newFilter));
                    console.log(`Created new filter '${filterName}' (ID: ${newFilter.id})`);
                }

            } catch (error: any) {
                console.error('Error processing POST /api/filters:', error.message || error);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                }
                res.end(JSON.stringify({ error: 'Internal Server Error', detail: error.message }));
            } finally {
                client?.release();
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