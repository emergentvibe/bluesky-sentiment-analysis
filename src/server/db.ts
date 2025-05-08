import pg, { Pool, PoolClient, QueryResult } from 'pg';
const { Pool: PgPool } = pg;
import { MetricSignal, RawDbEntry, HistoryEntry, SentimentScores, SentimentDataDbRow, AvgWindowState } from '../types.js';
import { baseMetricKeysMap, currentEmotionKeys } from './state.js';
import { DEFAULT_METRIC_KEYS } from './config.js';
import { createEmptyScores, addScores } from './sentimentUtils.js';
import { SHORT_AVG_WINDOW_POINTS, LONG_AVG_WINDOW_POINTS } from './config.js';

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

        // Ensure sentiment_data table exists with ALL required columns
        await client.query(`
            CREATE TABLE IF NOT EXISTS sentiment_data (
                timestamp TIMESTAMPTZ NOT NULL,
                language VARCHAR(10) NOT NULL,
                signal_name VARCHAR(100) NOT NULL DEFAULT 'default',
                avg_scores JSONB NOT NULL,
                post_count INTEGER NOT NULL,
                short_avg JSONB NULL,
                long_avg JSONB NULL
            );
        `);
        console.log('Base table "sentiment_data" ensured.');

        // Ensure signal_name, short_avg, long_avg columns exist
        await client.query(`ALTER TABLE sentiment_data ADD COLUMN IF NOT EXISTS signal_name VARCHAR(100) NOT NULL DEFAULT 'default';`);
        await client.query(`ALTER TABLE sentiment_data ADD COLUMN IF NOT EXISTS short_avg JSONB;`);
        await client.query(`ALTER TABLE sentiment_data ADD COLUMN IF NOT EXISTS long_avg JSONB;`);
        console.log('Columns signal_name, short_avg, long_avg ensured.');

        // Ensure the primary key is (timestamp, language, signal_name)
        try {
            await client.query(`ALTER TABLE sentiment_data DROP CONSTRAINT IF EXISTS sentiment_data_pkey;`);
            console.log('Dropped existing primary key constraint (if necessary).');
        } catch (pkError: any) {
            console.warn(`Could not drop primary key constraint (maybe non-existent): ${pkError.message}`);
        }
        try {
             await client.query(`
                 ALTER TABLE sentiment_data
                 ADD CONSTRAINT sentiment_data_pkey PRIMARY KEY (timestamp, language, signal_name);
             `);
             console.log('Ensured primary key on (timestamp, language, signal_name).');
        } catch (pkError: any) {
             // Handle error if PK already exists (e.g., from a partial previous run)
             if (pkError.code === '42P07') { // 42P07 = duplicate_table (PostgreSQL error code for duplicate object)
                 console.log('Primary key constraint already exists.');
             } else {
                 console.error('Failed to add primary key:', pkError.message || pkError);
                 throw pkError; // Rethrow if it's not a duplicate error
             }
        }
        
        // Ensure indexes exist
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sentiment_data_timestamp ON sentiment_data (timestamp DESC);`);
        console.log('Index "idx_sentiment_data_timestamp" ensured.');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sentiment_data_lang_signal ON sentiment_data (language, signal_name, timestamp DESC);`);
        console.log('Index "idx_sentiment_data_lang_signal" ensured.');

        // Complex Keyword Filters Table (ensure it exists)
        await client.query(`
            CREATE TABLE IF NOT EXISTS complex_keyword_filters (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                description TEXT,
                keywords_json JSONB NOT NULL, -- Store keywords as JSON { "include": [...], "exclude": [...] }
                base_metric_key TEXT NULL,
                filter_language_code VARCHAR(10) NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Table "complex_keyword_filters" ensured.');

        // Add columns individually for idempotency
        await client.query(`ALTER TABLE complex_keyword_filters ADD COLUMN IF NOT EXISTS base_metric_key TEXT NULL;`);
        await client.query(`ALTER TABLE complex_keyword_filters ADD COLUMN IF NOT EXISTS filter_language_code VARCHAR(10) NULL;`);
        console.log('Columns base_metric_key, filter_language_code ensured in complex_keyword_filters.');

        // Add index on new columns for potential lookups
        await client.query(`CREATE INDEX IF NOT EXISTS idx_complex_filters_metric_lang ON complex_keyword_filters (base_metric_key, filter_language_code);`);
        console.log('Index "idx_complex_filters_metric_lang" ensured.');

        await client.query(`CREATE INDEX IF NOT EXISTS idx_complex_filters_active ON complex_keyword_filters (is_active);`);
        console.log('Index "idx_complex_filters_active" ensured.');

        // --- Lexicon Tables --- Ensure they exist ---
        console.log('Ensuring Lexicon tables exist...');

        // lexicon_languages
        await client.query(`
            CREATE TABLE IF NOT EXISTS lexicon_languages (
                language_code VARCHAR(50) PRIMARY KEY,
                language_name VARCHAR(100) NOT NULL
            );
        `);
        console.log('  Table "lexicon_languages" ensured.');

        // lexicon_emotions
        await client.query(`
            CREATE TABLE IF NOT EXISTS lexicon_emotions (
                emotion_id SERIAL PRIMARY KEY,
                emotion_name VARCHAR(100) UNIQUE NOT NULL,
                is_base_nrc BOOLEAN DEFAULT FALSE
            );
        `);
        console.log('  Table "lexicon_emotions" ensured.');

        // lexicon_words (Depends on lexicon_languages)
        await client.query(`
            CREATE TABLE IF NOT EXISTS lexicon_words (
                word_id SERIAL PRIMARY KEY,
                word_text TEXT NOT NULL,
                language_code VARCHAR(50) NOT NULL REFERENCES lexicon_languages(language_code) ON DELETE CASCADE
            );
        `);
        // Add unique constraint separately to handle IF NOT EXISTS cleanly
        try {
            await client.query(`ALTER TABLE lexicon_words ADD CONSTRAINT lexicon_words_text_lang_unique UNIQUE (word_text, language_code);`);
            console.log('  Constraint "lexicon_words_text_lang_unique" added.');
        } catch (constraintError: any) {
            if (constraintError.code === '42P07') { // constraint already exists
                console.log('  Constraint "lexicon_words_text_lang_unique" already exists.');
            } else {
                throw constraintError; // Re-throw other errors
            }
        }
        await client.query(`CREATE INDEX IF NOT EXISTS idx_lexicon_words_lang_text ON lexicon_words (language_code, word_text);`);
        console.log('  Table "lexicon_words" and indexes ensured.');

        // word_emotion_associations (Depends on lexicon_words and lexicon_emotions)
        await client.query(`
            CREATE TABLE IF NOT EXISTS word_emotion_associations (
                association_id SERIAL PRIMARY KEY,
                word_id INTEGER NOT NULL REFERENCES lexicon_words(word_id) ON DELETE CASCADE,
                emotion_id INTEGER NOT NULL REFERENCES lexicon_emotions(emotion_id) ON DELETE CASCADE
            );
        `);
        // Add unique constraint separately
        try {
            await client.query(`ALTER TABLE word_emotion_associations ADD CONSTRAINT word_emotion_assoc_unique UNIQUE (word_id, emotion_id);`);
            console.log('  Constraint "word_emotion_assoc_unique" added.');
        } catch (constraintError: any) {
            if (constraintError.code === '42P07') {
                console.log('  Constraint "word_emotion_assoc_unique" already exists.');
            } else {
                throw constraintError;
            }
        }
        await client.query(`CREATE INDEX IF NOT EXISTS idx_word_emotion_assoc_word ON word_emotion_associations (word_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_word_emotion_assoc_emotion ON word_emotion_associations (emotion_id);`);
        console.log('  Table "word_emotion_associations" and indexes ensured.');

        console.log('Lexicon tables ensured.');

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
        // Select the new columns as well
        const queryResult: QueryResult = await client.query(
            `SELECT id, name, keywords_json, description, is_active, base_metric_key, filter_language_code
             FROM complex_keyword_filters
             WHERE is_active = TRUE
             ORDER BY name ASC`
        );
        console.log(`Loaded ${queryResult.rowCount} active dynamic signals.`);
        return queryResult.rows.map(row => {
            // Map the new columns to the MetricSignal object
            const signal: MetricSignal = {
                id: row.id,
                name: row.name,
                keywords_json: row.keywords_json,
                description: row.description,
                is_active: row.is_active,
                base_metric_key: row.base_metric_key, // Add this mapping
                filter_language_code: row.filter_language_code, // Add this mapping
                type: 'filter'
            };
            // Basic validation for keywords_json
            try {
                if (typeof signal.keywords_json === 'string') {
                   JSON.parse(signal.keywords_json); // Attempt to parse if it's a string
                } else if (typeof signal.keywords_json !== 'object' || signal.keywords_json === null) {
                    throw new Error('keywords_json is not a valid object or null');
                }
                // Further validation could check for { include: [], exclude: [] } structure if needed
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
}

/**
 * Fetches pre-aggregated 10-second sentiment data points from the database.
 * No further aggregation or MA calculation is done here.
 */
export async function fetchAndAggregateData(
    languages: string[],
    dbSignalNames: string[],
    startTime: Date,
    endTime: Date,
    // intervalMs: number - No longer needed as we fetch raw stored points
): Promise<Map<string, HistoryEntry[]>> {
    console.log(`[DB] Fetching stored data. Langs: [${languages.join(',')}], DB Signals: [${dbSignalNames.join(',')}], Start: ${startTime.toISOString()}, End: ${endTime.toISOString()}`);
    let client: PoolClient | null = null;
    const finalResults = new Map<string, HistoryEntry[]>();

    // Initialize results map
    dbSignalNames.forEach(signalName => {
         languages.forEach(langCode => {
             const key = `${signalName}_${langCode}`;
             finalResults.set(key, []);
         });
    });

    try {
        client = await pool.connect();
        // Fetch the stored rows including pre-calculated averages and MAs
        const queryResult: QueryResult<SentimentDataDbRow> = await client.query(
            // Select the correct columns
            `SELECT timestamp, language, signal_name, avg_scores, post_count, short_avg, long_avg
             FROM sentiment_data
             WHERE language = ANY($1::text[])
               AND signal_name = ANY($2::text[])
               AND timestamp >= $3 -- Use >= for start time
               AND timestamp < $4  -- Use < for end time
             ORDER BY timestamp ASC`,
             // Adjust time range slightly if necessary depending on how UI sends it
            [languages, dbSignalNames, startTime, endTime]
        );

        const rawData: SentimentDataDbRow[] = queryResult.rows;
        console.log(`[DB] Fetched ${rawData.length} stored rows.`);

        if (rawData.length > 0) {
            // Group results by signalLangKey
            rawData.forEach(row => {
                const signalLangKey = `${row.signal_name}_${row.language}`;
                const historyEntry: HistoryEntry = {
                    timestamp: new Date(row.timestamp).getTime(), // Convert to number timestamp
                    avgScores: row.avg_scores, // Already the average scores
                    postCount: row.post_count,
                    shortAvg: row.short_avg,   // Use stored short MA
                    longAvg: row.long_avg     // Use stored long MA
                };
                
                // Append to the correct list in the results map
                if (finalResults.has(signalLangKey)) {
                    finalResults.get(signalLangKey)?.push(historyEntry);
                } else {
                    // Should not happen due to pre-initialization, but safety check
                    finalResults.set(signalLangKey, [historyEntry]); 
                }
            });
        }

    } catch (err: any) {
        console.error('[DB] Error in fetchAndAggregateData:', err.message || err);
    } finally {
        client?.release();
    }

    // Return the map, potentially with empty arrays for combinations with no data
    return finalResults;
}

/**
 * Loads the most recent data points for each signal/language combination
 * to initialize the moving average calculation state.
 */
export async function loadRecentMAStates(): Promise<Map<string, { short: AvgWindowState; long: AvgWindowState }>> {
    console.log('[DB] Loading recent states for MA initialization...');
    const maStates = new Map<string, { short: AvgWindowState; long: AvgWindowState }>();
    let client: PoolClient | null = null;
    const maxWindowPoints = Math.max(SHORT_AVG_WINDOW_POINTS, LONG_AVG_WINDOW_POINTS);

    try {
        client = await pool.connect();
        const distinctPairsResult: QueryResult<{ signal_name: string; language: string }> = await client.query(
            `SELECT DISTINCT signal_name, language FROM sentiment_data ORDER BY signal_name, language`
        );
        const distinctPairs = distinctPairsResult.rows;
        console.log(`[DB] Found ${distinctPairs.length} distinct signal/language pairs for MA state loading.`);

        for (const pair of distinctPairs) {
            const { signal_name, language } = pair;
            const signalLangKey = `${signal_name}_${language}`;

            const recentDataResult: QueryResult<SentimentDataDbRow> = await client.query(
                `SELECT timestamp, avg_scores
                 FROM sentiment_data
                 WHERE signal_name = $1 AND language = $2
                 ORDER BY timestamp DESC
                 LIMIT $3`,
                [signal_name, language, maxWindowPoints]
            );

            const recentEntries = recentDataResult.rows.reverse(); // oldest first

            if (recentEntries.length > 0) {
                 const baseQueue: (SentimentScores | null)[] = recentEntries.map(row => row.avg_scores);
                 const shortQueue = baseQueue.slice(-SHORT_AVG_WINDOW_POINTS);
                 const longQueue = baseQueue.slice(-LONG_AVG_WINDOW_POINTS);
                 maStates.set(signalLangKey, {
                    short: { queue: shortQueue, windowPoints: SHORT_AVG_WINDOW_POINTS },
                    long: { queue: longQueue, windowPoints: LONG_AVG_WINDOW_POINTS },
                 });
            } else {
                 maStates.set(signalLangKey, {
                    short: { queue: [], windowPoints: SHORT_AVG_WINDOW_POINTS },
                    long: { queue: [], windowPoints: LONG_AVG_WINDOW_POINTS },
                 });
            }
        }
        console.log(`[DB] Finished loading ${maStates.size} MA states.`);

    } catch (err: any) {
        console.error('[DB] Error loading recent MA states:', err.message || err);
        return new Map();
    } finally {
        client?.release();
    }
    return maStates;
}

// Function for storing aggregated data would go here (part of aggregateAndStore logic)