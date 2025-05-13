import { MetricSignal, SentimentScores } from '../types.js';
import { loadDynamicSignalsFromDB } from './db.js'; // Import the DB loading function

// Export mutable state variables
export let dynamicSignals: MetricSignal[] = [];
export let currentEmotionKeys: string[] = [];
export let baseMetricKeysMap: Map<string, boolean> = new Map();
export let currentIntervalScores: { [lang: string]: { [signalName: string]: SentimentScores } } = {};
export let currentIntervalPostCount: { [lang: string]: { [signalName: string]: number } } = {};
// export let recentHistoryBuffer: { [signalLangKey: string]: HistoryEntry[] } = {}; // Removed - Was for WebSocket history
// export let liveMAState: { [signalLangKey: string]: { short: WindowState; long: WindowState } } = {}; // Removed - Old MA state

// NEW State for numeric MAs (per metric)
export interface SimpleMAState {
    queue: number[];      // Queue of recent numeric values
    windowPoints: number; // Size of the window
    // sum?: number; // Optional: Can add sum for performance optimization
}
export let liveAvgMAState: {
    [signalLangMetricKey: string]: { // Key format: signalName_language_metricName
        short: SimpleMAState;
        long: SimpleMAState;
    }
} = {};

/**
 * Reloads the dynamic signals from the database and updates the in-memory state.
 */
export async function reloadDynamicSignals(): Promise<void> {
    console.log('Reloading dynamic signals state from database...');
    try {
        const loadedSignals = await loadDynamicSignalsFromDB();
        // Replace the contents of the existing array
        dynamicSignals.length = 0; // Clear the array
        dynamicSignals.push(...loadedSignals); // Add new signals
        console.log(`Successfully reloaded ${dynamicSignals.length} dynamic signals into state.`);
    } catch (error: any) {
        console.error('Failed to reload dynamic signals state:', error.message || error);
        // Decide if we should exit or just continue with potentially stale state
    }
} 