import 'dotenv/config'; // Load .env file variables

import FirehoseSubscription from './firehose.js'; // Use default import
import { AppBskyFeedPost } from '@atproto/api';
import { franc } from 'franc';
import { analyzeSentiment, SentimentScores } from './sentiment.js';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import fs from 'fs'; // Import fs for file serving
import path from 'path'; // Import path for file paths
import mime from 'mime-types'; // Import mime-types for content type detection
import pg from 'pg'; // Import pg
import { QueryResult } from 'pg'; // Add QueryResult type import back
const { Pool } = pg;
import dotenv from 'dotenv';

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

/**
 * Initializes the PostgreSQL database.
 * Ensures the `sentiment_data` table exists with the correct schema.
 * Creates an index on the timestamp column for faster querying.
 * Exits the process if initialization fails.
 * @async
 * @throws {Error} If database connection or query execution fails.
 */
async function initializeDatabase() {
    console.log('Initializing database...');
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sentiment_data (
                timestamp TIMESTAMPTZ NOT NULL, -- Changed to NOT NULL
                language VARCHAR(10) NOT NULL, -- Added language column
                scores JSONB NOT NULL,
                post_count INTEGER NOT NULL,
                PRIMARY KEY (timestamp, language) -- Composite primary key
            );
        `);
        console.log('Database table ensured.');

        // Optional: Create/Update index for faster time-based queries (timestamp is primary)
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_sentiment_data_timestamp ON sentiment_data (timestamp DESC);
        `);
        console.log('Database index ensured.');

    } catch (err: any) {
        console.error('Database initialization failed:', err.message || err);
        process.exit(1); // Exit if DB init fails
    }
}

// Calculate absolute paths for serving static files.
const PROJECT_ROOT = process.cwd();
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, 'index.html');

// --- HTTP and WebSocket Server Setup ---
// Read port from environment or default to 3000.
const PORT = parseInt(process.env.PORT || '3000');

// Create an HTTP server to serve the static frontend files.
const server = http.createServer((req, res) => {
    console.log(`HTTP Request: ${req.method} ${req.url}`);

    // Determine the file path based on the request URL
    let filePath = path.join(PUBLIC_DIR, req.url || '/');

    // If root URL, serve index.html
    if (req.url === '/') {
        filePath = INDEX_HTML_PATH;
    }

    // Prevent directory traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    // Check if file exists and serve it
    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // File not found
                console.warn(`Static file not found: ${filePath}`);
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            } else {
                // Other server error
                console.error(`Error reading file ${filePath}: ${err.code} - ${err.message}`);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
            }
        } else {
            // File found, determine content type and serve
            const contentType = mime.lookup(filePath) || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
            console.log(`Served static file: ${filePath} as ${contentType}`);
        }
    });
});

// Create a WebSocket server instance attached to the HTTP server.
const wss = new WebSocketServer({ server });

console.log(`HTTP and WebSocket server started on port ${PORT}`);

// --- Constants for Time Ranges and Aggregation ---
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const ONE_DAY_MS = 24 * HOUR_MS;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const ONE_MONTH_MS = 30 * ONE_DAY_MS;
const MAX_HISTORY_MS = ONE_MONTH_MS;
const PRUNE_AGE_MS = 31 * ONE_DAY_MS; // Data older than this might be pruned (currently not implemented).

// The interval at which raw data is aggregated and stored (e.g., 10 seconds).
const AGGREGATION_INTERVAL_MS = 10 * 1000;

// Window sizes for calculating short-term and long-term moving averages.
const SHORT_AVG_WINDOW_MS = 5 * MINUTE_MS;
const LONG_AVG_WINDOW_MS = 1 * HOUR_MS;

// Duration of recent data to keep in the in-memory buffer for historical requests
// and for calculating live MAs incrementally. Should be slightly larger than the longest MA window.
const LIVE_UPDATE_BUFFER_MS = LONG_AVG_WINDOW_MS + (5 * MINUTE_MS); // Keep a bit more than 1hr

/**
 * Broadcasts data (usually LiveUpdateMessage) to all connected WebSocket clients.
 * @param {any} data The data object to broadcast (will be JSON.stringified).
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
// Define the structure for messages exchanged between client and server.

/** Message sent by the client to request historical data. */
interface RequestHistoryMessage {
    type: 'requestHistory';
    payload: {
        languages: string[];
        timeWindowMs: number;
        desiredIntervalMs: number;
    };
}

/** Structure for a single aggregated data point including calculated MAs (used in history/live updates). */
interface HistoryEntry {
    timestamp: number;
    scores: SentimentScores; // Raw aggregated scores for the interval
    postCount: number;
    // Moving averages will be added later by calculateMAs
    shortAvg?: SentimentScores | null;
    longAvg?: SentimentScores | null;
}

/** Structure for historical data for a single language. */
interface LanguageHistoryData {
    language: string;
    data: HistoryEntry[];
}

/** Message sent by the server containing requested historical data. */
interface HistoryDataMessage {
    type: 'historyData';
    payload: {
        results: LanguageHistoryData[];
    };
}

/** Structure for a single live update data point. */
interface LiveUpdateEntry {
    language: string;
    timestamp: number;
    scores: SentimentScores;
    postCount: number;
    // *** ADDED: Optional MA fields for live updates ***
    shortAvg?: SentimentScores | null;
    longAvg?: SentimentScores | null;
}

/** Message sent by the server containing live data updates. */
interface LiveUpdateMessage {
    type: 'liveUpdate';
    payload: {
        updates: LiveUpdateEntry[];
    };
}

/** Type alias for messages the client can send. */
type ClientMessage = RequestHistoryMessage; // Add other types if needed
/** Type alias for messages the server can send. */
type ServerMessage = HistoryDataMessage | LiveUpdateMessage; // Add other types if needed

// --- WebSocket Connection Handling ---
// Set up listeners for new WebSocket connections.
wss.on('connection', async (ws: WebSocket) => {
    console.log('Client connected');
    // Initial history load is now triggered by a client 'requestHistory' message.

    // Listener for messages received from a specific client.
    ws.on('message', async (message: Buffer) => {
        let parsedMessage: ClientMessage;
        try {
            parsedMessage = JSON.parse(message.toString());
            console.log('Received message:', parsedMessage.type);

            // Handle History Request
            if (parsedMessage.type === 'requestHistory') {
                const { languages, timeWindowMs, desiredIntervalMs } = parsedMessage.payload;

                if (!Array.isArray(languages) || languages.length === 0 || !timeWindowMs || !desiredIntervalMs) {
                    console.warn('Invalid requestHistory payload:', parsedMessage.payload);
                    // Optionally send error back to client
                    return;
                }

                const endTime = new Date();
                const startTime = new Date(endTime.getTime() - timeWindowMs);

                console.log(`Handling requestHistory for ${languages.join(',')}, window ${timeWindowMs/1000/60}m, interval ${desiredIntervalMs/1000}s`);

                // 1. Get aggregated data from the database based on the requested parameters.
                const aggregatedData = await getAggregatedData(languages, startTime, endTime, desiredIntervalMs);

                // 2. Calculate short-term and long-term moving averages for the aggregated data.
                const dataWithMAs = calculateMAsForAggregatedData(aggregatedData, desiredIntervalMs, SHORT_AVG_WINDOW_MS, LONG_AVG_WINDOW_MS);

                // 3. Format the data into the structure expected by the client.
                const results: LanguageHistoryData[] = [];
                dataWithMAs.forEach((data, lang) => {
                    results.push({ language: lang, data: data });
                });

                const response: HistoryDataMessage = {
                    type: 'historyData',
                    payload: { results: results }
                };

                // 4. Send back to client
                 ws.send(JSON.stringify(response), (err) => {
                    if (err) console.error('Error sending historyData to client:', err);
                    else console.log(`Sent historyData for ${languages.join(',')} to client.`);
                });
            }

        } catch (err: any) {
            console.error('Failed to parse client message or process request:', err.message || err);
            // Optionally send an error message back to the client
        }
    });

    // Listener for when a client connection is closed.
    ws.on('close', () => {
        console.log('Client disconnected');
    });

    // Listener for errors occurring on a client connection.
    ws.on('error', (error: Error) => {
        console.error('WebSocket client error:', error);
    });
});

// --- Data Structures for Aggregation ---

/** Represents the raw aggregated scores for a single time interval (before MAs). */
interface AggregatedScoreEntry {
    timestamp: number | Date;
    scores: SentimentScores;
    postCount: number;
    language?: string; // Add optional language field for type safety later
}

// Temporary accumulators holding the sum of scores and post counts for the *current*
// aggregation interval, keyed by language code (e.g., 'eng'). Reset every AGGREGATION_INTERVAL_MS.
let currentIntervalScores: { [lang: string]: SentimentScores } = {};
let currentIntervalPostCount: { [lang: string]: number } = {};

// In-memory buffer holding recent `HistoryEntry` data points (including MAs).
// Used to quickly serve `requestHistory` messages for recent time windows and
// as the basis for incremental live MA calculations. Pruned periodically.
let recentHistoryBuffer: { [lang: string]: HistoryEntry[] } = {};

/** State required for calculating a moving average incrementally (one per MA type per language). */
interface WindowState {
    queue: HistoryEntry[]; // Holds entries currently in the window
    summedScores: SentimentScores;
    summedPostCount: number;
    windowPoints: number; // Max size of the queue
}
// Holds the state for incremental calculation of short and long MAs for each active language.
let liveMAState: {
    [lang: string]: {
        short: WindowState;
        long: WindowState;
    }
} = {};

/**
 * Helper function to create an empty SentimentScores object with all categories initialized to 0.
 * @returns {SentimentScores} An empty scores object.
 */
function createEmptyScores(): SentimentScores {
    return { anger: 0, anticipation: 0, disgust: 0, fear: 0, joy: 0, sadness: 0, surprise: 0, trust: 0, positive: 0, negative: 0 };
}

/**
 * Helper function to add the values from a source SentimentScores object to a target object.
 * Modifies the target object in place.
 * @param {SentimentScores} target The scores object to add to.
 * @param {SentimentScores} source The scores object to add from.
 */
function addScores(target: SentimentScores, source: SentimentScores): void {
    for (const key in source) {
        if (target.hasOwnProperty(key)) {
            target[key as keyof SentimentScores] += source[key as keyof SentimentScores];
        }
    }
}

/**
 * Helper function to subtract the values from a source SentimentScores object from a target object.
 * Modifies the target object in place. Used for removing elements from MA windows.
 * @param {SentimentScores} target The scores object to subtract from.
 * @param {SentimentScores} source The scores object to subtract.
 */
function subtractScores(target: SentimentScores, source: SentimentScores): void {
    for (const key in source) {
        if (target.hasOwnProperty(key)) {
            target[key as keyof SentimentScores] -= source[key as keyof SentimentScores];
        }
    }
}

/**
 * Updates the state for an incremental moving average window.
 * Adds the new entry, removes the oldest entry if the window size is exceeded,
 * and recalculates the average scores based on the current window contents.
 * @param {WindowState} state The current state of the moving average window.
 * @param {HistoryEntry} newEntry The new data entry to add to the window.
 * @returns {SentimentScores | null} The calculated average scores for the window, or null if the window has no posts.
 */
function updateIncrementalWindowState(state: WindowState, newEntry: HistoryEntry): SentimentScores | null {
    // Add new entry to sums and queue
    addScores(state.summedScores, newEntry.scores);
    state.summedPostCount += newEntry.postCount;
    state.queue.push(newEntry);

    // Remove old entry if window exceeds size
    if (state.queue.length > state.windowPoints) {
        const oldEntry = state.queue.shift(); // Remove from the front (oldest)
        if (oldEntry) {
            subtractScores(state.summedScores, oldEntry.scores);
            state.summedPostCount -= oldEntry.postCount;
        }
    }

    // Calculate and return MA if window is full and valid
    if (state.queue.length > 0 && state.summedPostCount > 0) {
        const avgScores = createEmptyScores();
        for (const key in avgScores) {
            avgScores[key as keyof SentimentScores] = state.summedScores[key as keyof SentimentScores] / state.summedPostCount;
        }
        return avgScores;
    } else {
        // Window not full or no posts in window
        return null;
    }
}

// --- Interface Definitions ---

/**
 * Defines the structure of commit metadata passed from the FirehoseSubscription callback.
 */
export interface CommitData {
    repo: string;
    time: string;
    commit: any;
    ops: any[];
}

let postCounter = 0;
const THROTTLE_FACTOR = 1; // Process 1 out of every N posts (1 = process all).

/**
 * Callback function passed to the FirehoseSubscription.
 * Called for each `app.bsky.feed.post` record extracted from the firehose.
 * Performs language detection, sentiment analysis (if language is supported),
 * and updates the temporary accumulators (`currentIntervalScores`, `currentIntervalPostCount`).
 * Implements basic throttling using `THROTTLE_FACTOR`.
 *
 * @param {AppBskyFeedPost.Record} postRecord The parsed post record.
 * @param {CommitData} commitData Metadata about the commit containing the post.
 */
function processPost(postRecord: AppBskyFeedPost.Record, commitData: CommitData): void {
    postCounter++;
    if (postCounter % THROTTLE_FACTOR !== 0) {
        return;
    }

    if (!postRecord.text) return;
    const postText = postRecord.text;
    const langCode = franc(postText, { minLength: 3 }); // Use franc code directly

    // Analyze sentiment IF language is supported by loaded lexicons
    const sentimentScores = analyzeSentiment(postText, langCode);

    if (sentimentScores !== null) {
        // Ensure accumulator exists for this language in this interval
        if (!currentIntervalScores[langCode]) {
            currentIntervalScores[langCode] = createEmptyScores();
            currentIntervalPostCount[langCode] = 0;
        }
        // Add scores to the correct language bucket
        addScores(currentIntervalScores[langCode], sentimentScores);
        currentIntervalPostCount[langCode]++; // Increment language-specific post counter
    } else {
        // Optional: Log unsupported languages if needed for debugging lexicon mapping
        // if (langCode !== 'und') { // Avoid logging undetermined
        //     console.log(`Skipping post - unsupported language detected: ${langCode}`);
        // }
    }
}

// --- Reusable Moving Average Helper Functions ---

/**
 * Calculates a simple moving average for an array of numbers or nulls.
 * @param data An array of numbers or nulls.
 * @param windowSize The number of data points in the moving average window.
 * @returns An array of the same length containing the calculated averages or nulls.
 * @deprecated Less relevant now due to `calculateSentimentMovingAverage`.
 */
function calculateNumericMovingAverage(data: (number | null)[], windowSize: number): (number | null)[] {
    if (windowSize <= 0) {
        // Return array of nulls if window size is invalid
        return Array(data.length).fill(null);
    }

    const result: (number | null)[] = Array(data.length).fill(null); // Initialize with nulls
    let sum = 0;
    let count = 0;

    for (let i = 0; i < data.length; i++) {
        const enteringValue = data[i];
        if (enteringValue !== null) {
            sum += enteringValue;
            count++;
        }
        if (i >= windowSize) {
            const exitingValue = data[i - windowSize];
            if (exitingValue !== null) {
                sum -= exitingValue;
                count--;
            }
        }
        // Calculate MA only if the window is full
        if (i >= windowSize - 1) {
            if (count > 0) {
                result[i] = sum / count;
            } // else: result[i] remains null
        }
    }
    return result;
}

/**
 * Calculates moving averages for sentiment scores, weighted by post count.
 * Handles partial windows at the beginning of the data series.
 * @param {HistoryEntry[]} data Array of aggregated data entries (timestamp, scores, postCount).
 * @param {number} windowPoints The number of data points (intervals) in the moving average window.
 * @returns {Array<SentimentScores | null>} An array of the same length containing the calculated
 *          average SentimentScores for each point, or null if the window had zero posts.
 */
function calculateSentimentMovingAverage(data: HistoryEntry[], windowPoints: number): (SentimentScores | null)[] {
     const result: (SentimentScores | null)[] = Array(data.length).fill(null); // Initialize with nulls
     const categories = Object.keys(createEmptyScores()) as (keyof SentimentScores)[];

     // Use running sums for post-weighted average
     const runningSums: SentimentScores = createEmptyScores();
     let runningCount = 0;
     const windowQueue: HistoryEntry[] = []; // Keep track of entries in the current window

     for (let i = 0; i < data.length; i++) {
         const currentEntry = data[i];

         // Add current entry to sums and queue
         addScores(runningSums, currentEntry.scores);
         runningCount += currentEntry.postCount;
         windowQueue.push(currentEntry);

         // Remove oldest entry if window is exceeded
         if (windowQueue.length > windowPoints) {
             const oldestEntry = windowQueue.shift(); // Remove from front
             if (oldestEntry) {
                 subtractScores(runningSums, oldestEntry.scores);
                 runningCount -= oldestEntry.postCount;
             }
         }

         // Calculate MA if there are posts in the current (potentially partial) window
         if (runningCount > 0) {
             const avgScores = createEmptyScores();
             for (const category of categories) {
                 avgScores[category] = runningSums[category] / runningCount;
             }
             result[i] = avgScores;
         } else {
             result[i] = null; // Still null if window has zero posts
         }
     }
     return result;
}

// --- Server-Side Data Aggregation and Retrieval ---

/** Represents a raw row fetched from the `sentiment_data` table. */
interface RawDbEntry extends AggregatedScoreEntry {
    language: string;
    timestamp: Date; // Comes from DB as Date
}

/**
 * Fetches raw sentiment data from the database for the specified languages and time range,
 * then aggregates it into buckets based on the desired `intervalMs`.
 * Averages the scores within each bucket based on the number of raw data points contributing to it.
 *
 * @param {string[]} languages Array of ISO 639-3 language codes to fetch.
 * @param {Date} startTime The start of the time range (inclusive).
 * @param {Date} endTime The end of the time range (exclusive).
 * @param {number} intervalMs The desired aggregation interval in milliseconds.
 * @returns {Promise<Map<string, HistoryEntry[]>>} A Promise resolving to a Map where keys are language codes
 *          and values are arrays of aggregated `HistoryEntry` objects, sorted by timestamp.
 * @async
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

    try {
        // Query raw 10s data
        const queryResult: QueryResult<RawDbEntry> = await pool.query(
            `SELECT timestamp, language, scores, post_count as "postCount"
             FROM sentiment_data
             WHERE timestamp >= $1 AND timestamp < $2 AND language = ANY($3::VARCHAR[])
             ORDER BY timestamp ASC`,
            [startTime, endTime, languages]
        );

        console.log(` -> Fetched ${queryResult.rowCount} raw rows from DB.`);
        if (queryResult.rowCount === 0) {
            return resultByLang; // No data found
        }

        // Aggregate into buckets
        const buckets = new Map<string, { scores: SentimentScores; postCount: number; numPoints: number }>(); // Key: "lang_bucketTimestamp"

        queryResult.rows.forEach((row: RawDbEntry) => { // Explicitly type 'row'
            const bucketTimestamp = Math.floor(row.timestamp.getTime() / intervalMs) * intervalMs;
            const bucketKey = `${row.language}_${bucketTimestamp}`;

            if (!buckets.has(bucketKey)) {
                buckets.set(bucketKey, { scores: createEmptyScores(), postCount: 0, numPoints: 0 });
            }

            const bucket = buckets.get(bucketKey)!;
            addScores(bucket.scores, row.scores);
            bucket.postCount += row.postCount;
            bucket.numPoints++;
        });

        // Average scores and organize by language
        buckets.forEach((bucketData, key) => {
            const [lang, tsString] = key.split('_');
            const timestamp = parseInt(tsString, 10);
            const avgScores = { ...bucketData.scores };

            // Average the scores based on the number of raw data points (from 10s intervals) in the bucket
            if (bucketData.numPoints > 0) {
                 for (const scoreKey in avgScores) {
                    avgScores[scoreKey as keyof SentimentScores] /= bucketData.numPoints;
                }
            }

            if (!resultByLang.has(lang)) resultByLang.set(lang, []); // Should exist, but safety check

            resultByLang.get(lang)!.push({
                timestamp: timestamp,
                scores: avgScores,
                postCount: bucketData.postCount
            });
        });

        // Sort each language's data by timestamp (important for MAs)
        resultByLang.forEach(data => data.sort((a, b) => a.timestamp - b.timestamp));
        console.log(` -> Aggregated into buckets for ${resultByLang.size} languages.`);

    } catch (err: any) {
        console.error("Error during getAggregatedData:", err.message || err);
    }

    return resultByLang;
}

/**
 * Calculates short-term and long-term moving averages for pre-aggregated sentiment data.
 * Modifies the input `aggregatedData` map by adding `shortAvg` and `longAvg` properties
 * to each `HistoryEntry` object.
 *
 * @param {Map<string, HistoryEntry[]>} aggregatedData Map of language codes to arrays of aggregated data (output from `getAggregatedData`).
 * @param {number} intervalMs The aggregation interval used for the input data (e.g., 60000 for 1 minute).
 * @param {number} shortWindowMs The window size in milliseconds for the short-term MA.
 * @param {number} longWindowMs The window size in milliseconds for the long-term MA.
 * @returns {Map<string, HistoryEntry[]>} The input map, modified with calculated MA values.
 */
function calculateMAsForAggregatedData(
    aggregatedData: Map<string, HistoryEntry[]>, 
    intervalMs: number,
    shortWindowMs: number, // e.g., 5 * 60 * 1000
    longWindowMs: number  // e.g., 60 * 60 * 1000
): Map<string, HistoryEntry[]> { // Modifies the input map structure
    console.log(`Calculating MAs (Short: ${shortWindowMs/60000}m, Long: ${longWindowMs/60000}m)`);
    aggregatedData.forEach((langData, lang) => {
        if (langData.length === 0) return;

        const shortPoints = Math.max(1, Math.round(shortWindowMs / intervalMs));
        const longPoints = Math.max(1, Math.round(longWindowMs / intervalMs));

        console.log(`  -> Lang [${lang}]: Using ${shortPoints} points for short MA, ${longPoints} points for long MA (interval: ${intervalMs/1000}s).`);

        const shortMA = calculateSentimentMovingAverage(langData, shortPoints);
        const longMA = calculateSentimentMovingAverage(langData, longPoints);

        // Add MAs back to the data entries
        for (let i = 0; i < langData.length; i++) {
            langData[i].shortAvg = shortMA[i];
            langData[i].longAvg = longMA[i];
        }
    });
    return aggregatedData; // Return the modified map
}

// --- Aggregation Timer & Live Update Logic ---

/**
 * Function executed periodically by `setInterval` (every `AGGREGATION_INTERVAL_MS`).
 * 1. Takes the accumulated scores and counts from the last interval.
 * 2. Resets the accumulators (`currentIntervalScores`, `currentIntervalPostCount`).
 * 3. Saves the aggregated data to the database.
 * 4. Calculates the latest incremental moving averages using `liveMAState`.
 * 5. Adds the new data point (with MAs) to the `recentHistoryBuffer` and prunes the buffer.
 * 6. Prepares a `LiveUpdateMessage` payload with the latest data (including MAs) for active languages.
 * 7. Broadcasts the live update message to all connected WebSocket clients.
 * @async
 */
async function aggregateAndStore(): Promise<void> {
    const now = Date.now();
    const timestamp = new Date(now);
    const savedScoresByLang = { ...currentIntervalScores };
    const savedPostCountByLang = { ...currentIntervalPostCount };
    currentIntervalScores = {}; // Reset accumulators for next interval
    currentIntervalPostCount = {};

    const liveUpdatePayload: LiveUpdateEntry[] = [];
    const bufferCutoffTime = now - LIVE_UPDATE_BUFFER_MS; // For recentHistoryBuffer pruning

    // Process each language that had activity in the last interval
    for (const langCode in savedScoresByLang) {
        if (savedScoresByLang.hasOwnProperty(langCode)) {
            const scores = savedScoresByLang[langCode];
            const postCount = savedPostCountByLang[langCode] || 0;

            if (postCount > 0) {
                // 1. Save to DB (as before)
                try {
                    await pool.query(
                       `INSERT INTO sentiment_data (timestamp, language, scores, post_count)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (timestamp, language) DO NOTHING;`,
                       [timestamp, langCode, JSON.stringify(scores), postCount]
                    );
                } catch (err: any) {
                    console.error(`Error saving data for lang [${langCode}]:`, err.message || err);
                }

                // 2. Prepare data entry for buffer and live update
                const currentEntry: HistoryEntry = {
                    timestamp: now,
                    scores: scores,
                    postCount: postCount,
                    // MAs will be calculated incrementally next
                };

                // 3. Initialize Live MA State for this language if it's new
                if (!liveMAState[langCode]) {
                    const approxInterval = AGGREGATION_INTERVAL_MS;
                    liveMAState[langCode] = {
                        short: {
                            queue: [],
                            summedScores: createEmptyScores(),
                            summedPostCount: 0,
                            windowPoints: Math.max(1, Math.round(SHORT_AVG_WINDOW_MS / approxInterval))
                        },
                        long: {
                            queue: [],
                            summedScores: createEmptyScores(),
                            summedPostCount: 0,
                            windowPoints: Math.max(1, Math.round(LONG_AVG_WINDOW_MS / approxInterval))
                        }
                    };
                    console.log(`Initialized live MA state for [${langCode}]: Short=${liveMAState[langCode].short.windowPoints}pts, Long=${liveMAState[langCode].long.windowPoints}pts`);
                }

                // 4. Calculate Latest MAs Incrementally
                const latestShortAvg = updateIncrementalWindowState(liveMAState[langCode].short, currentEntry);
                const latestLongAvg = updateIncrementalWindowState(liveMAState[langCode].long, currentEntry);

                // *** Logging the results of incremental calculation ***
                // console.log(` -> Lang [${langCode}] Incremental MA: Short=`, JSON.stringify(latestShortAvg));
                // console.log(` -> Lang [${langCode}] Incremental MA: Long=`, JSON.stringify(latestLongAvg));

                // Add calculated MAs (which might be null) to the entry
                currentEntry.shortAvg = latestShortAvg;
                currentEntry.longAvg = latestLongAvg;

                // 5. Update & Prune In-Memory Buffer (recentHistoryBuffer - still needed for history requests)
                if (!recentHistoryBuffer[langCode]) {
                    recentHistoryBuffer[langCode] = [];
                }
                recentHistoryBuffer[langCode].push(currentEntry); // Add entry with calculated MAs
                // Keep buffer sorted and remove old entries (based on LIVE_UPDATE_BUFFER_MS)
                recentHistoryBuffer[langCode] = recentHistoryBuffer[langCode]
                    .filter(entry => entry.timestamp >= bufferCutoffTime)
                    .sort((a, b) => a.timestamp - b.timestamp); // Ensure sorted

                // 6. Add entry (with incrementally calculated MAs) to live broadcast payload
                liveUpdatePayload.push({
                    language: langCode,
                    timestamp: currentEntry.timestamp,
                    scores: currentEntry.scores,
                    postCount: currentEntry.postCount,
                    shortAvg: currentEntry.shortAvg,
                    longAvg: currentEntry.longAvg
                });
            }
        }
    }

    // --- Broadcasting Logic ---
    // Send live updates only if there are connected clients and data was processed.
    if (liveUpdatePayload.length > 0 && wss.clients.size > 0) {
        const message: LiveUpdateMessage = {
            type: 'liveUpdate',
            payload: { updates: liveUpdatePayload }
        };
        // *** ADDED: Log the actual payload being sent ***
        console.log(`Broadcasting liveUpdate with ${liveUpdatePayload.length} entries. Sample[0]:`, JSON.stringify(liveUpdatePayload[0]));
        broadcast(message);
    }
}

// --- Main Application Entry Point ---

/**
 * The main function to start the application.
 * Initializes the database, starts the periodic aggregation timer (`aggregateAndStore`),
 * connects to the Bluesky Firehose, and starts the HTTP/WebSocket server.
 * @async
 */
async function main() {
    console.log('Starting Bluesky Sentiment Analysis Service...');

    // Initialize Database FIRST
    await initializeDatabase();

    // Start the aggregation timer
    setInterval(aggregateAndStore, AGGREGATION_INTERVAL_MS);
    console.log(`Data aggregation and saving started every ${AGGREGATION_INTERVAL_MS / 1000} seconds.`);

    // Instantiate and start firehose
    const firehoseServiceUrl = process.env.BLUESKY_FIREHOSE_URL || 'wss://bsky.network';
    console.log(`Connecting to firehose service at: ${firehoseServiceUrl}`);
    const firehose = new FirehoseSubscription(firehoseServiceUrl);

    // Log throttling factor (even if 1)
    console.log(`Processing 1 / ${THROTTLE_FACTOR} posts from firehose.`);

    // Start firehose subscription non-blocking, allowing the server to start listening.
    // Pass `processPost` as the callback for handling individual posts.
    firehose.subscribeToFirehose(processPost).catch((error: any) => {
        console.error('Firehose subscription failed critically:', error);
        // Consider reconnect logic here
    });

    // Start the HTTP server and listen for connections.
    server.on('error', (error: NodeJS.ErrnoException) => {
        console.error(`Server listening error: ${error.code} - ${error.message}`);
        process.exit(1);
    });
    server.listen(PORT, () => {
        const address = server.address();
        const bind = typeof address === 'string' ? `pipe ${address}` : `port ${address?.port}`;
        console.log(`HTTP server listening on ${bind}`);
        console.log(`Dashboard URL: http://localhost:${PORT}`);
    });
}

// Run the main application function.
main();
