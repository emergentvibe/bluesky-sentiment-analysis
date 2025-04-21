import { pool } from './db.js'; // Import DB pool
import { LiveUpdateEntry, HistoryEntry, LiveUpdateMessage } from '../types.js';
import { baseMetricKeysMap, currentIntervalScores, currentIntervalPostCount, liveMAState, recentHistoryBuffer } from './state.js';
import { LIVE_UPDATE_BUFFER_MS, SHORT_AVG_WINDOW_POINTS, LONG_AVG_WINDOW_POINTS } from './config.js';
import { createEmptyScores, updateIncrementalWindowState } from './sentimentUtils.js';
import { broadcast } from './websocketServer.js';

/**
 * Aggregates scores accumulated during the interval, stores them in the database,
 * calculates moving averages, updates buffers, and broadcasts live updates.
 */
export async function aggregateAndStore(): Promise<void> {
    const timestamp = new Date();
    const bufferCutoffTime = timestamp.getTime() - LIVE_UPDATE_BUFFER_MS;
    let client = null;
    let liveUpdates: LiveUpdateEntry[] = [];
    const updatedSignalLangKeys = new Set<string>();

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const scoresToReset: typeof currentIntervalScores = {};
        const countsToReset: typeof currentIntervalPostCount = {};

        for (const langCode in currentIntervalScores) {
            if (!currentIntervalScores.hasOwnProperty(langCode)) continue;
            scoresToReset[langCode] = {}; // Initialize inner object for reset
            countsToReset[langCode] = {};

            for (const dbSignalName in currentIntervalScores[langCode]) {
                if (!currentIntervalScores[langCode].hasOwnProperty(dbSignalName)) continue;

                const accumulatedScores = currentIntervalScores[langCode][dbSignalName];
                const postCount = currentIntervalPostCount[langCode][dbSignalName];

                if (postCount > 0) {
                    const values = [timestamp, langCode, dbSignalName, JSON.stringify(accumulatedScores), postCount];
                    await client.query(
                        `INSERT INTO sentiment_data (timestamp, language, signal_name, scores, post_count)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (timestamp, language, signal_name) DO UPDATE SET
                           scores = EXCLUDED.scores,
                           post_count = EXCLUDED.post_count`,
                        values
                    );

                    const currentRawEntry: HistoryEntry = {
                        timestamp: timestamp.getTime(),
                        scores: accumulatedScores,
                        postCount: postCount
                    };

                    const signalLangKey = `${dbSignalName}_${langCode}`;
                    updatedSignalLangKeys.add(signalLangKey);

                    if (!liveMAState[signalLangKey]) {
                        liveMAState[signalLangKey] = {
                            short: { queue: [], summedScores: createEmptyScores(), summedPostCount: 0, windowPoints: SHORT_AVG_WINDOW_POINTS },
                            long: { queue: [], summedScores: createEmptyScores(), summedPostCount: 0, windowPoints: LONG_AVG_WINDOW_POINTS }
                        };
                    }
                     if (!recentHistoryBuffer[signalLangKey]) {
                         recentHistoryBuffer[signalLangKey] = [];
                     }

                    const latestShortAvg = updateIncrementalWindowState(liveMAState[signalLangKey].short, currentRawEntry);
                    const latestLongAvg = updateIncrementalWindowState(liveMAState[signalLangKey].long, currentRawEntry);

                     const entryForBuffer = { ...currentRawEntry, shortAvg: latestShortAvg, longAvg: latestLongAvg };
                    recentHistoryBuffer[signalLangKey].push(entryForBuffer);
                    recentHistoryBuffer[signalLangKey] = recentHistoryBuffer[signalLangKey]
                         .filter(entry => entry.timestamp >= bufferCutoffTime)
                         .sort((a, b) => a.timestamp - b.timestamp);

                    if (dbSignalName === 'default') {
                         baseMetricKeysMap.forEach((_, metricKey) => {
                            liveUpdates.push({
                                signalName: metricKey,
                                language: langCode,
                                timestamp: currentRawEntry.timestamp,
                                scores: currentRawEntry.scores,
                                postCount: currentRawEntry.postCount,
                                shortAvg: latestShortAvg,
                                longAvg: latestLongAvg
                            });
                         });
                    } else {
                         liveUpdates.push({
                            signalName: dbSignalName,
                            language: langCode,
                            timestamp: currentRawEntry.timestamp,
                            scores: currentRawEntry.scores,
                            postCount: currentRawEntry.postCount,
                            shortAvg: latestShortAvg,
                            longAvg: latestLongAvg
                        });
                    }
                }
                // Mark for reset even if postCount was 0
                scoresToReset[langCode][dbSignalName] = createEmptyScores();
                countsToReset[langCode][dbSignalName] = 0;
            }
        }

        await client.query('COMMIT');

        if (liveUpdates.length > 0) {
            const message: LiveUpdateMessage = {
                type: 'liveUpdate',
                payload: { updates: liveUpdates }
            };
            broadcast(message);
        }

        // Reset Interval Accumulators safely by assigning new objects
        Object.assign(currentIntervalScores, scoresToReset);
        Object.assign(currentIntervalPostCount, countsToReset);
        // Clear keys from the main objects that weren't processed (unlikely but safe)
        for (const lang in currentIntervalScores) {
            if (!scoresToReset[lang]) delete currentIntervalScores[lang];
        }
        for (const lang in currentIntervalPostCount) {
            if (!countsToReset[lang]) delete currentIntervalPostCount[lang];
        }


        // Prune Old Data
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