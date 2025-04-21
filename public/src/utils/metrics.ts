import { SentimentScores } from '../types.ts';

/**
 * Gets the relevant score value from a SentimentScores object.
 * Handles metrics directly (converting to lowercase for lookup) and the 'netSentiment' case.
 */
export function getMetricValue(
    scores: SentimentScores | null | undefined,
    metric: string // e.g., "Anger", "netSentiment"
): number | null {
    // console.log(`[getMetricValue] Called with metric='${metric}'`);
    
    if (!scores) {
        // console.log(`[getMetricValue] scores is null/undefined, returning null`);
        return null;
    }
    
    // Log the available keys in the scores object
    // console.log(`[getMetricValue] Available keys in scores:`, Object.keys(scores));

    const lowerCaseMetric = metric.toLowerCase(); // Convert metric name to lowercase for lookup
    // console.log(`[getMetricValue] Looking for lowercase key: '${lowerCaseMetric}'`);

    if (lowerCaseMetric === 'netsentiment') { // Compare lowercase
        // Access scores using lowercase keys defined in SentimentScores interface
        const positive = scores['positive'] ?? 0;
        const negative = scores['negative'] ?? 0;
        const result = positive - negative;
        // console.log(`[getMetricValue] Calculated netSentiment: ${positive} - ${negative} = ${result}`);
        return result;
    } else if (scores.hasOwnProperty(lowerCaseMetric)) { // Check lowercase key
        // Access using lowercase key
        const result = scores[lowerCaseMetric] ?? null;
        // console.log(`[getMetricValue] Found key '${lowerCaseMetric}' with value:`, result);
        return result;
    } else {
        // console.log(`[getMetricValue] Key '${lowerCaseMetric}' NOT FOUND in scores object`);
        return null; // Metric key not found
    }
} 