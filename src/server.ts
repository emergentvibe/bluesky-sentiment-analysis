import 'dotenv/config'; // Load .env file variables FIRST

// Import modules and specific functions/variables needed for main orchestration
import { pool, initializeDatabase, loadEmotionKeysFromDB, loadDynamicSignalsFromDB } from './server/db.js';
import { dynamicSignals } from './server/state.js'; // Import mutable state for assignment
import { server } from './server/httpServer.js';
import { initializeWebSocketServer } from './server/websocketServer.js';
import { handleFirehoseRecord } from './server/firehoseHandler.js';
import { aggregateAndStore } from './server/aggregation.js';
import { AGGREGATION_INTERVAL_MS } from './server/config.js';
import FirehoseSubscription from './firehose.js'; // Keep the class import

// Removed unused imports: pg, franc, analyzeSentiment, @atproto/api, various types...

// Top-level state moved to src/server/state.ts

// Constants moved to src/server/config.ts

// --- Database Setup moved to src/server/db.ts ---

// --- Database Functions moved to src/server/db.ts ---

// --- Path Setup moved to src/server/httpServer.ts ---

// --- HTTP Server moved to src/server/httpServer.ts ---

// --- WebSocket logic moved to src/server/websocketServer.ts ---

// --- Sentiment utility functions moved to src/server/sentimentUtils.ts ---

// --- Firehose Processing Logic moved to src/server/firehoseHandler.ts ---

// --- Aggregation & Storage Logic moved to src/server/aggregation.ts ---

// --- Server-Side Data Aggregation/Retrieval moved to src/server/db.ts ---

// --- Main Application Entry Point ---
async function main() {
    console.log('Starting Bluesky Sentiment Analysis Server...');

    await initializeDatabase();

    await loadEmotionKeysFromDB();
    const loadedSignals = await loadDynamicSignalsFromDB();
    dynamicSignals.length = 0;
    dynamicSignals.push(...loadedSignals);
    console.log(`Loaded ${dynamicSignals.length} dynamic signals into state.`);

    const firehoseServiceUrl = process.env.FIREHOSE_SERVICE_URL || 'wss://bsky.network';
    console.log(`Initializing Firehose connection to: ${firehoseServiceUrl}`);
    const firehose = new FirehoseSubscription(firehoseServiceUrl);

    firehose.subscribeToFirehose(handleFirehoseRecord)
        .then(() => {
            console.log("Firehose subscription loop exited normally.");
        })
        .catch(err => {
            console.error("CRITICAL: Firehose subscription loop failed:", err);
            process.exit(1);
        });
    console.log('Attempting to connect to Firehose...');

    console.log(`Starting aggregation every ${AGGREGATION_INTERVAL_MS} ms`);
    const aggregationInterval = setInterval(aggregateAndStore, AGGREGATION_INTERVAL_MS);

    initializeWebSocketServer(server);

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server listening on http://localhost:${PORT}`);
        console.log('WebSocket server is ready for connections.');
    });

    process.on('SIGINT', () => {
        console.log("\nSIGINT received. Shutting down gracefully...");
        clearInterval(aggregationInterval);
        firehose.stop();
        server.close(() => {
            console.log('HTTP/WebSocket server closed.');
            pool.end(() => {
                console.log('Database pool closed.');
                process.exit(0);
            });
        });
        setTimeout(() => {
            console.error("Graceful shutdown timed out. Forcing exit.");
            process.exit(1);
        }, 10000);
    });
}

main().catch(err => {
    console.error('Unhandled error during startup:', err);
    process.exit(1);
});
