var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { subscribeToFirehose } from './firehose';
import { franc } from 'franc'; // Language detection library
import { analyzeSentiment } from './sentiment'; // Import sentiment analysis function and types
import { WebSocketServer, WebSocket } from 'ws'; // Import WebSocket library
// --- WebSocket Server Setup ---
const WS_PORT = parseInt(process.env.PORT || '8080'); // Use PORT env var or default
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`WebSocket server started on port ${WS_PORT}`);
// Function to broadcast data to all connected clients
function broadcast(data) {
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
wss.on('connection', (ws) => {
    console.log('Client connected');
    // Send the current aggregated data immediately on connection
    ws.send(JSON.stringify(aggregatedData), (err) => {
        if (err) {
            console.error('Error sending initial data to client:', err);
        }
    });
    ws.on('message', (message) => {
        // Handle incoming messages if needed (e.g., client requests)
        console.log('Received message from client: %s', message);
        // For now, just echo back or ignore
    });
    ws.on('close', () => {
        console.log('Client disconnected');
    });
    ws.on('error', (error) => {
        console.error('WebSocket client error:', error);
    });
});
// In-memory store for aggregated data (last 12 hours)
const aggregatedData = [];
// Temporary accumulator for the current interval
let currentIntervalScores = createEmptyScores();
// Constants for aggregation
const AGGREGATION_INTERVAL_MS = 10 * 1000; // 10 seconds
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
// Helper function to create an empty scores object
function createEmptyScores() {
    return { anger: 0, anticipation: 0, disgust: 0, fear: 0, joy: 0, sadness: 0, surprise: 0, trust: 0 };
}
// Helper function to add scores from one object to another
function addScores(target, source) {
    for (const key in source) {
        if (target.hasOwnProperty(key)) {
            target[key] += source[key];
        }
    }
}
/**
 * Processes a post record received from the firehose.
 * - Checks if the post has text.
 * - Detects the language of the post text.
 * - If English, performs sentiment analysis and logs results.
 */
function processPost(postRecord, commitData) {
    // Ensure the post has text content
    if (!postRecord.text) {
        return;
    }
    const postText = postRecord.text;
    // Detect language
    const langCode = franc(postText);
    if (langCode === 'eng') {
        const sentimentScores = analyzeSentiment(postText);
        // Add scores to the current interval accumulator
        addScores(currentIntervalScores, sentimentScores);
        // Optional: Log individual post scores if needed for debugging
        // console.log(
        //     `[${commitData.time} - ${commitData.repo}] Eng Post Processed. Scores: ${JSON.stringify(sentimentScores)}`
        // );
    }
    else if (langCode === 'und') {
        // console.log(`[${commitData.repo}] Undetermined language post: ${postText.substring(0,100)}...`);
    }
    else {
        // console.log(`[${commitData.repo}] Non-English post (${langCode}): ${postText.substring(0,100)}...`);
    }
}
// --- Aggregation Timer --- 
function aggregateAndStore() {
    const now = Date.now();
    // Create entry for the completed interval
    const newEntry = {
        timestamp: now,
        scores: Object.assign({}, currentIntervalScores) // Copy scores
    };
    // Add to the main data store
    aggregatedData.push(newEntry);
    // Reset the accumulator for the next interval
    currentIntervalScores = createEmptyScores();
    // Prune old data (older than 12 hours)
    const cutoffTime = now - TWELVE_HOURS_MS;
    const firstValidIndex = aggregatedData.findIndex(entry => entry.timestamp >= cutoffTime);
    if (firstValidIndex > 0) {
        // Remove entries before the first valid one
        aggregatedData.splice(0, firstValidIndex);
    }
    // Log the latest aggregated entry (for debugging)
    console.log(`[${new Date(now).toISOString()}] Aggregated Scores: ${JSON.stringify(newEntry.scores)} (Total entries: ${aggregatedData.length})`);
    // Broadcast the UPDATED full dataset to all clients
    broadcast(aggregatedData);
    console.log(`[${new Date(now).toISOString()}] Aggregated and broadcasted data (${wss.clients.size} clients).`);
}
// --- Main Application --- 
/**
 * Main application function.
 * Starts the firehose subscription and handles errors.
 */
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('Starting Bluesky Sentiment Analysis Service...');
        // Start the aggregation timer
        setInterval(aggregateAndStore, AGGREGATION_INTERVAL_MS);
        console.log(`Data aggregation started every ${AGGREGATION_INTERVAL_MS / 1000} seconds.`);
        try {
            // Start listening to the firehose, passing the processPost function as the callback
            yield subscribeToFirehose(processPost);
        }
        catch (error) {
            console.error('Application crashed:', error);
            process.exit(1); // Exit if subscription fails fatally
        }
    });
}
// Run the main function
main();
//# sourceMappingURL=server.js.map