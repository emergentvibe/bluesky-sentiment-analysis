import 'dotenv/config'; // Load .env file variables

// Corrected/Default Imports
import FirehoseSubscription from './firehose.js'; // Import the CLASS
import { AppBskyFeedPost } from '@atproto/api'; // Remove direct Commit import for now
import { franc } from 'franc';
// @ts-ignore - Suppress incorrect "not exported" error
import { analyzeSentiment } from './sentiment.js';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import pg, { PoolClient, QueryResult } from 'pg';
const { Pool } = pg;
import { AggregatedScoreEntry, LiveUpdateEntry, MetricSignal, HistoryEntry, LiveUpdateMessage, RequestHistoryMessage, HistoryDataMessage, ClientMessage, CommitData, AvailableSignal, WindowState, RawDbEntry, SentimentScores } from './types.js'; // Make sure SentimentScores is imported

// Top-level state
let dynamicSignals: MetricSignal[] = [];
let currentEmotionKeys: string[] = []; // Global list of emotion keys from DB
let currentIntervalScores: { [lang: string]: { [signalName: string]: SentimentScores } } = {}; // Accumulator per lang -> signal
let currentIntervalPostCount: { [lang: string]: { [signalName: string]: number } } = {}; // Accumulator per lang -> signal
let recentHistoryBuffer: { [lang: string]: { [signalName: string]: HistoryEntry[] } } = {}; // Buffer per lang -> signal
let liveMAState: { [lang: string]: { [signalName: string]: { short: WindowState; long: WindowState } } } = {}; // MA state per lang -> signal

// Constants (Keep the first block, remove the second one later)
const AGGREGATION_INTERVAL_MS = parseInt(process.env.AGGREGATION_INTERVAL_MS || '10000', 10); // 10 seconds default (adjust if needed)
// Calculate window points based on MS constants
const SHORT_AVG_WINDOW_POINTS = Math.max(1, Math.round(parseInt(process.env.SHORT_AVG_WINDOW_MS || (5 * 60 * 1000).toString(), 10) / AGGREGATION_INTERVAL_MS));
const LONG_AVG_WINDOW_POINTS = Math.max(1, Math.round(parseInt(process.env.LONG_AVG_WINDOW_MS || (60 * 60 * 1000).toString(), 10) / AGGREGATION_INTERVAL_MS));

const DEFAULT_METRIC_KEYS = ['positive', 'negative', 'anger', 'disgust', 'fear', 'joy', 'sadness', 'surprise', 'anticipation', 'trust']; // Default keys (lowercase)
const LIVE_UPDATE_BUFFER_MS = parseInt(process.env.LONG_AVG_WINDOW_MS || (60 * 60 * 1000).toString(), 10) + (5 * 60 * 1000); // Buffer slightly larger than longest MA window


// --- Database Setup ---
// Validate that the DATABASE_URL environment variable is set.
if (!process.env.DATABASE_URL) {
    console.error('CRITICAL: DATABASE_URL environment variable is not set.');
    process.exit(1);
}

// Create a PostgreSQL connection pool using the DATABASE_URL.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Fly.io may require SSL depending on the network, but the internal connection string usually disables it.
    // Enable it if you encounter connection issues:
    // ssl: {
    //   rejectUnauthorized: false // Required for self-signed certs often used internally
    // }
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

// --- Database Functions ---

/**
 * Initializes the PostgreSQL database.
 * Ensures the necessary tables exist with the correct schema and indexes.
 * @async
 * @throws {Error} If database connection or query execution fails.
 */
async function initializeDatabase() {
    console.log('Initializing database...');
    const client: PoolClient = await pool.connect();
    try {
        // Ensure sentiment_data table exists
        await client.query(`
            CREATE TABLE IF NOT EXISTS sentiment_data (
                timestamp TIMESTAMPTZ NOT NULL,
                language VARCHAR(10) NOT NULL,
                scores JSONB NOT NULL,
                post_count INTEGER NOT NULL
                -- Primary key initially might be just timestamp, language
                -- PRIMARY KEY (timestamp, language)
            );
        `);
        console.log('Table "sentiment_data" exists.');

        // Add signal_name column if it doesn't exist
        await client.query(`
            ALTER TABLE sentiment_data
            ADD COLUMN IF NOT EXISTS signal_name VARCHAR(100) NOT NULL DEFAULT 'default';
        `);
        console.log('Column "signal_name" ensured in sentiment_data.');

        // Drop existing primary key if it exists (handle potential errors if PK name is different)
        try {
             await client.query(`ALTER TABLE sentiment_data DROP CONSTRAINT IF EXISTS sentiment_data_pkey;`);
             console.log('Dropped existing primary key constraint (if it existed).');
        } catch (pkError: any) {
             // Ignore errors if the constraint doesn't exist or has a different name
             // A more robust solution might query information_schema to find the exact PK name
             console.warn(`Could not drop primary key 'sentiment_data_pkey' (may not exist or different name): ${pkError.message}`);
        }

        // Add the new composite primary key including signal_name
        await client.query(`
            ALTER TABLE sentiment_data
            ADD CONSTRAINT sentiment_data_pkey PRIMARY KEY (timestamp, language, signal_name);
        `);
        console.log('Ensured primary key on (timestamp, language, signal_name).');

        // Index on timestamp is still useful for time-based queries
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sentiment_data_timestamp ON sentiment_data (timestamp DESC);`);
        console.log('Index "idx_sentiment_data_timestamp" ensured.');

        // Complex Keyword Filters Table (Task 15.8.1)
        await client.query(`
            CREATE TABLE IF NOT EXISTS complex_keyword_filters (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                description TEXT,
                keywords_json JSONB NOT NULL, -- Store keywords as JSON { "include": [...], "exclude": [...] }
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Table "complex_keyword_filters" ensured.');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_complex_filters_active ON complex_keyword_filters (is_active);`);
        console.log('Index "idx_complex_filters_active" ensured.');


    } catch (err: any) {
        console.error('Database initialization failed:', err.message || err);
        process.exit(1);
    } finally {
        client.release();
    }
}

/**
 * Loads all emotion keys (names) from the lexicon_emotions table.
 */
async function loadEmotionKeysFromDB(): Promise<string[]> {
    console.log('Loading emotion keys from database...');
    const client: PoolClient = await pool.connect();
    try {
        const queryResult = await client.query('SELECT emotion_name FROM lexicon_emotions ORDER BY emotion_name ASC');
        const keys = queryResult.rows.map(row => row.emotion_name);
        console.log(`Loaded ${keys.length} emotion keys: ${keys.join(', ')}`);
        return keys;
    } catch (err: any) {
        console.error('Error loading emotion keys from database:', err.message || err);
        // Fallback to defaults if DB load fails?
        console.warn('Falling back to default emotion keys due to DB error.');
        return [...DEFAULT_METRIC_KEYS]; // Use a copy
    } finally {
        client.release();
    }
}

/**
 * Loads active dynamic signals (complex keyword filters) from the database.
 * @async
 * @returns {Promise<MetricSignal[]>} A promise resolving to an array of active signals.
 * @throws {Error} If database query fails.
 */
async function loadDynamicSignalsFromDB(): Promise<MetricSignal[]> {
    console.log('Loading dynamic signals from database...');
    const client: PoolClient = await pool.connect();
    try {
        const queryResult: QueryResult<MetricSignal> = await client.query(
            `SELECT id, name, keywords_json, description, is_active
             FROM complex_keyword_filters
             WHERE is_active = TRUE
             ORDER BY name ASC`
        );
        console.log(`Loaded ${queryResult.rowCount} active dynamic signals.`);
        // Basic validation (example: check if keywords_json is valid JSON)
        return queryResult.rows.map(row => {
             // Define the type for MetricSignal based on the DB schema
             const signal: MetricSignal = {
                 id: row.id,
                 name: row.name,
                 keywords_json: row.keywords_json, // Assuming keywords_json is directly usable or parsed later
                 description: row.description,
                 is_active: row.is_active,
                 type: 'filter' // Explicitly mark as filter type
             };
            try {
                // Attempt to parse the JSON to ensure it's valid, handle if stored as string
                 if (typeof signal.keywords_json === 'string') {
                    JSON.parse(signal.keywords_json);
                 } else if (typeof signal.keywords_json !== 'object' || signal.keywords_json === null) {
                     throw new Error('keywords_json is not a valid object');
                 }
                 // You might add more specific validation based on expected structure { include: [], exclude: [] }
                return signal;
            } catch (e: any) {
                console.error(`Invalid JSON in keywords_json for signal id ${signal.id} (${signal.name}): ${e.message}. Skipping.`);
                return null; // Filter out invalid ones
            }
        }).filter((row): row is MetricSignal => row !== null); // Type guard to filter out nulls
    } catch (err: any) {
        console.error('Error loading dynamic signals from database:', err.message || err);
        return []; // Return empty array on error
    } finally {
        client.release();
    }
}


// --- Path Setup ---
// Use process.cwd() for more reliable path resolution
const PROJECT_ROOT = process.cwd();
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

// --- HTTP Server ---
// ... (existing HTTP server creation code - Ensure static file serving is correct) ...
const server = http.createServer(async (req, res) => {
    if (!req.url) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: URL is missing');
        return;
    }
    console.log(`HTTP Request: ${req.method} ${req.url}`); // Log request

    // --- API Endpoint Handling (BEFORE static files) ---
    if (req.url.startsWith('/api/')) {
        if (req.url === '/api/metrics' && req.method === 'GET') {
            try {
                // Combine dynamically loaded emotion keys and active filter names
                const emotionMetricNames = currentEmotionKeys.map(k => k.toLowerCase()); // Use loaded keys
                const filterSignalNames = dynamicSignals.map(s => s.name.toLowerCase()); // Use loaded active filters

                const allSignalNames = [...new Set([...emotionMetricNames, ...filterSignalNames])]; // Ensure uniqueness

                 // Structure the response
                 const responsePayload: AvailableSignal[] = allSignalNames.map(name => {
                     const dynamicSignal = dynamicSignals.find(s => s.name.toLowerCase() === name);
                     const isEmotionMetric = emotionMetricNames.includes(name);

                     let signalType: 'metric' | 'filter' = 'metric'; // Default to metric
                     let signalId: string | number = name; // Default ID is name for metrics

                     if (dynamicSignal) {
                         signalType = 'filter';
                         signalId = dynamicSignal.id;
                     } else if (!isEmotionMetric) {
                         // This case should ideally not happen if all names come from the two sources
                         // but handle it just in case.
                         console.warn(`Signal name '${name}' found but is neither a loaded emotion nor an active filter.`);
                         // Skip this unknown signal or assign a default type/id
                         // return null; // Option: skip
                     }

                     return {
                         id: signalId,
                         name: name, // Return the original case name? For now, lowercase consistent
                         type: signalType
                     };
                 }).filter((signal): signal is AvailableSignal => signal !== null); // Filter out any nulls if skipping unknowns


                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(responsePayload));
                console.log(`Served /api/metrics with ${responsePayload.length} signals`);
            } catch (error: any) {
                console.error('Error fetching dynamic metrics:', error.message || error);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
            }
        } else {
            // Handle other potential /api routes or return 404
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('API Endpoint Not Found');
        }
        return; // End processing for API requests
    }


    // --- Static File Serving (Refined) ---
    // Basic security: Prevent path traversal, normalize URL
    const safeSuffix = path.normalize(req.url).replace(/^(\.\.[\/\\])+/, '');
    let requestedPath = path.join(PUBLIC_DIR, safeSuffix);

    // Default to index.html if requesting root or a directory
    if (safeSuffix === '/' || safeSuffix === '' || !path.extname(requestedPath)) {
        requestedPath = path.join(PUBLIC_DIR, 'index.html');
    }

    // Ensure the resolved path is still within the public directory
    const resolvedPath = path.resolve(requestedPath);
    if (!resolvedPath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }


    fs.readFile(resolvedPath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                 // If the original request didn't have an extension (was likely a directory/SPA route)
                 // try serving index.html as a fallback for SPA routing
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
                            console.log(`Served index.html for SPA route: ${safeSuffix}`);
                         }
                    });
                } else {
                    // If it had an extension and wasn't found, it's a genuine 404
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
            // File found, serve it with correct MIME type
            const contentType = mime.lookup(resolvedPath) || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
            // console.log(`Served static file: ${resolvedPath}`); // Can be verbose
        }
    });
});


// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ noServer: true }); // Don't let it create its own HTTP server

// --- WebSocket Connection Handling (moved handleWebSocketConnection here) ---

/**
 * Handles a new WebSocket connection.
 * Sets up message listeners and cleanup logic.
 * @param {WebSocket} ws The WebSocket connection instance.
 */
async function handleWebSocketConnection(ws: WebSocket): Promise<void> {
    console.log('Client connected via WebSocket');
    // Initial history load is triggered by client 'requestHistory' message.

    ws.on('message', async (message: Buffer) => {
        let parsedMessage: ClientMessage;
        try {
            parsedMessage = JSON.parse(message.toString());
            console.log('Received WebSocket message:', parsedMessage.type);

            // --- Handle History Request ---
            if (parsedMessage.type === 'requestHistory') {
                const { languages, timeWindowMs, desiredIntervalMs, signalNames } = parsedMessage.payload;

                // Correct Validation: Check all expected fields including signalNames
                if (!Array.isArray(languages) || typeof timeWindowMs !== 'number' || timeWindowMs <= 0 ||
                    typeof desiredIntervalMs !== 'number' || desiredIntervalMs <= 0 ||
                    !Array.isArray(signalNames)) {
                    console.warn('Invalid requestHistory payload structure or values:', parsedMessage.payload);
                    ws.send(JSON.stringify({ type: 'error', payload: 'Invalid history request format' }));
                    return;
                }

                // Handle empty signalNames gracefully (send empty response)
                if (signalNames.length === 0) {
                    console.log("requestHistory received with no signalNames. Sending empty results.");
                    const emptyResponse: HistoryDataMessage = { type: 'historyData', payload: { signalLangData: {} } };
                    ws.send(JSON.stringify(emptyResponse));
                    return;
                }

                const endTime = new Date();
                const startTime = new Date(endTime.getTime() - timeWindowMs);

                console.log(`Handling requestHistory for signals [${signalNames.join(',')}] & languages [${languages.join(',')}] from ${startTime.toISOString()} to ${endTime.toISOString()}`);

                // 1. Fetch and Aggregate Data
                // NOTE: getAggregatedData currently only uses languages. Needs update to handle signalNames if filters affect aggregation source.
                // For now, we fetch based on language and *later* associate with signal names.
                const aggregatedDataByLang = await getAggregatedData(languages, startTime, endTime, desiredIntervalMs);

                // 2. Calculate MAs
                const dataWithMAsByLang = calculateMAsForAggregatedData(aggregatedDataByLang, desiredIntervalMs, parseInt(process.env.SHORT_AVG_WINDOW_MS || (5 * 60 * 1000).toString(), 10), parseInt(process.env.LONG_AVG_WINDOW_MS || (60 * 60 * 1000).toString(), 10));

                // 3. Format the data for response (signalLangKey structure)
                const signalLangDataPayload: { [signalLangKey: string]: HistoryEntry[] } = {};
                signalNames.forEach(signalName => {
                     languages.forEach(langCode => {
                         const signalLangKey = `${signalName}_${langCode}`;
                         const langData = dataWithMAsByLang.get(langCode);
                         if (langData) {
                             // Assign the MA-calculated data for this language to the signalLangKey
                             signalLangDataPayload[signalLangKey] = langData;
                         } else {
                              signalLangDataPayload[signalLangKey] = []; // Assign empty array if no data for this lang
                         }
                     });
                 });


                const response: HistoryDataMessage = {
                    type: 'historyData',
                    payload: { signalLangData: signalLangDataPayload }
                };

                ws.send(JSON.stringify(response), (err) => {
                    if (err) console.error('Error sending historyData to client:', err);
                    else console.log(`Sent historyData for signals [${signalNames.join(',')}] & langs [${languages.join(',')}] to client.`);
                });
            } else {
                 console.log(`Received unhandled message type: ${parsedMessage.type}`);
            }

        } catch (err: any) {
            console.error('Failed to parse client message or process request:', err.message || err);
            ws.send(JSON.stringify({ type: 'error', payload: 'Server error processing message' }));
        }
    });

    ws.on('close', () => {
        console.log('WebSocket client disconnected');
    });

    ws.on('error', (error: Error) => {
        console.error('WebSocket client error:', error);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }
    });
}

// --- Re-add HTTP Server Upgrade Handler ---
server.on('upgrade', (request, socket, head) => {
    // Ensure the request is for the WebSocket endpoint (e.g., /ws or root)
    // Adjust pathname check if your frontend uses a different path
    const pathname = request.url;
    if (pathname === '/ws' || !pathname) { // Handle root path or /ws
        wss.handleUpgrade(request, socket, head, (ws) => {
            // Connection successful, emit the connection event to be handled
            wss.emit('connection', ws, request);
        });
    } else {
        console.log(`Rejecting WebSocket upgrade request for unexpected path: ${pathname}`);
        socket.destroy(); // Close the connection for non-WebSocket paths
    }
});

// --- Setup WebSocket connection listener AFTER defining the handler ---
wss.on('connection', handleWebSocketConnection);


// --- Other Helper Functions (broadcast, scores, MAs, firehose, aggregation) ---

/**
 * Broadcasts data to all connected WebSocket clients.
 */
function broadcast(data: any): void {
    const jsonData = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(jsonData, (err) => {
                if (err) {
                    console.error('WebSocket send error:', err);
                }
            });
        }
    });
}

/**
 * Creates an empty SentimentScores object with all current keys initialized to 0.
 * Uses the globally loaded currentEmotionKeys.
 */
function createEmptyScores(): SentimentScores {
    const scores: SentimentScores = {};
    for (const key of currentEmotionKeys) {
        scores[key.toLowerCase()] = 0; // Ensure keys are lowercase
    }
    // Include default base metrics if not already present (e.g., positive, negative)
    for (const key of DEFAULT_METRIC_KEYS) {
         if (!(key in scores)) {
              scores[key] = 0;
         }
    }
    return scores;
}

/**
 * Adds the values from source SentimentScores to target SentimentScores.
 * Iterates over the globally loaded currentEmotionKeys.
 */
function addScores(target: SentimentScores, source: SentimentScores): void {
    for (const key of currentEmotionKeys) {
        const lowerKey = key.toLowerCase();
        target[lowerKey] = (target[lowerKey] || 0) + (source[lowerKey] || 0);
    }
     // Include default base metrics
     for (const key of DEFAULT_METRIC_KEYS) {
          if (!(key in target)) target[key] = 0; // Ensure key exists
          target[key] += (source[key] || 0);
     }
}

/**
 * Subtracts the values from source SentimentScores from target SentimentScores.
 * Iterates over the globally loaded currentEmotionKeys.
 */
function subtractScores(target: SentimentScores, source: SentimentScores): void {
    for (const key of currentEmotionKeys) {
        const lowerKey = key.toLowerCase();
        target[lowerKey] = (target[lowerKey] || 0) - (source[lowerKey] || 0);
    }
     // Include default base metrics
     for (const key of DEFAULT_METRIC_KEYS) {
          if (!(key in target)) target[key] = 0; // Ensure key exists
          target[key] -= (source[key] || 0);
     }
}

/** Updates incremental MA window state and returns new average. */
function updateIncrementalWindowState(state: WindowState, newEntry: HistoryEntry): SentimentScores | null {
    if (!state.summedScores) state.summedScores = createEmptyScores();
    if (newEntry.scores) {
        addScores(state.summedScores, newEntry.scores);
    }
    state.summedPostCount += newEntry.postCount;
    state.queue.push(newEntry);

    if (state.queue.length > state.windowPoints) {
        const oldEntry = state.queue.shift();
        if (oldEntry?.scores) {
             subtractScores(state.summedScores, oldEntry.scores);
             state.summedPostCount -= oldEntry.postCount;
        }
    }

    if (state.queue.length > 0 && state.summedPostCount > 0) {
        const avgScores = createEmptyScores(); // Initialize with all current keys
        // Iterate using the keys from the dynamically created avgScores object
        for (const key in avgScores) {
             if (Object.prototype.hasOwnProperty.call(avgScores, key) && 
                 Object.prototype.hasOwnProperty.call(state.summedScores, key)) 
             {
                 // Direct assignment since key is guaranteed to exist in both
                 avgScores[key] = state.summedScores[key] / state.summedPostCount;
             }
        }
        return avgScores;
    } else {
        return null;
    }
}

// --- Re-add calculateSentimentMovingAverage ---
/**
 * Calculates moving averages for sentiment scores, weighted by post count.
 * Handles partial windows at the beginning of the data series.
 * @param {HistoryEntry[]} data Array of aggregated data entries (timestamp, scores, postCount).
 * @param {number} windowPoints The number of data points (intervals) in the moving average window.
 * @returns {Array<SentimentScores | null>} An array of the same length containing the calculated
 *          average SentimentScores for each point, or null if the window had zero posts.
 */
function calculateSentimentMovingAverage(data: HistoryEntry[], windowPoints: number): (SentimentScores | null)[] {
     const result: (SentimentScores | null)[] = Array(data.length).fill(null);
     // Use currentEmotionKeys + defaults for iteration, ensuring lowercase
     const keysToAverage = [...new Set([...currentEmotionKeys.map(k => k.toLowerCase()), ...DEFAULT_METRIC_KEYS])];
     const runningSums: SentimentScores = createEmptyScores(); // Initialize dynamically
     let runningCount = 0;
     const windowQueue: HistoryEntry[] = [];

     for (let i = 0; i < data.length; i++) {
         const currentEntry = data[i];
         if (currentEntry.scores) {
            addScores(runningSums, currentEntry.scores); // Uses dynamic addScores
            runningCount += currentEntry.postCount;
         }
         windowQueue.push(currentEntry);

         if (windowQueue.length > windowPoints) {
             const oldestEntry = windowQueue.shift();
             if (oldestEntry?.scores) {
                 subtractScores(runningSums, oldestEntry.scores); // Uses dynamic subtractScores
                 runningCount -= oldestEntry.postCount;
             }
         }

         if (runningCount > 0) {
             const avgScores = createEmptyScores(); // Initialize dynamically
             // Iterate over the combined list of known keys
             keysToAverage.forEach(key => {
                 if (Object.prototype.hasOwnProperty.call(runningSums, key)) {
                     avgScores[key] = runningSums[key] / runningCount;
                 }
             });
             result[i] = avgScores;
         } else {
             result[i] = null;
         }
     }
     return result;
}

// --- Firehose Processing Logic ---

/**
 * Callback function for the FirehoseSubscription.
 * Processes a received post record and its associated commit metadata.
 * Extracts text, detects language, analyzes sentiment, and updates interval accumulators.
 */
async function handleFirehoseRecord(post: AppBskyFeedPost.Record, commit: CommitData): Promise<void> {
    try {
        // Basic validation of the post record
        if (!post || typeof post !== 'object' || !post.text || typeof post.text !== 'string') {
            // Commented out verbose logging
            // console.warn('Skipping invalid post record:', post);
            return;
        }

        const postText = post.text;
        if (postText.trim().length === 0) {
            // Commented out verbose logging
            // console.log('Skipping post with empty text.');
            return;
        }

        // Language Detection
        // TODO: Incorporate post.langs if needed/reliable, but franc is generally preferred
        const langCode = franc(postText, { minLength: 3, ignore: ['und'] });

        if (langCode && langCode !== 'und') {
            // Analyze sentiment (await the result)
            const sentimentScores = await analyzeSentiment(postText, langCode);

            if (sentimentScores === null) {
                // console.log(`Sentiment analysis returned null for lang ${langCode}, text: ${postText.substring(0, 50)}...`);
                return; // Skip if sentiment analysis fails
            }

            // Determine which signals this post matches
            const matchedSignalNames: string[] = ['default']; // Always include default/base metrics

            // --- Evaluate against Dynamic Filters --- TODO: Task 15.8.4
            // Iterate through dynamicSignals loaded from DB
            for (const signal of dynamicSignals) {
                // Basic keyword matching example (replace with proper logic)
                let matches = false;
                if (typeof signal.keywords_json === 'object' && signal.keywords_json !== null) {
                    const keywords = signal.keywords_json as { include?: string[], exclude?: string[] };
                    const includes = keywords.include?.map(k => k.toLowerCase()) || [];
                    const excludes = keywords.exclude?.map(k => k.toLowerCase()) || [];
                    const postLower = postText.toLowerCase();

                    const includesMatch = includes.length === 0 || includes.some(inc => postLower.includes(inc));
                    const excludesMatch = excludes.length > 0 && excludes.some(exc => postLower.includes(exc));

                    if (includesMatch && !excludesMatch) {
                        matches = true;
                    }
                } else {
                     console.warn(`Signal ${signal.name} (ID: ${signal.id}) has invalid keywords_json format. Skipping filter evaluation.`);
                }

                if (matches) {
                    matchedSignalNames.push(signal.name);
                }
            }
            // --- End Filter Evaluation ---

            // Accumulate scores for each matched signal
            for (const signalName of matchedSignalNames) {
                // Initialize language-specific accumulator if needed
                if (!currentIntervalScores[langCode]) {
                    currentIntervalScores[langCode] = {};
                    currentIntervalPostCount[langCode] = {};
                }
                // Initialize signal-specific accumulator if needed
                if (!currentIntervalScores[langCode][signalName]) {
                    currentIntervalScores[langCode][signalName] = createEmptyScores();
                    currentIntervalPostCount[langCode][signalName] = 0;
                }

                // Now sentimentScores is the resolved Record<string, number>
                addScores(currentIntervalScores[langCode][signalName], sentimentScores);
                currentIntervalPostCount[langCode][signalName]++;
            }
        } else {
             // console.log('Unsupported language or undetermined.');
        }

    } catch (error: any) {
        console.error('Error processing firehose record callback:', error.message || error);
        console.error('Post causing error:', JSON.stringify(post).substring(0, 500));
        console.error('Commit causing error:', JSON.stringify(commit).substring(0, 500));
    }
}

// --- Aggregation & Storage Logic ---

/**
 * Aggregates scores accumulated during the interval, stores them in the database,
 * calculates moving averages, updates buffers, and broadcasts live updates.
 */
async function aggregateAndStore(): Promise<void> {
    const timestamp = new Date();
    const bufferCutoffTime = timestamp.getTime() - LIVE_UPDATE_BUFFER_MS;
    const client = await pool.connect();
    let liveUpdates: LiveUpdateEntry[] = [];

    try {
        await client.query('BEGIN');

        // Process accumulated scores for each language and signal accumulator
        for (const langCode in currentIntervalScores) {
            if (!currentIntervalScores.hasOwnProperty(langCode)) continue;

            for (const signalName in currentIntervalScores[langCode]) {
                if (!currentIntervalScores[langCode].hasOwnProperty(signalName)) continue;

                const accumulatedScores = currentIntervalScores[langCode][signalName];
                const postCount = currentIntervalPostCount[langCode][signalName];

                if (postCount > 0) {
                    // Store the aggregated data (associating with the specific signalName)
                    const values = [timestamp, langCode, signalName, JSON.stringify(accumulatedScores), postCount];
                    await client.query(
                        `INSERT INTO sentiment_data (timestamp, language, signal_name, scores, post_count)
                         VALUES ($1, $2, $3, $4, $5)`,
                        values
                    );

                    // --- Live Update Calculation & Buffering ---
                    // Note: MAs are calculated based on the *overall* data for the signalName accumulator
                    const currentRawEntry: HistoryEntry = {
                        timestamp: timestamp.getTime(),
                        scores: accumulatedScores,
                        postCount: postCount
                    };

                    // Initialize MA state if necessary (per langCode -> signalName)
                    if (!liveMAState[langCode]) liveMAState[langCode] = {};
                    if (!liveMAState[langCode][signalName]) {
                        liveMAState[langCode][signalName] = {
                            short: { queue: [], summedScores: createEmptyScores(), summedPostCount: 0, windowPoints: SHORT_AVG_WINDOW_POINTS },
                            long: { queue: [], summedScores: createEmptyScores(), summedPostCount: 0, windowPoints: LONG_AVG_WINDOW_POINTS }
                        };
                    }
                     if (!recentHistoryBuffer[langCode]) recentHistoryBuffer[langCode] = {};
                     if (!recentHistoryBuffer[langCode][signalName]) recentHistoryBuffer[langCode][signalName] = [];

                    // Calculate latest MAs using the state for this specific signal accumulator
                    const latestShortAvg = updateIncrementalWindowState(liveMAState[langCode][signalName].short, currentRawEntry);
                    const latestLongAvg = updateIncrementalWindowState(liveMAState[langCode][signalName].long, currentRawEntry);

                    // Update buffer for this signal accumulator
                     const entryForBuffer = { ...currentRawEntry, shortAvg: latestShortAvg, longAvg: latestLongAvg };
                    recentHistoryBuffer[langCode][signalName].push(entryForBuffer);
                    recentHistoryBuffer[langCode][signalName] = recentHistoryBuffer[langCode][signalName]
                        .filter(entry => entry.timestamp >= bufferCutoffTime)
                        .sort((a, b) => a.timestamp - b.timestamp);

                    // --- Prepare Live Update Payloads --- 
                    // Check if this accumulator was for the 'default' (base metrics)
                    if (signalName === 'default') {
                         // If it's the default accumulator, create an update entry for EACH actual metric key
                         const allMetricKeys = [...new Set([...currentEmotionKeys.map(k => k.toLowerCase()), ...DEFAULT_METRIC_KEYS])];
                         allMetricKeys.forEach(metricKey => {
                            liveUpdates.push({
                                signalName: metricKey, // <<< Use the specific metric key
                                language: langCode,
                                timestamp: currentRawEntry.timestamp,
                                scores: currentRawEntry.scores, // Send the full aggregated scores object
                                postCount: currentRawEntry.postCount,
                                shortAvg: latestShortAvg, // Send the overall short MA for the interval
                                longAvg: latestLongAvg   // Send the overall long MA for the interval
                            });
                         });
                    } else {
                         // If it's a specific filter signal, create one update entry for it
                         liveUpdates.push({
                            signalName: signalName, // <<< Use the filter name
                            language: langCode,
                            timestamp: currentRawEntry.timestamp,
                            scores: currentRawEntry.scores,
                            postCount: currentRawEntry.postCount,
                            shortAvg: latestShortAvg,
                            longAvg: latestLongAvg
                        });
                    }
                }
            }
        }

        await client.query('COMMIT');

        if (liveUpdates.length > 0) {
            const message: LiveUpdateMessage = {
                type: 'liveUpdate',
                payload: { updates: liveUpdates }
            };
            broadcast(message);
            // console.log(`[DEBUG] Broadcasted liveUpdate with ${liveUpdates.length} entries.`);
        }

        currentIntervalScores = {};
        currentIntervalPostCount = {};

        // --- Prune Old Data (Example: Keep ~31 days) ---
        // Needs adjustment based on signal type (sentiment_data vs complex_filter_sentiment_data)
        const PRUNE_AGE_MS = 31 * 24 * 60 * 60 * 1000;
        const pruneTimestamp = new Date(Date.now() - PRUNE_AGE_MS);
        // console.log(`Pruning data older than ${pruneTimestamp.toISOString()}`);
        // await client.query('DELETE FROM sentiment_data WHERE timestamp < $1', [pruneTimestamp]);
        // TODO: Add pruning for complex_filter_sentiment_data table

    } catch (error: any) {
        await client.query('ROLLBACK');
        console.error('Error during aggregation and storage:', error.message || error);
        console.error(error.stack);
    } finally {
        client.release();
    }
}

// --- Server-Side Data Aggregation/Retrieval ---

/**
 * Fetches raw sentiment data and aggregates it.
 */
async function getAggregatedData(
    languages: string[],
    startTime: Date,
    endTime: Date,
    intervalMs: number
): Promise<Map<string, HistoryEntry[]>> {
    console.log(`Aggregating data for ${languages.join(', ')} from ${startTime.toISOString()} to ${endTime.toISOString()} with interval ${intervalMs / 1000}s`);
    const resultByLang = new Map<string, HistoryEntry[]>();
    languages.forEach(lang => resultByLang.set(lang, []));
    const client: PoolClient = await pool.connect();
    try {
        const queryResult: QueryResult<RawDbEntry> = await client.query(
            `SELECT timestamp, language, scores, post_count as "postCount"
             FROM sentiment_data
             WHERE timestamp >= $1 AND timestamp < $2 AND language = ANY($3::VARCHAR[])
             ORDER BY timestamp ASC`,
            [startTime, endTime, languages]
        );
        console.log(` -> Fetched ${queryResult.rowCount} raw rows from DB.`);
        if (queryResult.rowCount === 0) return resultByLang;

        const buckets = new Map<string, { scores: SentimentScores; postCount: number; numPoints: number }>();
        queryResult.rows.forEach((row) => { // row implicitly has RawDbEntry type now
            const bucketTimestamp = Math.floor(row.timestamp.getTime() / intervalMs) * intervalMs;
            const bucketKey = `${row.language}_${bucketTimestamp}`;
            if (!buckets.has(bucketKey)) {
                buckets.set(bucketKey, { scores: createEmptyScores(), postCount: 0, numPoints: 0 });
            }
            const bucket = buckets.get(bucketKey)!;
            // addScores uses Object.keys now
            addScores(bucket.scores, row.scores);
            bucket.postCount += row.postCount;
            bucket.numPoints++;
        });

        buckets.forEach((bucketData, key) => {
            const [lang, tsString] = key.split('_');
            const timestamp = parseInt(tsString, 10);
            const avgScores = createEmptyScores();
            if (bucketData.numPoints > 0) {
                 for (const scoreKey in bucketData.scores) {
                      if (Object.prototype.hasOwnProperty.call(bucketData.scores, scoreKey)){
                          const stringKey = scoreKey as keyof SentimentScores;
                          if (avgScores.hasOwnProperty(stringKey)) {
                              // @ts-ignore - Suppress symbol index error
                              avgScores[stringKey] = Number((bucketData.scores as SentimentScores)[stringKey]) / bucketData.numPoints;
                          }
                      }
                 }
            }
            if (!resultByLang.has(lang)) resultByLang.set(lang, []);
            resultByLang.get(lang)!.push({ timestamp: timestamp, scores: avgScores, postCount: bucketData.postCount });
        });
        resultByLang.forEach(data => data.sort((a, b) => a.timestamp - b.timestamp));
        console.log(` -> Aggregated into buckets for ${resultByLang.size} languages.`);
    } catch (err: any) {
        console.error("Error during getAggregatedData:", err.message || err);
    } finally {
         client.release();
    }
    return resultByLang;
}

/**
 * Calculates MAs for aggregated data.
 */
function calculateMAsForAggregatedData(
    aggregatedData: Map<string, HistoryEntry[]>,
    intervalMs: number,
    shortWindowMs: number,
    longWindowMs: number
): Map<string, HistoryEntry[]> {
     console.log(`Calculating MAs (Short: ${shortWindowMs/60000}m, Long: ${longWindowMs/60000}m)`);
    aggregatedData.forEach((langData, lang) => {
        if (langData.length === 0) return;
        const shortPoints = Math.max(1, Math.round(shortWindowMs / intervalMs));
        const longPoints = Math.max(1, Math.round(longWindowMs / intervalMs));
        const shortMA = calculateSentimentMovingAverage(langData, shortPoints);
        const longMA = calculateSentimentMovingAverage(langData, longPoints);
        for (let i = 0; i < langData.length; i++) {
            langData[i].shortAvg = shortMA[i];
            langData[i].longAvg = longMA[i];
        }
    });
    return aggregatedData;
}


// --- Main Application Entry Point ---

async function main() {
    console.log('Starting Bluesky Sentiment Analysis Server...');

    // Initialize Database FIRST
    await initializeDatabase();

    // Load Dynamic Configuration AFTER DB Init
    dynamicSignals = await loadDynamicSignalsFromDB();
    currentEmotionKeys = await loadEmotionKeysFromDB(); // Load emotion keys into global state

    // Initialize Firehose AFTER loading config
    const firehose = new FirehoseSubscription(process.env.FIREHOSE_SERVICE_URL || 'wss://bsky.network'); // Pass URL directly

    // Start the subscription loop - NO LONGER USES .on('message')
    // Run subscribeToFirehose in the background (don't await it here)
    // The handleFirehoseRecord function is passed directly
    firehose.subscribeToFirehose(handleFirehoseRecord)
        .then(() => {
            console.log("Firehose subscription loop exited normally.");
            // Optional: Handle graceful shutdown or restart logic here?
        })
        .catch(err => {
            console.error("CRITICAL: Firehose subscription loop failed unexpectedly:", err);
            // Decide if the server should exit or attempt to restart the subscription
            process.exit(1); // Exit on critical failure
        });

    console.log('Attempting to connect to Firehose...');

    // Start aggregation timer AFTER DB and Config Load
    setInterval(aggregateAndStore, AGGREGATION_INTERVAL_MS);

    // Start the HTTP/WebSocket server
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server listening on http://localhost:${PORT}`);
        // Note: WebSocket connection is now handled by the 'upgrade' event handler
        // console.log(`WebSocket server listening on ws://localhost:${PORT}`); // This log is implicitly true
    });

    // Graceful Shutdown Handling (Optional but Recommended)
    process.on('SIGINT', () => {
        console.log("\nSIGINT received. Shutting down gracefully...");
        firehose.stop(); // Signal the firehose loop to stop
        server.close(() => {
            console.log('HTTP/WebSocket server closed.');
            pool.end(() => {
                console.log('Database pool closed.');
                process.exit(0);
            });
        });
        // Force exit after a timeout if shutdown hangs
        setTimeout(() => {
            console.error("Graceful shutdown timed out. Forcing exit.");
            process.exit(1);
        }, 10000); // 10 seconds timeout
    });
}

main().catch(err => {
    console.error('Unhandled error during startup:', err);
    process.exit(1);
});

