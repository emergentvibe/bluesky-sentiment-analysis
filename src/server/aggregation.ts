import { pool } from './db.js'; // Import DB pool
import { LiveUpdateEntry, HistoryEntry, LiveUpdateMessage, SentimentScores, AvgWindowState, LiveLangVolumeUpdateEntry, LiveUpdatePayload } from '../types.js';
import { baseMetricKeysMap, currentIntervalScores, currentIntervalPostCount, liveAvgMAState, /* liveMAState, recentHistoryBuffer */ } from './state.js';
import { LIVE_UPDATE_BUFFER_MS, SHORT_AVG_WINDOW_POINTS, LONG_AVG_WINDOW_POINTS } from './config.js';
import { createEmptyScores, calculateAvgMAState /* updateIncrementalWindowState */ } from './sentimentUtils.js';
import { broadcast } from './websocketServer.js';

/**
 * Aggregates scores accumulated during the interval, calculates average scores per post,
 * calculates MAs based on average scores, stores results in the database,
 * calculates total volume per language, and broadcasts live updates.
 */
export async function aggregateAndStore(): Promise<void> {
    const timestamp = new Date();
    // bufferCutoffTime might not be needed if recentHistoryBuffer is removed/repurposed
    // const bufferCutoffTime = timestamp.getTime() - LIVE_UPDATE_BUFFER_MS;
    let client = null;
    let liveUpdates: LiveUpdateEntry[] = [];
    // updatedSignalLangKeys might not be needed if recentHistoryBuffer is removed
    // const updatedSignalLangKeys = new Set<string>();

    const scoresToReset: typeof currentIntervalScores = {};
    const countsToReset: typeof currentIntervalPostCount = {};
    // Map to store total post count per language for this interval
    const intervalTotalVolumeByLang: { [lang: string]: number } = {};

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        for (const langCode in currentIntervalScores) {
            if (!currentIntervalScores.hasOwnProperty(langCode)) continue;
            scoresToReset[langCode] = {};
            countsToReset[langCode] = {};
            // Initialize language volume counter
            if (intervalTotalVolumeByLang[langCode] === undefined) {
                 intervalTotalVolumeByLang[langCode] = 0;
            }

            for (const dbSignalName in currentIntervalScores[langCode]) {
                if (!currentIntervalScores[langCode].hasOwnProperty(dbSignalName)) continue;

                const accumulatedScores = currentIntervalScores[langCode][dbSignalName];
                const postCount = currentIntervalPostCount[langCode][dbSignalName];
                
                // Accumulate total volume for the language
                intervalTotalVolumeByLang[langCode] += postCount;

                let avgScores: SentimentScores = createEmptyScores();
                let shortAvg: SentimentScores | null = null;
                let longAvg: SentimentScores | null = null;

                if (postCount > 0) {
                    // 1. Calculate Average Scores per Post for the interval
                    // Overwrite avgScores with calculated values
                    baseMetricKeysMap.forEach((_, key) => {
                        if (Object.prototype.hasOwnProperty.call(accumulatedScores, key)) {
                            avgScores[key] = accumulatedScores[key] / postCount;
                        }
                    });

                    // 2. Calculate MAs based on Average Scores
                    const signalLangKey = `${dbSignalName}_${langCode}`;
                    if (!liveAvgMAState[signalLangKey]) {
                        // Initialize state
                        liveAvgMAState[signalLangKey] = { short: { queue: [], windowPoints: SHORT_AVG_WINDOW_POINTS }, long: { queue: [], windowPoints: LONG_AVG_WINDOW_POINTS } };
                    }
                    shortAvg = calculateAvgMAState(liveAvgMAState[signalLangKey].short, avgScores);
                    longAvg = calculateAvgMAState(liveAvgMAState[signalLangKey].long, avgScores);

                    // 3. Store in DB 
                    const values = [ timestamp, langCode, dbSignalName, JSON.stringify(avgScores), postCount, shortAvg ? JSON.stringify(shortAvg) : null, longAvg ? JSON.stringify(longAvg) : null ];
                    await client.query(
                        `INSERT INTO sentiment_data (timestamp, language, signal_name, avg_scores, post_count, short_avg, long_avg)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         ON CONFLICT (timestamp, language, signal_name) DO UPDATE SET
                           avg_scores = EXCLUDED.avg_scores,
                           post_count = EXCLUDED.post_count,
                           short_avg = EXCLUDED.short_avg,
                           long_avg = EXCLUDED.long_avg`,
                        values
                    );

                } else {
                    // Handle 0 posts: avgScores is already initialized to 0s
                    const signalLangKey = `${dbSignalName}_${langCode}`;
                    if (!liveAvgMAState[signalLangKey]) {
                         // Initialize state
                         liveAvgMAState[signalLangKey] = { short: { queue: [], windowPoints: SHORT_AVG_WINDOW_POINTS }, long: { queue: [], windowPoints: LONG_AVG_WINDOW_POINTS } };
                    }
                    // Update MAs using the 0 avgScores
                    shortAvg = calculateAvgMAState(liveAvgMAState[signalLangKey].short, avgScores); 
                    longAvg = calculateAvgMAState(liveAvgMAState[signalLangKey].long, avgScores); 

                    // Store 0 posts / 0 avg score / resulting MAs
                    const values = [ timestamp, langCode, dbSignalName, JSON.stringify(avgScores), postCount, shortAvg ? JSON.stringify(shortAvg) : null, longAvg ? JSON.stringify(longAvg) : null ];
                    await client.query(
                        `INSERT INTO sentiment_data (timestamp, language, signal_name, avg_scores, post_count, short_avg, long_avg)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         ON CONFLICT (timestamp, language, signal_name) DO UPDATE SET
                           avg_scores = EXCLUDED.avg_scores, post_count = EXCLUDED.post_count, short_avg = EXCLUDED.short_avg, long_avg = EXCLUDED.long_avg`,
                        values
                    );
                }

                // --- Prepare Live Update Payloads --- 
                // avgScores is guaranteed non-null here
                if (dbSignalName === 'default') {
                    baseMetricKeysMap.forEach((_, metricKey) => {
                        liveUpdates.push({
                            signalName: metricKey,
                            language: langCode,
                            timestamp: timestamp.getTime(),
                            avgScores: avgScores, // Send avg scores
                            postCount: postCount,
                            shortAvg: shortAvg,   // Send latest calculated short MA
                            longAvg: longAvg    // Send latest calculated long MA
                        });
                    });
                } else {
                    liveUpdates.push({
                        signalName: dbSignalName,
                        language: langCode,
                        timestamp: timestamp.getTime(),
                        avgScores: avgScores,
                        postCount: postCount,
                        shortAvg: shortAvg,
                        longAvg: longAvg
                    });
                }

                // Mark accumulators for reset
                scoresToReset[langCode][dbSignalName] = createEmptyScores();
                countsToReset[langCode][dbSignalName] = 0;
            }
        }

        await client.query('COMMIT');

        // --- Create Language Volume Updates --- 
        const langVolumeUpdates: LiveLangVolumeUpdateEntry[] = [];
        for (const langCode in intervalTotalVolumeByLang) {
             if (intervalTotalVolumeByLang.hasOwnProperty(langCode)) {
                 langVolumeUpdates.push({
                     language: langCode,
                     timestamp: timestamp.getTime(),
                     totalPostCount: intervalTotalVolumeByLang[langCode]
                 });
             }
        }

        // --- Broadcast Live Updates (including langVolumes) --- 
        if (liveUpdates.length > 0 || langVolumeUpdates.length > 0) { // Broadcast if there's either type of update
            const payload: LiveUpdatePayload = {
                updates: liveUpdates,
                langVolumes: langVolumeUpdates
            };
            const message: LiveUpdateMessage = {
                type: 'liveUpdate',
                payload: payload
            };
            broadcast(message);
        }

        // --- Reset Interval Accumulators --- 
        Object.assign(currentIntervalScores, scoresToReset);
        Object.assign(currentIntervalPostCount, countsToReset);
        for (const lang in currentIntervalScores) {
            if (!scoresToReset[lang]) delete currentIntervalScores[lang];
        }
        for (const lang in currentIntervalPostCount) {
            if (!countsToReset[lang]) delete currentIntervalPostCount[lang];
        }

        // --- Prune Old Data --- 
        const PRUNE_AGE_MS = 31 * 24 * 60 * 60 * 1000;
        const pruneTimestamp = new Date(Date.now() - PRUNE_AGE_MS);
        const pruneResult = await client.query('DELETE FROM sentiment_data WHERE timestamp < $1', [pruneTimestamp]);
        if (pruneResult.rowCount !== null && pruneResult.rowCount > 0) {
            console.log(`Pruned ${pruneResult.rowCount} old rows from sentiment_data.`);
        }

    } catch (error: any) {
        if (client) await client.query('ROLLBACK');
        console.error('Error during aggregation and storage:', error.message || error);
        console.error(error.stack);
    } finally {
        client?.release();
    }
} 