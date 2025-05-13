import { pool } from './db.js'; // Import DB pool
import { SentimentScores } from '../types.js';
import { baseMetricKeysMap, currentIntervalScores, currentIntervalPostCount, liveAvgMAState, SimpleMAState } from './state.js';
import { SHORT_AVG_WINDOW_POINTS, LONG_AVG_WINDOW_POINTS } from './config.js';
import { createEmptyScores, calculateSimpleMovingAverage } from './sentimentUtils.js';

/**
 * Aggregates scores accumulated during the interval, calculates average scores per post,
 * calculates MAs based on average scores, stores results in the database,
 * calculates total volume per language, and broadcasts live updates.
 */
export async function aggregateAndStore(): Promise<void> {
    const timestamp = new Date();
    let client = null;
    const rowsToInsert: any[][] = []; // Array to hold rows for batch insert

    const scoresToReset: typeof currentIntervalScores = {};
    const countsToReset: typeof currentIntervalPostCount = {};

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        for (const langCode in currentIntervalScores) {
            if (!currentIntervalScores.hasOwnProperty(langCode)) continue;
            scoresToReset[langCode] = {};
            countsToReset[langCode] = {};

            for (const dbSignalName in currentIntervalScores[langCode]) {
                if (!currentIntervalScores[langCode].hasOwnProperty(dbSignalName)) continue;

                const postCount = currentIntervalPostCount[langCode][dbSignalName];
                
                // --- Process 'post_count' metric --- 
                const postCountMetricName = 'post_count';
                const postCountRawValue = postCount; // Raw value is just the count for this interval
                const postCountKey = `${dbSignalName}_${langCode}_${postCountMetricName}`;

                // Initialize state if not present - TEMPORARILY COMMENTED OUT
                /*
                if (!liveAvgMAState[postCountKey]) {
                    liveAvgMAState[postCountKey] = {
                        short: { queue: [], windowPoints: SHORT_AVG_WINDOW_POINTS },
                        long: { queue: [], windowPoints: LONG_AVG_WINDOW_POINTS }
                    };
                }
                */

                // Calculate MAs for post_count - TEMPORARILY SET TO NULL
                const shortMaPostCount = null; // calculateSimpleMovingAverage(liveAvgMAState[postCountKey].short, postCountRawValue);
                const longMaPostCount = null; // calculateSimpleMovingAverage(liveAvgMAState[postCountKey].long, postCountRawValue);

                // Add row for post_count metric
                rowsToInsert.push([
                    timestamp,
                    langCode,
                    dbSignalName,
                    postCountMetricName,
                    postCountRawValue,
                    shortMaPostCount,
                    longMaPostCount
                ]);

                // --- Process Sentiment Metrics --- 
                const accumulatedScores = currentIntervalScores[langCode][dbSignalName]; // Get the scores for this lang/signal

                baseMetricKeysMap.forEach((_, metricName) => {
                    // Calculate raw_value (average score for this metric in the interval)
                    let rawValue = 0;
                    if (postCount > 0 && accumulatedScores && typeof accumulatedScores[metricName] === 'number') {
                        rawValue = accumulatedScores[metricName] / postCount;
                    }

                    const metricKey = `${dbSignalName}_${langCode}_${metricName}`;

                    // Initialize state if not present - TEMPORARILY COMMENTED OUT
                    /*
                    if (!liveAvgMAState[metricKey]) {
                        liveAvgMAState[metricKey] = {
                            short: { queue: [], windowPoints: SHORT_AVG_WINDOW_POINTS },
                            long: { queue: [], windowPoints: LONG_AVG_WINDOW_POINTS }
                        };
                    }
                    */

                    // Calculate MAs for this sentiment metric - TEMPORARILY SET TO NULL
                    const shortMaValue = null; // calculateSimpleMovingAverage(liveAvgMAState[metricKey].short, rawValue);
                    const longMaValue = null; // calculateSimpleMovingAverage(liveAvgMAState[metricKey].long, rawValue);

                    // Add row for this sentiment metric
                    rowsToInsert.push([
                        timestamp,
                        langCode,
                        dbSignalName,
                        metricName,
                        rawValue,
                        shortMaValue,
                        longMaValue
                    ]);
                    });

                // Mark accumulators for reset
                scoresToReset[langCode][dbSignalName] = createEmptyScores();
                countsToReset[langCode][dbSignalName] = 0;
            }
        }

        // --- Batch Insert into sentiment_metrics --- 
        if (rowsToInsert.length > 0) {
            // Use pg-format or build the query string carefully if not using a library
            // Simple example (vulnerable to large number of rows potentially exceeding limits, consider batching if needed)
            const placeholders = rowsToInsert.map((_, index) => 
                `($${index * 7 + 1}, $${index * 7 + 2}, $${index * 7 + 3}, $${index * 7 + 4}, $${index * 7 + 5}, $${index * 7 + 6}, $${index * 7 + 7})`
            ).join(',');
            const flatValues = rowsToInsert.flat();
            
            const insertQuery = `
                INSERT INTO sentiment_metrics (timestamp, language, signal_name, metric_name, raw_value, short_ma_value, long_ma_value)
                VALUES ${placeholders}
                ON CONFLICT (timestamp, language, signal_name, metric_name) DO UPDATE SET
                    raw_value = EXCLUDED.raw_value,
                    short_ma_value = EXCLUDED.short_ma_value,
                    long_ma_value = EXCLUDED.long_ma_value;
            `;
            
            await client.query(insertQuery, flatValues);
            console.log(`Inserted/Updated ${rowsToInsert.length} rows in sentiment_metrics.`);
        }

        await client.query('COMMIT');

        // --- Reset Interval Accumulators --- 
        Object.assign(currentIntervalScores, scoresToReset);
        Object.assign(currentIntervalPostCount, countsToReset);
        for (const lang in currentIntervalScores) {
            if (!scoresToReset[lang]) delete currentIntervalScores[lang];
        }
        for (const lang in currentIntervalPostCount) {
            if (!countsToReset[lang]) delete currentIntervalPostCount[lang];
        }

        // --- Prune Old Data from sentiment_metrics --- 
        const PRUNE_AGE_MS = 31 * 24 * 60 * 60 * 1000;
        const pruneTimestamp = new Date(Date.now() - PRUNE_AGE_MS);
        // Use a separate client connection for pruning or handle potential long-running query
        let pruneClient = null;
        try {
            pruneClient = await pool.connect();
            const pruneResult = await pruneClient.query('DELETE FROM sentiment_metrics WHERE timestamp < $1', [pruneTimestamp]);
        if (pruneResult.rowCount !== null && pruneResult.rowCount > 0) {
                console.log(`Pruned ${pruneResult.rowCount} old rows from sentiment_metrics.`);
            }
        } catch (pruneError: any) {
            console.error('Error during pruning:', pruneError.message || pruneError);
        } finally {
            pruneClient?.release();
        }

    } catch (error: any) {
        if (client) await client.query('ROLLBACK');
        console.error('Error during aggregation and storage:', error.message || error);
        console.error(error.stack);
    } finally {
        // Ensure the main transaction client is released even if pruning fails
        /* if (client && !client.release) { // Check if it might have been released by prune error handling (unlikely but safe)
             client.release();
        } */
        client?.release(); // Always release the client if it was acquired
    }
} 