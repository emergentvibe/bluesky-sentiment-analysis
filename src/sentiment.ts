import 'dotenv/config'; // Ensure env vars are loaded
import path from 'path';
import { fileURLToPath } from 'url';
import franc from 'franc-all';
import natural from 'natural';
import pg from 'pg'; // Import pg
const { Pool } = pg;
import { SentimentScores } from './types.js'; // Assuming types.ts exists now

/**
 * @fileoverview
 * This module handles the sentiment analysis of text using lexicon data stored in a database.
 * It supports multiple languages and utilizes language-specific stemmers where available.
 * The primary function `analyzeSentiment` takes text and a language code to
 * return sentiment scores based on database lookups.
 */

// --- Database Connection ---
// Create a dedicated pool for this module, reads DATABASE_URL from .env
if (!process.env.DATABASE_URL) {
    // This check might be redundant if server.ts already checks, but good practice
    console.error('CRITICAL (sentiment.ts): DATABASE_URL environment variable is not set.');
    process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// --- Dynamic Emotion Loading ---

/**
 * Represents the count of each emotion/sentiment found in a text.
 * Uses Record<string, number> to allow for dynamic emotions loaded from the DB.
 */

// Replicate __dirname behavior in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Language Filtering & Mapping (Kept for Stemmer Association) ---

// Maps ISO 639-3 codes (from franc) to language codes used in DB (from NRC header)
// This also implicitly defines which languages will be processed.
const TARGET_LANGUAGES: { [key: string]: string } = {
    // Languages with Stemmers in 'natural'
    'eng': 'english',
    'fra': 'french',
    'spa': 'spanish',
    'ita': 'italian',
    'nld': 'dutch',
    'por': 'portuguese',
    'swe': 'swedish',
    'nob': 'norwegian', // Using Bokmål for Norwegian
    'rus': 'russian',
    // Other High-Usage Languages (Unstemmed) from original NRC file
    'deu': 'german',
    'cmn': 'chinese_simplified',
    'jpn': 'japanese',
    'ara': 'arabic',
    'pol': 'polish',
    'tur': 'turkish',
    'vie': 'vietnamese',
    'kor': 'korean',
    'ind': 'indonesian',
    'hin': 'hindi',
    'ben': 'bengali'
    // Note: Languages need to exist in lexicon_languages table (from ingestion script)
};

// Map ISO 639-3 codes to NRC lexicon language names.
const francToNrcMap: { [key: string]: string } = TARGET_LANGUAGES;

// --- Stemmer Setup (Remains the same) ---
const stemmersByLanguage = new Map<string, any>();
const languagesWithStemmers: { [key: string]: any } = {
    'english': natural.PorterStemmer,
    'french': natural.PorterStemmerFr,
    'spanish': natural.PorterStemmerEs,
    'italian': natural.PorterStemmerIt,
    'dutch': natural.PorterStemmerNl,
    'portuguese': natural.PorterStemmerPt,
    'swedish': natural.PorterStemmerSv,
    'norwegian': natural.PorterStemmerNo,
    'russian': natural.PorterStemmerRu
};

// Initialize stemmers based on TARGET_LANGUAGES
console.log("Initializing stemmers for target languages...");
for (const nrcName of Object.values(francToNrcMap)) {
    const stemmerClass = languagesWithStemmers[nrcName];
    if (stemmerClass) {
        stemmersByLanguage.set(nrcName, stemmerClass);
        // console.log(` - Initialized stemmer for: ${nrcName}`);
    }
}
console.log(`Initialized stemmers for ${stemmersByLanguage.size} languages.`);

/**
 * Helper function to create an empty SentimentScores object conforming to the interface from types.ts.
 * @returns {SentimentScores} An empty scores object.
 */
export function createEmptyScores(): SentimentScores {
    // Ensure this matches the SentimentScores interface in types.ts
    return {
        anger: 0,
        anticipation: 0,
        disgust: 0,
        fear: 0,
        joy: 0,
        sadness: 0,
        surprise: 0,
        trust: 0,
        positive: 0,
        negative: 0
        // No need for [key: string]: number here if types.ts handles it
    };
}

/**
 * Analyzes the sentiment of a given text based on lexicon data stored in the database.
 * It tokenizes the text, optionally stems tokens, queries the database for word-emotion associations,
 * and aggregates the sentiment scores dynamically based on emotions found in the DB.
 *
 * @param {string} text The input text string to analyze.
 * @param {string} langCode The detected language code of the text (ISO 639-3 format, e.g., 'eng', 'fra').
 *                          Must be a key in `TARGET_LANGUAGES`.
 * @returns {Promise<SentimentScores | null>} A Promise resolving to a `SentimentScores` object (Record<string, number>)
 *          containing counts for each dynamically loaded emotion/sentiment, or `null` if the language is not targeted.
 *          Returns a zero-score object if the text is empty or no associations are found.
 *          Returns null if a database error occurs during lookup.
 */
export async function analyzeSentiment(text: string, langCode: string): Promise<SentimentScores | null> {
    const nrcLanguageCode = francToNrcMap[langCode]; // Map franc code to DB/NRC language code
    if (!nrcLanguageCode) {
        return null; // Language not mapped/targeted
    }

    // Use the exported helper which returns the correct SentimentScores type
    const scores: SentimentScores = createEmptyScores();

    if (!text) {
        return scores; // Return zero scores for empty text
    }

    // Get the appropriate stemmer, if available
    const stemmer = stemmersByLanguage.get(nrcLanguageCode);
    const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);

    // --- Database Query Logic ---
    // PERFORMANCE NOTE: This approach queries the DB for each token.
    // For high throughput, consider batching token lookups per post.
    let client: pg.PoolClient | null = null; // Declare client outside the loop
    try {
         client = await pool.connect(); // Get a client from the pool

        for (const token of tokens) {
            let lookupToken = token;

            // Stem the token IF a stemmer exists for this language
            if (stemmer) {
                try {
                    lookupToken = stemmer.stem(token);
                } catch (e) {
                    console.warn(`Stemmer error for token "${token}" in language "${nrcLanguageCode}":`, e);
                    lookupToken = token; // Fallback to original token
                }
            }

            if (!lookupToken) continue; // Skip if token becomes empty after processing

            // 1. Find word_id for the token and language
            const wordResult = await client.query(
                'SELECT word_id FROM lexicon_words WHERE word_text = $1 AND language_code = $2',
                [lookupToken, nrcLanguageCode]
            );
            const wordId = wordResult.rows[0]?.word_id;

            if (wordId) {
                // 2. If word found, find associated emotion names
                const emotionResult = await client.query(
                   `SELECT le.emotion_name
                    FROM word_emotion_associations wea
                    JOIN lexicon_emotions le ON wea.emotion_id = le.emotion_id
                    WHERE wea.word_id = $1`,
                   [wordId]
                );

                // 3. Increment scores for found emotions
                for (const row of emotionResult.rows) {
                    const emotionName = row.emotion_name;
                    // Check against the keys defined in the SentimentScores interface
                    if (scores.hasOwnProperty(emotionName)) {
                        scores[emotionName]++;
                    } else {
                         console.warn(`DB returned emotion '${emotionName}' not defined in SentimentScores interface.`);
                    }
                }
            }
        }
        // Return the populated scores object
        return scores;

    } catch (error: any) {
        console.error(`Database error during sentiment analysis for text starting with "${text.substring(0, 30)}..." (lang: ${langCode}):`, error.message);
        return null; // Indicate failure with null
    } finally {
        client?.release(); // Release the client back to the pool if it was acquired
    }
}

// Note: loadDynamicEmotionsFromDB() needs to be called during application startup.
// Example of how it might be called in server.ts:
/*
async function main() {
    console.log('Starting Bluesky Sentiment Analysis Service...');

    // Initialize Database FIRST (includes creating tables)
    await initializeDatabase();

    // Load dynamic emotions *after* DB init
    await loadDynamicEmotionsFromDB();

    // Start the aggregation timer
    // ... rest of main ...
}
*/