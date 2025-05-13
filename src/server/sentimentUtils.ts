import { SentimentScores } from '../types.js';
import { baseMetricKeysMap } from './state.js';
import { SimpleMAState } from './state.js';

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

/**
 * Calculates the simple moving average based on a queue of numbers.
 */
export function calculateSimpleMovingAverage(state: SimpleMAState, newValue: number | null): number | null {
    // Ensure queue is initialized
    if (!state.queue) {
        state.queue = [];
    }

    // Add the new value to the queue
    state.queue.push(newValue ?? 0); // Treat null as 0 for calculation continuity, adjust if needed

    // Remove oldest entry if queue exceeds window size
    if (state.queue.length > state.windowPoints) {
        state.queue.shift();
    }

    // Calculate the simple average of the numbers in the current window
    let validEntriesCount = 0;
    let currentWindowSum = 0;

    for (const value of state.queue) {
        // We pushed 0 for null, so all entries are valid numbers now
        currentWindowSum += value;
        validEntriesCount++;
    }

    // Compute MA if window has data, allowing partial window calculation
    if (validEntriesCount > 0) {
        return currentWindowSum / validEntriesCount;
    } else {
        return null; // Return null if no entries in the window
    }
}

/**
 * DEPRECATED: Calculates the simple moving average based on a queue of average scores.
 * Does not use postCount for weighting.
 */
/* // Commenting out the old MA function
export function calculateAvgMAState(state: AvgWindowState, avgScores: SentimentScores | null): SentimentScores | null {
    // Ensure queue is not null (initialize if first call)
    if (!state.queue) {
        state.queue = [];
    }

    // Add the new average score entry to the queue
    state.queue.push(avgScores);

    // Remove oldest entry if queue exceeds window size
    if (state.queue.length > state.windowPoints) {
        state.queue.shift();
    }

    // Calculate the simple average of the scores in the current window
    let validEntriesCount = 0;
    const currentWindowSum: SentimentScores = createEmptyScores();

    for (const entry of state.queue) {
        if (entry !== null) {
            addScores(currentWindowSum, entry); // Sum the scores
            validEntriesCount++;
        }
    }

    if (validEntriesCount > 0) {
        const finalAvgScores = createEmptyScores();
        baseMetricKeysMap.forEach((_, key) => {
            if (Object.prototype.hasOwnProperty.call(currentWindowSum, key)) {
                finalAvgScores[key] = currentWindowSum[key] / validEntriesCount;
            }
        });
        return finalAvgScores;
    } else {
        return null; // Return null if no valid entries in the window
    }
}
*/

// --- REMOVED Old/Deprecated MA functions --- 

/* // Commenting out - Weighted MA calculation based on total scores/counts
export function updateIncrementalWindowState(state: WindowState, newEntry: HistoryEntry): SentimentScores | null {
    if (!state.summedScores) state.summedScores = createEmptyScores();
    // newEntry now uses avgScores, this function expects total scores
    // Need to adapt or remove based on whether total scores are needed elsewhere
    // For now, assume it's not needed for MA calculation path.
    // Original logic:
    // if (newEntry.scores) { 
    //     addScores(state.summedScores, newEntry.scores); 
    // }
    // state.summedPostCount += newEntry.postCount;
    // state.queue.push(newEntry);

    // if (state.queue.length > state.windowPoints) {
    //     const oldEntry = state.queue.shift();
    //     if (oldEntry?.scores) {
    //          subtractScores(state.summedScores, oldEntry.scores);
    //          state.summedPostCount -= oldEntry.postCount;
    //     }
    // }

    // if (state.queue.length > 0 && state.summedPostCount > 0) {
    //     const avgScores = createEmptyScores(); 
    //     baseMetricKeysMap.forEach((_, key) => {
    //         if (Object.prototype.hasOwnProperty.call(state.summedScores, key)) {
    //              avgScores[key] = state.summedScores[key] / state.summedPostCount;
    //         }
    //     });
    //     return avgScores;
    // } else {
    //     return null;
    // }
    console.warn("updateIncrementalWindowState (weighted MA) is likely deprecated and needs review/removal.");
    return null; 
}
*/

/* // Commenting out - Weighted MA calculation over a batch
export function calculateSentimentMovingAverage(data: HistoryEntry[], windowPoints: number): (SentimentScores | null)[] {
     // This function expects data[i].scores to be total scores, not avgScores
     console.warn("calculateSentimentMovingAverage (weighted MA batch) is likely deprecated and needs review/removal.");
     return Array(data.length).fill(null);
}
*/

/* // Removing - This was called by handleWebSocketConnection for historical data, no longer needed
export function calculateMAsForAggregatedData(
    aggregatedData: Map<string, HistoryEntry[]>,
    intervalMs: number,
    shortWindowMs: number,
    longWindowMs: number
): Map<string, HistoryEntry[]> { 
     console.warn("calculateMAsForAggregatedData is deprecated and removed.");
    return aggregatedData; 
}
*/ 