import { SentimentScores, WindowState, HistoryEntry } from '../types.js';
import { baseMetricKeysMap } from './state.js';

/**
 * Creates an empty SentimentScores object with all current keys initialized to 0.
 * Uses the globally populated baseMetricKeysMap (lowercase keys).
 */
export function createEmptyScores(): SentimentScores {
    const scores: SentimentScores = {};
    baseMetricKeysMap.forEach((_, key) => {
        scores[key] = 0;
    });
    return scores;
}

/**
 * Adds the values from source SentimentScores to target SentimentScores.
 */
export function addScores(target: SentimentScores, source: SentimentScores): void {
    baseMetricKeysMap.forEach((_, key) => {
        target[key] = (target[key] || 0) + (source[key] || 0);
    });
}

/**
 * Subtracts the values from source SentimentScores from target SentimentScores.
 */
export function subtractScores(target: SentimentScores, source: SentimentScores): void {
    baseMetricKeysMap.forEach((_, key) => {
        target[key] = (target[key] || 0) - (source[key] || 0);
    });
}

/** Updates incremental MA window state and returns new average. */
export function updateIncrementalWindowState(state: WindowState, newEntry: HistoryEntry): SentimentScores | null {
    if (!state.summedScores) state.summedScores = createEmptyScores();
    if (newEntry.scores) {
        addScores(state.summedScores, newEntry.scores);
    }
    state.summedPostCount += newEntry.postCount;
    state.queue.push(newEntry);

    if (state.queue.length > state.windowPoints) {
        const oldEntry = state.queue.shift();
        if (oldEntry?.scores) {
             subtractScores(state.summedScores, oldEntry.scores);
             state.summedPostCount -= oldEntry.postCount;
        }
    }

    if (state.queue.length > 0 && state.summedPostCount > 0) {
        const avgScores = createEmptyScores();
        baseMetricKeysMap.forEach((_, key) => {
            if (Object.prototype.hasOwnProperty.call(state.summedScores, key)) {
                 avgScores[key] = state.summedScores[key] / state.summedPostCount;
            }
        });
        return avgScores;
    } else {
        return null;
    }
}

/**
 * Calculates moving averages for sentiment scores, weighted by post count.
 */
export function calculateSentimentMovingAverage(data: HistoryEntry[], windowPoints: number): (SentimentScores | null)[] {
     const result: (SentimentScores | null)[] = Array(data.length).fill(null);
     const keysToAverage = Array.from(baseMetricKeysMap.keys());
     const runningSums: SentimentScores = createEmptyScores();
     let runningCount = 0;
     const windowQueue: HistoryEntry[] = [];

     for (let i = 0; i < data.length; i++) {
         const currentEntry = data[i];
         if (currentEntry.scores) {
            addScores(runningSums, currentEntry.scores);
            runningCount += currentEntry.postCount;
         }
         windowQueue.push(currentEntry);

         if (windowQueue.length > windowPoints) {
             const oldestEntry = windowQueue.shift();
             if (oldestEntry?.scores) {
                 subtractScores(runningSums, oldestEntry.scores);
                 runningCount -= oldestEntry.postCount;
             }
         }

         if (runningCount > 0) {
             const avgScores = createEmptyScores();
             keysToAverage.forEach(key => {
                 if (Object.prototype.hasOwnProperty.call(runningSums, key)) {
                     avgScores[key] = runningSums[key] / runningCount;
                 }
             });
             result[i] = avgScores;
         } else {
             result[i] = null;
         }
     }
     return result;
}

/**
 * Calculates MAs for aggregated data (Map keyed by dbSignalName_langCode).
 */
export function calculateMAsForAggregatedData(
    aggregatedData: Map<string, HistoryEntry[]>, // Key: dbSignalName_langCode
    intervalMs: number,
    shortWindowMs: number,
    longWindowMs: number
): Map<string, HistoryEntry[]> { // Returns map keyed by dbSignalName_langCode
     console.log(`Calculating MAs (Short: ${shortWindowMs/60000}m, Long: ${longWindowMs/60000}m) for ${aggregatedData.size} signal/language combinations.`);
    aggregatedData.forEach((signalLangData, signalLangKey) => {
        if (signalLangData.length === 0) {
             return;
        }
        const shortPoints = Math.max(1, Math.round(shortWindowMs / intervalMs));
        const longPoints = Math.max(1, Math.round(longWindowMs / intervalMs));
        const shortMA = calculateSentimentMovingAverage(signalLangData, shortPoints);
        const longMA = calculateSentimentMovingAverage(signalLangData, longPoints);
        for (let i = 0; i < signalLangData.length; i++) {
            signalLangData[i].shortAvg = shortMA[i];
            signalLangData[i].longAvg = longMA[i];
        }
    });
    return aggregatedData;
} 