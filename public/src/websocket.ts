import {
    MAX_RECONNECT_ATTEMPTS,
    INITIAL_RECONNECT_DELAY,
    MAX_RECONNECT_DELAY,
    AGGREGATION_INTERVAL_MS,
    HOUR_MS,
    MINUTE_MS
} from './config.ts';
import {
    ws,
    reconnectAttempts,
    plottedSignals,
    currentTimeWindowMs,
    chartInstances,
    setWs,
    setReconnectAttempts
} from './state.ts';
import { handleHistoryData, handleLiveUpdate, updateCharts } from './chart.ts';
import { ReceivedServerMessage, ClientRequestHistoryMessage } from './types.ts';

// --- WebSocket Connection ---

/**
 * Establishes and manages the WebSocket connection to the backend server.
 * Handles opening, receiving messages, errors, and automatic reconnection.
 */
export function connectWebSocket(): void {
    const wsUrl = `ws://${window.location.host}/ws`;
    console.log(`Connecting WebSocket to ${wsUrl}`);
    const webSocket = new WebSocket(wsUrl);

    webSocket.onopen = () => {
        console.log('WebSocket connection established.');
        setWs(webSocket);
        setReconnectAttempts(0);
        requestHistoryData();
    };

    webSocket.onmessage = (event) => {
        try {
            const message: ReceivedServerMessage = JSON.parse(event.data);
            // console.log('WebSocket message received:', message.type);

            switch (message.type) {
                case 'historyData':
                    if (message.payload) {
                        handleHistoryData(message.payload);
                    } else {
                        console.warn('Received historyData message with missing payload.');
                    }
                    break;
                case 'liveUpdate':
                     if (message.payload) {
                        handleLiveUpdate(message.payload);
                    } else {
                        console.warn('Received liveUpdate message with missing payload.');
                    }
                    break;
                case 'error':
                    console.error('WebSocket server error:', message.payload);
                    break;
                default:
                    console.warn('Received unknown WebSocket message type:', message);
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
            console.error('Raw message data:', event.data);
        }
    };

    webSocket.onerror = (error) => {
        console.error('WebSocket error:', error);
        // ws might be null here if connection failed initially
    };

    webSocket.onclose = (event) => {
        console.error(`WebSocket closed: ${event.code} `);
        setWs(null);

        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const currentAttempts = reconnectAttempts + 1;
            setReconnectAttempts(currentAttempts);
            const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, currentAttempts - 1), MAX_RECONNECT_DELAY);
            console.log(`Attempting to reconnect in ${delay / 1000} seconds...`);
            setTimeout(connectWebSocket, delay);
        } else {
            console.error('Max reconnect attempts reached. Stopping reconnection.');
        }
    };
}

// --- Request Data Function ---
/**
 * Sends a 'requestHistory' message to the WebSocket server.
 * Determines the required languages AND signal names based on the currently plotted signals.
 * Calculates a desired data interval based on the current time window for efficiency.
 */
export function requestHistoryData() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        if (plottedSignals.length === 0) {
            console.log("No signals plotted. Not requesting history.");
            // Clear chart data if no signals are plotted
            if (chartInstances.sentimentChart) chartInstances.sentimentChart.data.datasets = [];
            if (chartInstances.volumeChart) chartInstances.volumeChart.data.datasets = [];
            updateCharts(); // Update to show empty charts
            return;
        }

        const requiredLanguages = Array.from(new Set(plottedSignals.map(signal => signal.languageCode)));
        const requiredSignalNames = Array.from(new Set(plottedSignals.map(signal => signal.metric)));

        let desiredIntervalMs = AGGREGATION_INTERVAL_MS;
        const oneDayMs = 24 * HOUR_MS;
        const oneWeekMs = 7 * oneDayMs;
        if (currentTimeWindowMs > oneWeekMs) desiredIntervalMs = 10 * MINUTE_MS;
        else if (currentTimeWindowMs > oneDayMs) desiredIntervalMs = 5 * MINUTE_MS;
        else if (currentTimeWindowMs > 2 * HOUR_MS) desiredIntervalMs = MINUTE_MS;

        console.log(`Requesting history for signals: [${requiredSignalNames.join(', ')}], languages: [${requiredLanguages.join(', ')}], window: ${currentTimeWindowMs/MINUTE_MS}m, interval: ${desiredIntervalMs/1000}s`);

        const requestMessage: ClientRequestHistoryMessage = {
            type: 'requestHistory',
            payload: {
                languages: requiredLanguages,
                timeWindowMs: currentTimeWindowMs,
                desiredIntervalMs: desiredIntervalMs,
                signalNames: requiredSignalNames
            }
        };
        ws.send(JSON.stringify(requestMessage));
    } else {
        console.log("WebSocket not open. Cannot request history.");
    }
} 