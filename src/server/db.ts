import pg, { Pool, PoolClient, QueryResult } from 'pg';
const { Pool: PgPool } = pg;
import { MetricSignal, RawDbEntry, HistoryEntry, SentimentScores } from '../types.js';
import { baseMetricKeysMap, currentEmotionKeys } from './state.js';
import { DEFAULT_METRIC_KEYS } from './config.js';
import { createEmptyScores, addScores } from './sentimentUtils.js';

// Validate that the DATABASE_URL environment variable is set.
if (!process.env.DATABASE_URL) {
    console.error('CRITICAL: DATABASE_URL environment variable is not set.');
    process.exit(1);
}

// Create and export the PostgreSQL connection pool.
export const pool: Pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err: Error) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

/**
 * Initializes the PostgreSQL database.
 */
export async function initializeDatabase(): Promise<void> {
    console.log('Initializing database...');
    let client: PoolClient | null = null;
    try {
        client = await pool.connect();
        // ... (rest of initializeDatabase function remains the same)
        await client.query(`CREATE INDEX IF NOT EXISTS idx_complex_filters_active ON complex_keyword_filters (is_active);`);
        console.log('Index "idx_complex_filters_active" ensured.');

    } catch (err: any) {
        console.error('Database initialization failed:', err.message || err);
        process.exit(1);
    } finally {
        client?.release();
    }
}

/**
 * Loads all emotion keys (names) from the lexicon_emotions table.
 * Also populates the baseMetricKeysMap. Stores keys in lowercase.
 * Modifies state directly.
 */
export async function loadEmotionKeysFromDB(): Promise<void> {
    console.log('Loading emotion keys from database...');
    let client: PoolClient | null = null;
    let keys: string[] = [];
    try {
        client = await pool.connect();
        baseMetricKeysMap.clear();
        const queryResult = await client.query('SELECT emotion_name FROM lexicon_emotions ORDER BY emotion_name ASC');
        keys = queryResult.rows.map(row => {
            const key = row.emotion_name.toLowerCase();
            baseMetricKeysMap.set(key, true);
            return key;
        });
        DEFAULT_METRIC_KEYS.forEach(key => {
            const lowerKey = key.toLowerCase();
            if (!baseMetricKeysMap.has(lowerKey)) {
                baseMetricKeysMap.set(lowerKey, true);
                keys.push(lowerKey);
            }
        });
        console.log(`Loaded ${baseMetricKeysMap.size} base metric/emotion keys: ${Array.from(baseMetricKeysMap.keys()).join(', ')}`);
    } catch (err: any) {
        console.error('Error loading emotion keys from database:', err.message || err);
        console.warn('Falling back to default emotion keys due to DB error.');
        keys = [...DEFAULT_METRIC_KEYS.map(k => k.toLowerCase())];
        keys.forEach(key => baseMetricKeysMap.set(key, true));
    } finally {
        client?.release();
    }
    // Update the imported state variable directly
    currentEmotionKeys.length = 0;
    currentEmotionKeys.push(...keys);
}

/**
 * Loads active dynamic signals (complex keyword filters) from the database.
 */
export async function loadDynamicSignalsFromDB(): Promise<MetricSignal[]> {
    console.log('Loading dynamic signals from database...');
    let client: PoolClient | null = null;
    try {
        client = await pool.connect();
        const queryResult: QueryResult<MetricSignal> = await client.query(
            `SELECT id, name, keywords_json, description, is_active
             FROM complex_keyword_filters
             WHERE is_active = TRUE
             ORDER BY name ASC`
        );
        console.log(`Loaded ${queryResult.rowCount} active dynamic signals.`);
        return queryResult.rows.map(row => {
            const signal: MetricSignal = {
                id: row.id,
                name: row.name,
                keywords_json: row.keywords_json,
                description: row.description,
                is_active: row.is_active,
                type: 'filter'
            };
            try {
                if (typeof signal.keywords_json === 'string') {
                   JSON.parse(signal.keywords_json);
                } else if (typeof signal.keywords_json !== 'object' || signal.keywords_json === null) {
                    throw new Error('keywords_json is not a valid object');
                }
                return signal;
            } catch (e: any) {
                console.error(`Invalid JSON in keywords_json for signal id ${signal.id} (${signal.name}): ${e.message}. Skipping.`);
                return null;
            }
        }).filter((row): row is MetricSignal => row !== null);
    } catch (err: any) {
        console.error('Error loading dynamic signals from database:', err.message || err);
        return []; // Return empty array on error
    } finally {
        client?.release();
    }
    // Unreachable, but satisfies compiler
    return [];
}

/**
 * Fetches and aggregates sentiment data from the database for specified languages and signal names.
 */
export async function fetchAndAggregateData(
    languages: string[],
    dbSignalNames: string[],
    startTime: Date,
    endTime: Date,
    intervalMs: number
): Promise<Map<string, HistoryEntry[]>> {
    console.log(`[DB] fetchAndAggregateData called. Langs: [${languages.join(',')}], DB Signals: [${dbSignalNames.join(',')}], Start: ${startTime.toISOString()}, End: ${endTime.toISOString()}, Interval: ${intervalMs}ms`);
    let client: PoolClient | null = null;
    // Initialize maps
    const buckets = new Map<string, Map<number, { scores: SentimentScores, postCount: number }>>();
    const finalResults = new Map<string, HistoryEntry[]>();
    const keysToProcess = Array.from(baseMetricKeysMap.keys());

    dbSignalNames.forEach(signalName => {
         languages.forEach(langCode => {
             const key = `${signalName}_${langCode}`;
             finalResults.set(key, []); // Initialize with empty array
             buckets.set(key, new Map());
         });
    });

    try {
        client = await pool.connect();
        const queryResult: QueryResult<RawDbEntry & { language: string, signal_name: string }> = await client.query(
            `SELECT timestamp, language, signal_name, scores, post_count
             FROM sentiment_data
             WHERE language = ANY($1::text[])
               AND signal_name = ANY($2::text[])
               AND timestamp BETWEEN $3 AND $4
             ORDER BY timestamp ASC`,
            [languages, dbSignalNames, new Date(startTime.getTime() - intervalMs), new Date(endTime.getTime() + intervalMs)]
        );

        const rawData: (RawDbEntry & { language: string, signal_name: string })[] = queryResult.rows;
        console.log(`[DB] Fetched ${rawData.length} raw rows for ${languages.length} langs and ${dbSignalNames.length} DB signals.`);

        if (rawData.length === 0) {
            console.log('[DB] No raw data found for the specified criteria.');
            // Return the initialized map with empty arrays
            // No need to release client here, finally block handles it
        } else {
            // Aggregate into buckets
            rawData.forEach(row => {
                const signalLangKey = `${row.signal_name}_${row.language}`;
                const bucketTimestamp = Math.floor(new Date(row.timestamp).getTime() / intervalMs) * intervalMs;
                const signalBuckets = buckets.get(signalLangKey);
                if (!signalBuckets) {
                    console.warn(`[DB Aggregation] Encountered unexpected signalLangKey: ${signalLangKey}. Skipping row.`);
                    return;
                }
                if (!signalBuckets.has(bucketTimestamp)) {
                    signalBuckets.set(bucketTimestamp, { scores: createEmptyScores(), postCount: 0 });
                }
                const bucketData = signalBuckets.get(bucketTimestamp)!;
                const lowerCaseDbScores: SentimentScores = {};
                for(const key in row.scores) {
                     if (Object.prototype.hasOwnProperty.call(row.scores, key)) {
                          lowerCaseDbScores[key.toLowerCase()] = row.scores[key];
                     }
                }
                addScores(bucketData.scores, lowerCaseDbScores);
                const count = row.postCount ?? (row as any).post_count ?? 0;
                bucketData.postCount += count;
            });

            // Convert buckets to HistoryEntry arrays
            buckets.forEach((signalBuckets, signalLangKey) => {
                const aggregatedResults: HistoryEntry[] = [];
                signalBuckets.forEach((bucketData, timestamp) => {
                    if (timestamp < startTime.getTime() || timestamp >= endTime.getTime()) {
                        return;
                    }
                    const avgScores = createEmptyScores();
                    if (bucketData.postCount > 0) {
                        keysToProcess.forEach(key => {
                            if (Object.prototype.hasOwnProperty.call(bucketData.scores, key)) {
                                avgScores[key] = bucketData.scores[key] / bucketData.postCount;
                            }
                        });
                    }
                    aggregatedResults.push({
                        timestamp: timestamp,
                        scores: avgScores,
                        postCount: bucketData.postCount
                    });
                });
                aggregatedResults.sort((a, b) => a.timestamp - b.timestamp);
                finalResults.set(signalLangKey, aggregatedResults);
            });
            console.log(`[DB] Finished aggregation.`);
        }
    } catch (err: any) {
        console.error('[DB] Error in fetchAndAggregateData:', err.message || err);
        // Return the initialized (potentially empty) map on error
    } finally {
        client?.release();
    }
    // Ensure the function always returns the map
    return finalResults;
}

// Function for storing aggregated data would go here (part of aggregateAndStore logic)