import pg, { Pool, PoolClient, QueryResult } from 'pg';
const { Pool: PgPool } = pg;
import { MetricSignal, SentimentScores, SentimentMetricRow } from '../types.js';
import { baseMetricKeysMap, currentEmotionKeys, liveAvgMAState } from './state.js';
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

        // --- NEW: Normalized sentiment_metrics table --- 
        console.log('Ensuring table "sentiment_metrics" exists...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS sentiment_metrics (
                timestamp TIMESTAMPTZ NOT NULL,
                language TEXT NOT NULL,
                signal_name TEXT NOT NULL, -- e.g., 'default', 'filter_eng_mathematics_hash123'
                metric_name TEXT NOT NULL, -- e.g., 'joy', 'anger', 'post_count'
                raw_value DOUBLE PRECISION, -- Use DOUBLE PRECISION (float8) for averages/MAs
                short_ma_value DOUBLE PRECISION,
                long_ma_value DOUBLE PRECISION,
                PRIMARY KEY (timestamp, language, signal_name, metric_name)
            );
        `);
        console.log('Table "sentiment_metrics" ensured.');

        // --- Indexes for sentiment_metrics ---
        console.log('Ensuring indexes for "sentiment_metrics"...');
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_sentiment_metrics_query 
            ON sentiment_metrics (timestamp DESC, language, signal_name, metric_name);
        `);
        console.log('  Index "idx_sentiment_metrics_query" ensured.');
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_sentiment_metrics_signal_time 
            ON sentiment_metrics (signal_name, timestamp DESC);
        `);
        console.log('  Index "idx_sentiment_metrics_signal_time" ensured.');
             await client.query(`
            CREATE INDEX IF NOT EXISTS idx_sentiment_metrics_metric_time 
            ON sentiment_metrics (metric_name, timestamp DESC);
        `);
        console.log('  Index "idx_sentiment_metrics_metric_time" ensured.');
        console.log('Indexes for "sentiment_metrics" ensured.');

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

        await client.query(`CREATE INDEX IF NOT EXISTS idx_complex_filters_metric_lang ON complex_keyword_filters (base_metric_key, filter_language_code);`);
        console.log('Index "idx_complex_filters_metric_lang" ensured.');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_complex_filters_active ON complex_keyword_filters (is_active);`);
        console.log('Index "idx_complex_filters_active" ensured.');

        // --- Lexicon Tables --- Ensure they exist ---
        console.log('Ensuring Lexicon tables exist...');
        await client.query(`CREATE TABLE IF NOT EXISTS lexicon_languages (language_code VARCHAR(50) PRIMARY KEY, language_name VARCHAR(100) NOT NULL);`);
        console.log('  Table "lexicon_languages" ensured.');
        await client.query(`CREATE TABLE IF NOT EXISTS lexicon_emotions (emotion_id SERIAL PRIMARY KEY, emotion_name VARCHAR(100) UNIQUE NOT NULL, is_base_nrc BOOLEAN DEFAULT FALSE);`);
        console.log('  Table "lexicon_emotions" ensured.');
        await client.query(`CREATE TABLE IF NOT EXISTS lexicon_words (word_id SERIAL PRIMARY KEY, word_text TEXT NOT NULL, language_code VARCHAR(50) NOT NULL REFERENCES lexicon_languages(language_code) ON DELETE CASCADE);`);
        try {
            await client.query(`ALTER TABLE lexicon_words ADD CONSTRAINT lexicon_words_text_lang_unique UNIQUE (word_text, language_code);`);
            console.log('  Constraint "lexicon_words_text_lang_unique" added.');
        } catch (constraintError: any) {
            if (constraintError.code === '42P07') { console.log('  Constraint "lexicon_words_text_lang_unique" already exists.'); } else { throw constraintError; }
        }
        await client.query(`CREATE INDEX IF NOT EXISTS idx_lexicon_words_lang_text ON lexicon_words (language_code, word_text);`);
        console.log('  Table "lexicon_words" and indexes ensured.');
        await client.query(`CREATE TABLE IF NOT EXISTS word_emotion_associations (association_id SERIAL PRIMARY KEY, word_id INTEGER NOT NULL REFERENCES lexicon_words(word_id) ON DELETE CASCADE, emotion_id INTEGER NOT NULL REFERENCES lexicon_emotions(emotion_id) ON DELETE CASCADE);`);
        try {
            await client.query(`ALTER TABLE word_emotion_associations ADD CONSTRAINT word_emotion_assoc_unique UNIQUE (word_id, emotion_id);`);
            console.log('  Constraint "word_emotion_assoc_unique" added.');
        } catch (constraintError: any) {
            if (constraintError.code === '42P07') { console.log('  Constraint "word_emotion_assoc_unique" already exists.'); } else { throw constraintError; }
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
        const queryResult: QueryResult = await client.query(
            `SELECT id, name, keywords_json, description, is_active, base_metric_key, filter_language_code
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
                base_metric_key: row.base_metric_key,
                filter_language_code: row.filter_language_code,
                type: 'filter'
            };
            try {
                if (typeof signal.keywords_json === 'string') {
                   JSON.parse(signal.keywords_json);
                } else if (typeof signal.keywords_json !== 'object' || signal.keywords_json === null) {
                    throw new Error('keywords_json is not a valid object or null');
                }
                return signal;
            } catch (e: any) {
                console.error(`Invalid JSON in keywords_json for signal id ${signal.id} (${signal.name}): ${e.message}. Skipping.`);
                return null;
            }
        }).filter((row): row is MetricSignal => row !== null);
    } catch (err: any) {
        console.error('Error loading dynamic signals from database:', err.message || err);
        return [];
    } finally {
        client?.release();
    }
}

/**
 * Loads the most recent data points for each signal/language/metric combination
 * from the `sentiment_metrics` table to initialize the moving average calculation state.
 * Returns a Map compatible with the new `liveAvgMAState` structure.
 */
export async function loadRecentMAStates(): Promise<typeof liveAvgMAState> { 
    console.log('[DB] Loading recent states for NUMERIC MA initialization...');
    const maStates: typeof liveAvgMAState = {}; 
    let client: PoolClient | null = null;
    const maxWindowPoints = Math.max(SHORT_AVG_WINDOW_POINTS, LONG_AVG_WINDOW_POINTS);

    try {
        client = await pool.connect();
        const recentTimeCutoff = new Date(Date.now() - (24 * 60 * 60 * 1000)); 
        const distinctKeysResult: QueryResult<{ language: string; signal_name: string; metric_name: string }> = await client.query(
            `SELECT DISTINCT language, signal_name, metric_name 
             FROM sentiment_metrics
             WHERE timestamp >= $1
             ORDER BY language, signal_name, metric_name`, 
             [recentTimeCutoff]
        );
        const distinctKeys = distinctKeysResult.rows;
        console.log(`[DB] Found ${distinctKeys.length} distinct language/signal/metric keys for MA state loading (from recent data).`);

        for (const keyTuple of distinctKeys) {
            const { language, signal_name, metric_name } = keyTuple;
            const signalLangMetricKey = `${signal_name}_${language}_${metric_name}`;

            const recentDataResult: QueryResult<SentimentMetricRow> = await client.query(
                `SELECT timestamp, raw_value 
                 FROM sentiment_metrics
                 WHERE language = $1 AND signal_name = $2 AND metric_name = $3
                 ORDER BY timestamp DESC
                 LIMIT $4`,
                [language, signal_name, metric_name, maxWindowPoints]
            );

            const recentValues = recentDataResult.rows.reverse().map(row => row.raw_value ?? 0); 

            maStates[signalLangMetricKey] = {
                short: { 
                    queue: recentValues.slice(-SHORT_AVG_WINDOW_POINTS),
                    windowPoints: SHORT_AVG_WINDOW_POINTS 
                },
                long: { 
                    queue: recentValues.slice(-LONG_AVG_WINDOW_POINTS), 
                    windowPoints: LONG_AVG_WINDOW_POINTS 
                },
            };
        }
        console.log(`[DB] Finished loading ${Object.keys(maStates).length} NUMERIC MA states.`);

    } catch (err: any) {
        console.error('[DB] Error loading recent NUMERIC MA states:', err.message || err);
        return {};
    } finally {
        client?.release();
    }
    return maStates;
}

// Function for storing aggregated data would go here (part of aggregateAndStore logic)

/**
 * Checks if the lexicon tables have been populated.
 * @returns Promise<boolean> True if populated, false otherwise.
 */
export async function isLexiconPopulated(): Promise<boolean> {
    let client: PoolClient | null = null;
    try {
        client = await pool.connect();
        const result = await client.query('SELECT COUNT(*) as count FROM lexicon_languages');
        return parseInt(result.rows[0].count, 10) > 0;
    } catch (err: any) {
        console.error('[DB] Error checking if lexicon is populated:', err.message || err);
        return false; // Assume not populated on error to be safe, or handle as critical
    } finally {
        client?.release();
    }
}

/**
 * Executes the lexicon ingestion script.
 */
export async function runLexiconIngestionScript(): Promise<void> {
    console.log('[DB] Lexicon appears empty. Attempting to run ingestion script...');
    const { spawn } = await import('child_process');

    return new Promise((resolve, reject) => {
        const scriptProcess = spawn('npx', ['tsx', 'scripts/ingest_lexicon.ts'], {
            stdio: 'inherit', // Pipe output to current process's stdio
            shell: true // Important for npx to work correctly on some systems
        });

        scriptProcess.on('close', (code) => {
            if (code === 0) {
                console.log('[DB] Lexicon ingestion script completed successfully.');
                resolve();
            } else {
                console.error(`[DB] Lexicon ingestion script exited with code ${code}.`);
                reject(new Error(`Lexicon ingestion script failed with code ${code}`));
            }
        });

        scriptProcess.on('error', (err) => {
            console.error('[DB] Failed to start lexicon ingestion script:', err);
            reject(err);
        });
    });
}