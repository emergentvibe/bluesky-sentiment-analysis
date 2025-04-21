// ... other imports ...
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { ClientMessage, HistoryDataMessage, HistoryEntry, LiveUpdateMessage } from '../types.js';
import { baseMetricKeysMap } from './state.js';
import { fetchAndAggregateData } from './db.js';
import { calculateMAsForAggregatedData } from './sentimentUtils.js';
import { SHORT_AVG_WINDOW_POINTS, LONG_AVG_WINDOW_POINTS } from './config.js';
// ... rest of file ...

// Create the WebSocket server instance
export const wss = new WebSocketServer({ noServer: true });

/**
 * Handles a new WebSocket connection.
 */
async function handleWebSocketConnection(ws: WebSocket): Promise<void> {
    console.log('Client connected via WebSocket');

    // --- Message Handler --- 
    ws.on('message', async (message: Buffer) => {
        let parsedMessage: ClientMessage;
        try {
            parsedMessage = JSON.parse(message.toString());
            console.log('Received WebSocket message:', parsedMessage.type);

            // --- Handle History Request --- 
            if (parsedMessage.type === 'requestHistory') {
                const { languages, timeWindowMs, desiredIntervalMs, signalNames } = parsedMessage.payload;

                // Validate payload
                if (!Array.isArray(languages) || typeof timeWindowMs !== 'number' || timeWindowMs <= 0 ||
                    typeof desiredIntervalMs !== 'number' || desiredIntervalMs <= 0 ||
                    !Array.isArray(signalNames)) {
                    console.warn('Invalid requestHistory payload:', parsedMessage.payload);
                    ws.send(JSON.stringify({ type: 'error', payload: 'Invalid history request format' }));
                    return;
                }

                // Handle empty signals/langs
                if (signalNames.length === 0 || languages.length === 0) {
                    console.log("requestHistory with no signalNames or languages. Sending empty results.");
                    const emptyResponse: HistoryDataMessage = { type: 'historyData', payload: { signalLangData: {} } };
                    ws.send(JSON.stringify(emptyResponse));
                    return;
                }

                // Calculate time range
                const endTime = new Date();
                const startTime = new Date(endTime.getTime() - timeWindowMs);

                // Determine DB signals to query
                const dbSignalNamesToQuery = new Set<string>();
                signalNames.forEach(reqSignalName => {
                    const lowerSignalName = reqSignalName.toLowerCase();
                    if (baseMetricKeysMap.has(lowerSignalName)) {
                        dbSignalNamesToQuery.add('default');
                    } else {
                        dbSignalNamesToQuery.add(reqSignalName);
                    }
                });
                const dbQuerySignalsArray = Array.from(dbSignalNamesToQuery);

                console.log(`Handling requestHistory for signals [${signalNames.join(',')}] (DB: [${dbQuerySignalsArray.join(',')}]) & langs [${languages.join(',')}]`);

                // Fetch and process data
                const aggregatedData = await fetchAndAggregateData(languages, dbQuerySignalsArray, startTime, endTime, desiredIntervalMs);
                const dataWithMAs = calculateMAsForAggregatedData(aggregatedData, desiredIntervalMs, SHORT_AVG_WINDOW_POINTS, LONG_AVG_WINDOW_POINTS);

                // Format response payload
                const signalLangDataPayload: { [signalLangKey: string]: HistoryEntry[] } = {};
                signalNames.forEach(reqSignalName => {
                    const lowerSignalName = reqSignalName.toLowerCase();
                    const dbSignalName = baseMetricKeysMap.has(lowerSignalName) ? 'default' : reqSignalName;
                    languages.forEach(langCode => {
                        const requestedKey = `${reqSignalName}_${langCode}`;
                        const dbDataKey = `${dbSignalName}_${langCode}`;
                        signalLangDataPayload[requestedKey] = dataWithMAs.get(dbDataKey) || [];
                    });
                });

                // Send response
                console.log('[WS Send] Sending historyData payload structure. Keys:', Object.keys(signalLangDataPayload));
                const response: HistoryDataMessage = {
                    type: 'historyData',
                    payload: { signalLangData: signalLangDataPayload }
                };
                ws.send(JSON.stringify(response), (err) => {
                    if (err) console.error('Error sending historyData to client:', err);
                    else console.log(`Sent historyData for requested signals [${signalNames.join(',')}] & langs [${languages.join(',')}]`);
                });
            } else {
                console.log(`Received unhandled message type: ${parsedMessage.type}`);
            }
        } catch (err: any) {
            console.error('Failed to parse client message or process request:', err.message || err);
            ws.send(JSON.stringify({ type: 'error', payload: 'Server error processing message' }));
        }
    }); // End of ws.on('message')

    // --- Close Handler --- 
    ws.on('close', () => {
        console.log('WebSocket client disconnected');
    });

    // --- Error Handler --- 
    ws.on('error', (error: Error) => {
        console.error('WebSocket client error:', error);
        ws.close(); // Close on error
    });
} // End of handleWebSocketConnection

/**
 * Broadcasts data to all connected WebSocket clients.
 */
export function broadcast(data: any): void {
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
 * Attaches the WebSocket server to the HTTP server's upgrade handler
 * and sets up the connection listener.
 */
export function initializeWebSocketServer(server: http.Server): void {
    server.on('upgrade', (request, socket, head) => {
        const pathname = request.url;
        // Allow connections on root or /ws path
        if (pathname === '/' || pathname === '/ws' || !pathname) {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else {
            console.log(`Rejecting WebSocket upgrade request for unexpected path: ${pathname}`);
            socket.destroy();
        }
    });

    // Set up the connection handler to use our function
    wss.on('connection', handleWebSocketConnection);

    console.log('WebSocket server initialized and attached to HTTP server.');
}