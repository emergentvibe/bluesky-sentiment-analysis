import { subscribeToFirehose } from './firehose.js';
import { AppBskyFeedPost } from '@atproto/api';
import { franc } from 'franc';
import { analyzeSentiment, SentimentScores } from './sentiment.js';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import fs from 'fs'; // Import fs for file serving
import path from 'path'; // Import path for file paths
import mime from 'mime-types'; // Import mime-types for content type detection

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

wss.on('connection', (ws: WebSocket) => {
    console.log('Client connected');

    // Send the current aggregated data immediately on connection
    ws.send(JSON.stringify(aggregatedData), (err) => {
        if (err) {
            console.error('Error sending initial data to client:', err);
        }
    });

    ws.on('message', (message: Buffer) => {
        // Handle incoming messages if needed (e.g., client requests)
        console.log('Received message from client: %s', message);
        // For now, just echo back or ignore
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    ws.on('error', (error: Error) => {
        console.error('WebSocket client error:', error);
    });
});

// --- Data Structures for Aggregation ---

// Represents the aggregated scores for a single time interval
interface AggregatedScoreEntry {
    timestamp: number; // Unix timestamp (milliseconds)
    scores: SentimentScores;
    postCount: number; // Number of English posts in this interval
}

// In-memory store for aggregated data (last 12 hours)
const aggregatedData: AggregatedScoreEntry[] = [];

// Temporary accumulator for the current interval
let currentIntervalScores: SentimentScores = createEmptyScores();
let currentIntervalPostCount: number = 0; // Counter for English posts in interval

// Constants for aggregation
const AGGREGATION_INTERVAL_MS = 10 * 1000;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

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
function aggregateAndStore(): void {
    const now = Date.now();

    // Create entry for the completed interval, including post count
    const newEntry: AggregatedScoreEntry = {
        timestamp: now,
        scores: { ...currentIntervalScores }, // Copy scores (includes positive/negative)
        postCount: currentIntervalPostCount // Store post count
    };

    // Add to the main data store
    aggregatedData.push(newEntry);

    // Reset the accumulators for the next interval
    currentIntervalScores = createEmptyScores();
    currentIntervalPostCount = 0; // Reset counter

    // Prune old data
    const cutoffTime = now - TWELVE_HOURS_MS;
    const firstValidIndex = aggregatedData.findIndex(entry => entry.timestamp >= cutoffTime);
    if (firstValidIndex > 0) {
        aggregatedData.splice(0, firstValidIndex);
    }

    // Broadcast the UPDATED full dataset (which now includes postCount)
    broadcast(aggregatedData);
    if (wss.clients.size > 0 || aggregatedData.length % 20 === 1) { // Log every minute roughly, or if clients connected (adjust logging frequency)
         console.log(`[${new Date(now).toISOString()}] Aggregated ${newEntry.postCount} posts. Broadcasting data (${wss.clients.size} clients).`);
    }
}

// --- Main Application ---

/**
 * Main application function.
 * Starts the firehose subscription and handles errors.
 */
async function main() {
    console.log('Starting Bluesky Sentiment Analysis Service...');

    // Start the aggregation timer
    setInterval(aggregateAndStore, AGGREGATION_INTERVAL_MS);
    console.log(`Data aggregation started every ${AGGREGATION_INTERVAL_MS / 1000} seconds.`);

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