import 'dotenv/config'; // Load .env file variables FIRST

// Import modules and specific functions/variables needed for main orchestration
import { pool, initializeDatabase, loadEmotionKeysFromDB, loadDynamicSignalsFromDB, loadRecentMAStates } from './server/db.js';
import { dynamicSignals, liveAvgMAState } from './server/state.js'; // Import mutable state for assignment and liveAvgMAState
import { server } from './server/httpServer.js';
import { initializeWebSocketServer } from './server/websocketServer.js';
import { handleFirehoseRecord } from './server/firehoseHandler.js';
import { aggregateAndStore } from './server/aggregation.js';
import { AGGREGATION_INTERVAL_MS } from './server/config.js';
import FirehoseSubscription from './firehose.js'; // Keep the class import

// --- Main Application Entry Point ---
async function main() {
    console.log('Starting Bluesky Sentiment Analysis Server...');

    await initializeDatabase();

    await loadEmotionKeysFromDB();
    const loadedSignals = await loadDynamicSignalsFromDB();
    dynamicSignals.length = 0;
    dynamicSignals.push(...loadedSignals);
    console.log(`Loaded ${dynamicSignals.length} dynamic signals into state.`);

    // --- Initialize MA State --- 
    console.log('Initializing live MA state from database...');
    const historicalMAStates = await loadRecentMAStates();
    historicalMAStates.forEach((state, key) => {
        liveAvgMAState[key] = state; // Directly assign the loaded state
    });
    console.log(`Initialized ${historicalMAStates.size} MA states from history.`);
    // Any new signal/lang combo will be initialized in aggregateAndStore

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
