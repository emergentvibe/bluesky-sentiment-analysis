import { Chart } from 'chart.js';
import { PlottedSignalConfig, AvailableSignal, HistoryEntry } from './types.ts';
import { DEFAULT_WINDOW_HOURS, HOUR_MS } from './config.ts';

// --- State Variables ---
export let ws: WebSocket | null = null;

// Holds references to the Chart.js instances.
export let chartInstances: {
    sentimentChart: Chart | null;
    volumeChart: Chart | null;
    // Remove individual emotion charts if they are truly obsolete
    anger: Chart | null;
    anticipation: Chart | null;
    disgust: Chart | null;
    fear: Chart | null;
    joy: Chart | null;
    sadness: Chart | null;
    surprise: Chart | null;
    trust: Chart | null;
} = {
    sentimentChart: null,
    volumeChart: null,
    anger: null,
    anticipation: null,
    disgust: null,
    fear: null,
    joy: null,
    sadness: null,
    surprise: null,
    trust: null
};

export let netSentimentLabel = 'Net Sentiment (Pos - Neg)'; // If still used, otherwise remove

// Stores the historical and live data received from the WebSocket backend, keyed by language code (e.g., 'eng').
// Consider if this is still needed if data is directly processed into charts
export let currentChartData: { [lang: string]: HistoryEntry[] } = {}; // DEPRECATED? Verify usage.

export let plottedSignals: PlottedSignalConfig[] = [];

export let currentTimeWindowMs = DEFAULT_WINDOW_HOURS * HOUR_MS;

export let reconnectAttempts = 0;

// Dynamically fetched list of metrics and filters
export let availableSignals: AvailableSignal[] = [];

// Cache to store assigned colors for signals/languages.
export let languageColorCache: { [key: string]: string } = {}; // Key could be langCode or signalId
export let colorIndex = 0;

// Function to safely get and increment the color index
export function getAndIncrementColorIndex(): number {
    const currentIndex = colorIndex;
    colorIndex++;
    return currentIndex;
}

// Setter functions for imported state
export function setWs(newWs: WebSocket | null) {
    ws = newWs;
}

export function setReconnectAttempts(attempts: number) {
    reconnectAttempts = attempts;
}

// Setter for currentTimeWindowMs
export function setCurrentTimeWindowMs(ms: number) {
    currentTimeWindowMs = ms;
} 