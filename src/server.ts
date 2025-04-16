import { subscribeToFirehose } from './firehose.js';
import { AppBskyFeedPost } from '@atproto/api';
import { franc } from 'franc';
import { analyzeSentiment, SentimentScores } from './sentiment.js';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import fs from 'fs'; // Import fs for file serving
import path from 'path'; // Import path for file paths
import mime from 'mime-types'; // Import mime-types for content type detection
import pg from 'pg'; // Import pg
const { Pool } = pg;

// --- Database Setup ---
if (!process.env.DATABASE_URL) {
    console.error('CRITICAL: DATABASE_URL environment variable is not set.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Fly.io may require SSL depending on the network, but the internal connection string usually disables it.
    // Enable it if you encounter connection issues:
    // ssl: {
    //   rejectUnauthorized: false // Required for self-signed certs often used internally
    // }
});

// Database initialization function
async function initializeDatabase() {
    console.log('Initializing database...');
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sentiment_data (
                timestamp TIMESTAMPTZ PRIMARY KEY,
                scores JSONB NOT NULL,
                post_count INTEGER NOT NULL
            );
        `);
        console.log('Database table ensured.');

        // Optional: Create an index for faster time-based queries
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_sentiment_data_timestamp ON sentiment_data (timestamp DESC);
        `);
        console.log('Database index ensured.');

    } catch (err: any) {
        console.error('Database initialization failed:', err.message || err);
        process.exit(1); // Exit if DB init fails
    }
}

// Calculate paths from project root (current working directory)
const PROJECT_ROOT = process.cwd();
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, 'index.html');

// --- HTTP and WebSocket Server Setup ---
const PORT = parseInt(process.env.PORT || '8088');

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

const wss = new WebSocketServer({ server });

console.log(`HTTP and WebSocket server started on port ${PORT}`);

// Function to broadcast data to all connected clients
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

wss.on('connection', async (ws: WebSocket) => {
    console.log('Client connected');

    try {
        // Query historical data (last 12 hours) for the new client
        const twelveHoursAgo = new Date(Date.now() - TWELVE_HOURS_MS);
        const historyResult = await pool.query<AggregatedScoreEntry>(`
            SELECT timestamp, scores, post_count as "postCount"
            FROM sentiment_data
            WHERE timestamp >= $1
            ORDER BY timestamp ASC
        `, [twelveHoursAgo]);

        const historicalData = historyResult.rows.map(row => ({
            ...row,
            timestamp: new Date(row.timestamp).getTime() // Ensure timestamp is number
        }));

        console.log(`Sending ${historicalData.length} historical data points to new client.`);
        // Send the historical data immediately on connection
        ws.send(JSON.stringify(historicalData), (err) => {
            if (err) {
                console.error('Error sending initial historical data to client:', err);
            }
        });

    } catch (err: any) {
        console.error('Error fetching historical data for client:', err.message || err);
        // Optionally send an error message to the client
        ws.send(JSON.stringify({ error: 'Failed to load historical data' }));
    }

    ws.on('message', (message: Buffer) => {
        console.log('Received message from client: %s', message);
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    ws.on('error', (error: Error) => {
        console.error('WebSocket client error:', error);
    });
});

// --- Data Structures for Aggregation ---

// Represents the aggregated scores for a single time interval (used for DB results too)
interface AggregatedScoreEntry {
    timestamp: number | Date; // Allow Date from DB query
    scores: SentimentScores;
    postCount: number;
}

// Temporary accumulator for the current interval (still needed)
let currentIntervalScores: SentimentScores = createEmptyScores();
let currentIntervalPostCount: number = 0;

// Constants for aggregation
const AGGREGATION_INTERVAL_MS = 10 * 1000;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000; // For pruning

// Helper function to create an empty scores object
function createEmptyScores(): SentimentScores {
    return { anger: 0, anticipation: 0, disgust: 0, fear: 0, joy: 0, sadness: 0, surprise: 0, trust: 0, positive: 0, negative: 0 };
}

// Helper function to add scores from one object to another
function addScores(target: SentimentScores, source: SentimentScores): void {
    for (const key in source) {
        if (target.hasOwnProperty(key)) {
            target[key as keyof SentimentScores] += source[key as keyof SentimentScores];
        }
    }
}

// --- Firehose Processing Logic with Throttling ---
interface CommitData {
    repo: string;
    time: string;
    commit: any;
    ops: any[];
}

let postCounter = 0;
const THROTTLE_FACTOR = 50;

function processPost(postRecord: AppBskyFeedPost.Record, commitData: CommitData): void {
    postCounter++;
    if (postCounter % THROTTLE_FACTOR !== 0) {
        return;
    }

    if (!postRecord.text) return;
    const postText = postRecord.text;
    const langCode = franc(postText);
    if (langCode === 'eng') {
        const sentimentScores = analyzeSentiment(postText);
        addScores(currentIntervalScores, sentimentScores);
        currentIntervalPostCount++; // Increment English post counter
    }
}

// --- Aggregation Timer ---
async function aggregateAndStore(): Promise<void> {
    const now = Date.now();
    const timestamp = new Date(now);

    // Create entry for the completed interval
    const newEntry: AggregatedScoreEntry = {
        timestamp: now, // Use number for broadcasting consistency
        scores: { ...currentIntervalScores },
        postCount: currentIntervalPostCount
    };

    // Reset the accumulators immediately for the next interval
    const savedScores = { ...currentIntervalScores };
    const savedPostCount = currentIntervalPostCount;
    currentIntervalScores = createEmptyScores();
    currentIntervalPostCount = 0;

    // Save the completed interval to the database
    try {
        await pool.query(`
            INSERT INTO sentiment_data (timestamp, scores, post_count)
            VALUES ($1, $2, $3)
            ON CONFLICT (timestamp) DO NOTHING; -- Avoid errors if somehow timestamp collides
        `, [timestamp, JSON.stringify(savedScores), savedPostCount]);

        // Broadcast ONLY the new data point
        // Wrap in an array to match expected frontend format for a single update
        broadcast([newEntry]);

        if (wss.clients.size > 0 || Math.random() < 0.1) { // Log occasionally or if clients connected
             console.log(`[${timestamp.toISOString()}] Aggregated ${savedPostCount} posts. Saved to DB. Broadcasting new entry.`);
        }

        // Prune old data (older than 1 day) from the database periodically
        if (Math.random() < 0.05) { // Run roughly 5% of the time (every ~3.3 mins)
            const cutoffTime = new Date(now - ONE_DAY_MS);
            console.log(`Pruning data older than ${cutoffTime.toISOString()}...`);
            const deleteResult = await pool.query(
                'DELETE FROM sentiment_data WHERE timestamp < $1',
                [cutoffTime]
            );
            if (deleteResult.rowCount !== null && deleteResult.rowCount > 0) {
                 console.log(`Pruned ${deleteResult.rowCount} old entries from database.`);
            }
        }

    } catch (err: any) {
        console.error('Error saving or pruning data:', err.message || err);
        // Restore accumulators if save failed? Or just log error and continue?
        // For simplicity, just log and continue; the next interval might succeed.
        // Consider more robust error handling/retry logic in production.
    }
}

// --- Main Application ---
async function main() {
    console.log('Starting Bluesky Sentiment Analysis Service...');

    // Initialize Database FIRST
    await initializeDatabase();

    // Start the aggregation timer
    // Note: No need to await setInterval, it runs independently
    setInterval(aggregateAndStore, AGGREGATION_INTERVAL_MS);
    console.log(`Data aggregation and saving started every ${AGGREGATION_INTERVAL_MS / 1000} seconds.`);

    // Start firehose non-blocking
    console.log(`Throttling firehose processing: 1 / ${THROTTLE_FACTOR} posts.`);
    subscribeToFirehose(processPost).catch(error => {
        console.error('Firehose subscription failed critically:', error);
    });

    console.log(`Attempting to listen on port ${PORT}...`);
    server.on('error', (error: NodeJS.ErrnoException) => {
        // Log specific listening errors (like EADDRINUSE)
        console.error(`Server listening error: ${error.code} - ${error.message}`);
        process.exit(1);
    });
    server.listen(PORT, () => {
        const address = server.address();
        const bind = typeof address === 'string' ? `pipe ${address}` : `port ${address?.port}`;
        console.log(`HTTP server listening on ${bind}`);
        console.log(`Dashboard URL: http://localhost:${PORT}`); // Log the explicit URL
    });
}

// Run the main function
main(); 