import 'dotenv/config'; // Load .env file variables

// Corrected/Default Imports
import FirehoseSubscription from './firehose.js'; // Import the CLASS
import { AppBskyFeedPost } from '@atproto/api'; // Remove direct Commit import for now
import { franc } from 'franc';
// @ts-ignore - Suppress incorrect "not exported" error
import { analyzeSentiment, SentimentScores, createEmptyScores } from './sentiment.js';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import pg, { PoolClient, QueryResult } from 'pg';
const { Pool } = pg;
import { AggregatedScoreEntry, LiveUpdateEntry, MetricSignal, HistoryEntry, LiveUpdateMessage, RequestHistoryMessage, HistoryDataMessage, ClientMessage, CommitData, AvailableSignal, WindowState, RawDbEntry } from './types.js'; // Make sure SentimentScores is imported

// Top-level state
let dynamicSignals: MetricSignal[] = [];
let currentIntervalScores: { [lang: string]: SentimentScores } = {}; // Re-add definition
let currentIntervalPostCount: { [lang: string]: number } = {}; // Re-add definition
let recentHistoryBuffer: { [lang: string]: HistoryEntry[] } = {}; // Re-add definition
let liveMAState: { [lang: string]: { short: WindowState; long: WindowState } } = {}; // Re-add definition

// Constants (Keep the first block, remove the second one later)
const AGGREGATION_INTERVAL_MS = parseInt(process.env.AGGREGATION_INTERVAL_MS || '10000', 10); // 10 seconds default (adjust if needed)
// Calculate window points based on MS constants
const SHORT_AVG_WINDOW_POINTS = Math.max(1, Math.round(parseInt(process.env.SHORT_AVG_WINDOW_MS || (5 * 60 * 1000).toString(), 10) / AGGREGATION_INTERVAL_MS));
const LONG_AVG_WINDOW_POINTS = Math.max(1, Math.round(parseInt(process.env.LONG_AVG_WINDOW_MS || (60 * 60 * 1000).toString(), 10) / AGGREGATION_INTERVAL_MS));

const DEFAULT_METRIC_KEYS = ['Positive', 'Negative', 'Neutral', 'Anger', 'Disgust', 'Fear', 'Joy', 'Sadness', 'Surprise'];
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
        // Raw sentiment data table (10s intervals)
        await client.query(`
            CREATE TABLE IF NOT EXISTS sentiment_data (
                timestamp TIMESTAMPTZ NOT NULL,
                language VARCHAR(10) NOT NULL,
                scores JSONB NOT NULL,
                post_count INTEGER NOT NULL,
                PRIMARY KEY (timestamp, language)
            );
        `);
        console.log('Table "sentiment_data" ensured.');
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
                // Use the globally updated dynamicSignals
                const allMetricKeys = [
                    ...DEFAULT_METRIC_KEYS,
                    ...dynamicSignals.map(s => s.name) // Add names from filters/dynamic signals
                ];
                const uniqueMetrics = [...new Set(allMetricKeys)];

                 // Structure the response as expected by the frontend (array of signal objects)
                 const responsePayload: AvailableSignal[] = uniqueMetrics.map(name => {
                     const dynamicSignal = dynamicSignals.find(s => s.name === name);
                     return {
                         // Use dynamic signal ID if available, otherwise use name as ID for defaults
                         id: dynamicSignal ? dynamicSignal.id : name,
                         name: name,
                         // Determine type based on whether it's in dynamicSignals (filter) or default (metric)
                         type: dynamicSignal ? 'filter' : 'metric'
                     };
                 });


                res.writeHead(200, { 'Content-Type': 'application/json' });
                // Send the array of AvailableSignal objects
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

// --- Constants (Remove duplicate block) ---
// Remove this block, use the one defined earlier
// const MINUTE_MS = 60 * 1000;
// const HOUR_MS = 60 * MINUTE_MS;
// const ONE_DAY_MS = 24 * HOUR_MS;
// const ONE_WEEK_MS = 7 * ONE_DAY_MS;
// const ONE_MONTH_MS = 30 * ONE_DAY_MS;
// const MAX_HISTORY_MS = ONE_MONTH_MS;
// const PRUNE_AGE_MS = 31 * ONE_DAY_MS; // Data older than this might be pruned (currently not implemented).
//
// const AGGREGATION_INTERVAL_MS = 10 * 1000; // REMOVE THIS REDECLARATION
//
// const SHORT_AVG_WINDOW_MS = 5 * MINUTE_MS;
// const LONG_AVG_WINDOW_MS = 1 * HOUR_MS;
//
// const LIVE_UPDATE_BUFFER_MS = LONG_AVG_WINDOW_MS + (5 * MINUTE_MS); // REMOVE THIS REDECLARATION

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

// --- WebSocket Message Types ---
// Moved to types.ts

// --- WebSocket Connection Handling ---

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

// --- Data Structures & Helper Functions ---

/** Helper to add scores. Modifies target in place. */
function addScores(target: SentimentScores, source: SentimentScores): void {
    // Revert to for...in with hasOwnProperty check
    for (const key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            const stringKey = key as keyof SentimentScores;
            if (target.hasOwnProperty(stringKey)) {
                target[stringKey] += source[stringKey];
            }
        }
    }
}

/** Helper to subtract scores. Modifies target in place. */
function subtractScores(target: SentimentScores, source: SentimentScores): void {
    // Revert to for...in with hasOwnProperty check
    for (const key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            const stringKey = key as keyof SentimentScores;
            if (target.hasOwnProperty(stringKey)) {
                target[stringKey] -= source[stringKey];
            }
        }
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
        const avgScores = createEmptyScores();
        for (const key in avgScores) {
             if (Object.prototype.hasOwnProperty.call(avgScores, key)) {
                 const stringKey = key as keyof SentimentScores;
                 if (state.summedScores?.hasOwnProperty(stringKey)) {
                      // @ts-ignore - Suppress symbol index error
                      avgScores[stringKey] = (state.summedScores as SentimentScores)[stringKey] / state.summedPostCount;
                 }
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
     const categories = Object.keys(createEmptyScores()) as (keyof SentimentScores)[]; // Keep using Object.keys for known categories
     const runningSums: SentimentScores = createEmptyScores();
     let runningCount = 0;
     const windowQueue: HistoryEntry[] = [];

     for (let i = 0; i < data.length; i++) {
         const currentEntry = data[i];
         // Ensure currentEntry.scores exists before adding
         if (currentEntry.scores) {
            addScores(runningSums, currentEntry.scores);
            runningCount += currentEntry.postCount;
         }
         windowQueue.push(currentEntry);

         if (windowQueue.length > windowPoints) {
             const oldestEntry = windowQueue.shift();
             // Ensure oldestEntry and its scores exist before subtracting
             if (oldestEntry?.scores) {
                 subtractScores(runningSums, oldestEntry.scores);
                 runningCount -= oldestEntry.postCount;
             }
         }

         if (runningCount > 0) {
             const avgScores = createEmptyScores();
             categories.forEach(category => {
                 if (runningSums?.hasOwnProperty(category)) {
                    // @ts-ignore - Suppress symbol index error
                    avgScores[category] = (runningSums as SentimentScores)[category] / runningCount;
                 }
             });
             result[i] = avgScores;
         } else {
             result[i] = null;
         }
     }
     return result;
}

// --- Firehose Processing ---
let postCounter = 0;
const THROTTLE_FACTOR = parseInt(process.env.THROTTLE_FACTOR || '1', 10);

/**
 * Callback for FirehoseSubscription. Processes the received object, 
 * assuming it's a post record.
 * @param {any} record The raw object received from the firehose stream.
 */
async function handleFirehoseRecord(record: any): Promise<void> {
    // console.log('Raw Record Received:', JSON.stringify(record)); 

    try {
        // Check if it looks like a valid post record
        if (!record || typeof record !== 'object' || record.$type !== 'app.bsky.feed.post') {
            // console.log('Skipping record - not a feed post:', record?.$type);
            return;
        }

        // Use type assertion now that we've checked $type
        const postRecord = record as AppBskyFeedPost.Record;

        // Throttle
        postCounter++;
        if (postCounter % THROTTLE_FACTOR !== 0) return;

        // Validate necessary fields from the record itself
        if (!postRecord.text || typeof postRecord.text !== 'string' || postRecord.text.trim().length === 0) {
            // console.log('Skipping post - no text content.');
            return;
        }

         const postText = postRecord.text;
         // Use provided langs array if available, otherwise detect
         // Note: franc detection might still be useful as fallback or primary
         let langCode = 'und'; // Default to undetermined
         if (Array.isArray(postRecord.langs) && postRecord.langs.length > 0) {
             // TODO: Decide how to handle multiple languages? Use the first? 
             // For now, use franc to detect from text.
             langCode = franc(postText, { minLength: 3, ignore: ['und'] }); 
             // console.log(`Detected language: ${langCode} (Provided: ${postRecord.langs.join(', ')})`);
         } else {
             langCode = franc(postText, { minLength: 3, ignore: ['und'] });
             // console.log(`Detected language: ${langCode} (None provided)`);
         }
         
         // --- TODO: Evaluate against Dynamic Filters --- 
         const sentimentScores = await analyzeSentiment(postText, langCode);
         if (sentimentScores !== null) {
             // Use langCode detected by franc
             if (!currentIntervalScores[langCode]) {
                 currentIntervalScores[langCode] = createEmptyScores();
                 currentIntervalPostCount[langCode] = 0;
             }
             addScores(currentIntervalScores[langCode], sentimentScores);
             currentIntervalPostCount[langCode]++;
             // --- TODO: Accumulate Filter Counts --- 
         }

    } catch (error) {
        console.error('Error processing received firehose record:', error);
        console.error('Record data:', JSON.stringify(record)); // Log the problematic record
    }
}


// --- Moving Average Helpers ---
// ... (calculateSentimentMovingAverage remains the same) ...

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


// --- Aggregation Timer & Live Update Logic ---

/**
 * Periodic function to aggregate data, store it, calculate MAs, and broadcast live updates.
 */
async function aggregateAndStore(): Promise<void> {
    const now = Date.now();
    const timestamp = new Date(now);
    const savedScoresByLang = { ...currentIntervalScores };
    const savedPostCountByLang = { ...currentIntervalPostCount };
    currentIntervalScores = {};
    currentIntervalPostCount = {};
    const liveUpdatePayload: LiveUpdateEntry[] = [];
    const bufferCutoffTime = now - LIVE_UPDATE_BUFFER_MS;
    const client: PoolClient = await pool.connect();
    try {
        for (const langCode in savedScoresByLang) {
             if (savedScoresByLang.hasOwnProperty(langCode)) {
                const scores = savedScoresByLang[langCode];
                const postCount = savedPostCountByLang[langCode] || 0;
                if (postCount > 0) {
                    try {
                       await client.query(
                           `INSERT INTO sentiment_data (timestamp, language, scores, post_count) VALUES ($1, $2, $3, $4) ON CONFLICT (timestamp, language) DO NOTHING;`,
                           [timestamp, langCode, JSON.stringify(scores), postCount]
                        );
                    } catch (err: any) { console.error(`Error saving data for lang [${langCode}]:`, err.message || err); }

                    const currentEntry: HistoryEntry = { timestamp: now, scores: scores, postCount: postCount };

                    if (!liveMAState[langCode]) {
                        liveMAState[langCode] = {
                            short: { queue: [], summedScores: createEmptyScores(), summedPostCount: 0, windowPoints: SHORT_AVG_WINDOW_POINTS },
                            long: { queue: [], summedScores: createEmptyScores(), summedPostCount: 0, windowPoints: LONG_AVG_WINDOW_POINTS }
                        };
                    }
                    const latestShortAvg = updateIncrementalWindowState(liveMAState[langCode].short, currentEntry);
                    const latestLongAvg = updateIncrementalWindowState(liveMAState[langCode].long, currentEntry);
                    currentEntry.shortAvg = latestShortAvg;
                    currentEntry.longAvg = latestLongAvg;

                    if (!recentHistoryBuffer[langCode]) recentHistoryBuffer[langCode] = [];
                    recentHistoryBuffer[langCode].push(currentEntry);
                    recentHistoryBuffer[langCode] = recentHistoryBuffer[langCode].filter(entry => entry.timestamp >= bufferCutoffTime).sort((a, b) => a.timestamp - b.timestamp);

                    DEFAULT_METRIC_KEYS.forEach(signalName => {
                         liveUpdatePayload.push({
                             signalName: signalName,
                             language: langCode,
                             timestamp: currentEntry.timestamp,
                             scores: currentEntry.scores,
                             postCount: currentEntry.postCount,
                             shortAvg: currentEntry.shortAvg,
                             longAvg: currentEntry.longAvg
                         });
                    });
                 }
             }
         }
    } catch (error) {
        console.error("Error during aggregation/storage:", error);
    } finally {
         client.release();
    }
     if (liveUpdatePayload.length > 0 && wss.clients.size > 0) {
        const message: LiveUpdateMessage = { type: 'liveUpdate', payload: { updates: liveUpdatePayload } };
        console.log(`Broadcasting liveUpdate with ${liveUpdatePayload.length} signal entries.`);
        broadcast(message);
    }
}

// --- Main Application Entry Point ---

async function main() {
    try {
        console.log("Initializing database...");
        await initializeDatabase();

        console.log("Loading initial dynamic signals from DB...");
        dynamicSignals = await loadDynamicSignalsFromDB(); // Load signals at startup
        console.log(` -> Loaded ${dynamicSignals.length} dynamic signals:`, dynamicSignals.map(s => s.name));

        // Start the aggregation and storage loop
        console.log(`Starting aggregation loop with interval: ${AGGREGATION_INTERVAL_MS / 1000}s`);
        // Run once at start to initialize MA states if needed, then set interval
        // await aggregateAndStore(); // Optional initial run? Consider MA state initialization.
        setInterval(aggregateAndStore, AGGREGATION_INTERVAL_MS);

        // Start the WebSocket server listeners (connection handled by wss.on('connection'))
        wss.on('connection', handleWebSocketConnection); // Use the implemented handler
        console.log('WebSocket server initialized and listening for connections.');

        // Attach WebSocket upgrade handler to the HTTP server
        server.on('upgrade', (request, socket, head) => {
            // Basic check for WebSocket path (optional, adjust if needed)
            if (request.url === '/ws' || !request.url) { // Allow root path or /ws
                 wss.handleUpgrade(request, socket, head, (ws) => {
                    wss.emit('connection', ws, request);
                 });
            } else {
                 console.log(`Rejecting WebSocket upgrade request for ${request.url}`);
                 socket.destroy();
            }
        });

        // Start the HTTP server
        const port = parseInt(process.env.PORT || '3000', 10);
        server.listen(port, () => {
            console.log(`HTTP server listening on port ${port}`);
        });

        // Start the Firehose connection using the updated handler
        console.log("Connecting to Bluesky Firehose...");
        const firehoseService = process.env.BLUESKY_SERVICE_URL || 'wss://bsky.network';
        console.log(`Using Firehose service URL: ${firehoseService}`);
        const firehose = new FirehoseSubscription(firehoseService);
        firehose.subscribeToFirehose(handleFirehoseRecord).catch(err => {
            console.error("Firehose subscription failed critically:", err);
        });
        console.log("Firehose subscription process initiated.");

        console.log("Application startup complete.");

    } catch (error) {
        console.error('FATAL Error starting the application:', error);
        process.exit(1);
    }
}

// Run the main application function.
main();
