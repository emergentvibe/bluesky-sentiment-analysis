import 'dotenv/config'; // Load .env file variables first
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url'; // Import necessary function
const { Pool } = pg;

// Replicate __dirname behavior in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const LEXICON_FILE_PATH = path.join(__dirname, '..', 'data', 'NRC-Emotion-Lexicon', 'NRC-Emotion-Lexicon-ForVariousLanguages.txt');
const ENGLISH_LANGUAGE_CODE = 'english'; // Consistent code for English

// --- Database Setup ---
if (!process.env.DATABASE_URL) {
    console.error('CRITICAL: DATABASE_URL environment variable is not set.');
    console.error('Please ensure you have a .env file with DATABASE_URL=<your_connection_string>');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

interface LanguageInfo {
    code: string; // Lowercase code used in DB (from header)
    name: string; // Potentially formatted name (or same as code)
    columnIndex: number;
}

interface EmotionInfo {
    id: number;
    name: string; // Lowercase name used in DB
    columnIndex: number;
}

async function ingestLexicon() {
    console.log(`Starting lexicon ingestion from: ${LEXICON_FILE_PATH}`);

    // 1. Read File Content
    let fileContent: string;
    try {
        fileContent = fs.readFileSync(LEXICON_FILE_PATH, 'utf-8');
        console.log(`Successfully read lexicon file (${(fileContent.length / 1024 / 1024).toFixed(2)} MB).`);
    } catch (error: any) {
        console.error(`Error reading lexicon file ${LEXICON_FILE_PATH}: ${error.message}`);
        console.error("Ensure the file exists and the script has read permissions.");
        await pool.end(); // Close pool before exiting
        process.exit(1);
    }

    const lines = fileContent.split(/\r?\n/);
    if (lines.length < 2) {
        console.error("Lexicon file has too few lines (missing header or data).");
        await pool.end();
        process.exit(1);
    }

    // 2. Parse Header
    const headers = lines[0].trim().split('\t');
    const emotions: Omit<EmotionInfo, 'id'>[] = [];
    const languages: LanguageInfo[] = [];
    const languageCodeMap = new Map<string, string>(); // Map lowercase code to display name

    // Base Emotions (Columns 1-10)
    for (let i = 1; i < 11; i++) {
        if (headers[i]) {
            emotions.push({ name: headers[i].toLowerCase(), columnIndex: i });
        }
    }
    console.log(`Parsed ${emotions.length} base emotions: ${emotions.map(e => e.name).join(', ')}`);

    // Add English explicitly first
    languages.push({ code: ENGLISH_LANGUAGE_CODE, name: 'English', columnIndex: 0 });
    languageCodeMap.set(ENGLISH_LANGUAGE_CODE, 'English');

    // Translation Languages (Columns 11+)
    for (let i = 11; i < headers.length; i++) {
        if (headers[i]) {
            const langCode = headers[i].toLowerCase();
            // Simple capitalization for display name
            const langName = headers[i].charAt(0).toUpperCase() + headers[i].slice(1).toLowerCase();
            languages.push({ code: langCode, name: langName, columnIndex: i });
            languageCodeMap.set(langCode, langName);
        }
    }
    console.log(`Parsed ${languages.length -1} translation languages.`); // -1 for explicit English

    // 3. Database Transaction
    const client = await pool.connect();
    console.log("Database client connected. Starting transaction...");

    try {
        await client.query('BEGIN');

        // 3a. Insert Emotions
        console.log("Inserting base emotions...");
        const emotionNameToId = new Map<string, number>();
        for (const emotion of emotions) {
            const result = await client.query(
               `INSERT INTO lexicon_emotions (emotion_name, is_base_nrc)
                VALUES ($1, TRUE)
                ON CONFLICT (emotion_name) DO UPDATE SET is_base_nrc = TRUE
                RETURNING emotion_id`,
               [emotion.name]
            );
            if (result.rows[0]) {
                emotionNameToId.set(emotion.name, result.rows[0].emotion_id);
            } else {
                // Fetch existing if conflict occurred but didn't return ID (shouldn't happen with DO UPDATE RETURNING)
                 const existing = await client.query('SELECT emotion_id FROM lexicon_emotions WHERE emotion_name = $1', [emotion.name]);
                 if (existing.rows[0]) {
                    emotionNameToId.set(emotion.name, existing.rows[0].emotion_id);
                 } else {
                    throw new Error(`Failed to insert or find emotion: ${emotion.name}`);
                 }
            }
        }
        console.log(`Upserted ${emotionNameToId.size} emotions.`);

        // 3b. Insert Languages
        console.log("Inserting languages...");
        let languagesInserted = 0;
        for (const lang of languages) {
            const result = await client.query(
               `INSERT INTO lexicon_languages (language_code, language_name)
                VALUES ($1, $2)
                ON CONFLICT (language_code) DO NOTHING`,
               [lang.code, lang.name]
            );
            languagesInserted += result.rowCount ?? 0;
        }
         console.log(`Inserted ${languagesInserted} new languages.`);

        // 3c. Process and Insert Words & Associations
        console.log("Processing lexicon entries (this may take a while)...");
        let wordsProcessed = 0;
        let associationsAdded = 0;
        let skippedLines = 0;
        let errors = 0;

        const wordCache = new Map<string, number>(); // Cache word_text+lang_code -> word_id to reduce DB queries

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            const parts = trimmedLine.split('\t');
            // Basic validation - check if parts array has enough elements based on headers
            if (parts.length < headers.length) {
                 // console.warn(`Skipping line ${i + 1}: Found ${parts.length} parts, expected at least ${headers.length}. Content: "${line.substring(0, 50)}..."`);
                 skippedLines++;
                 continue;
            }


            // Identify emotions for this row (based on columns 1-10)
            const rowEmotionIds: number[] = [];
            for (const emotion of emotions) {
                if (parts[emotion.columnIndex] === '1') {
                    const emotionId = emotionNameToId.get(emotion.name);
                    if (emotionId) {
                        rowEmotionIds.push(emotionId);
                    } else {
                         console.warn(`WARNING: Could not find ID for emotion '${emotion.name}' on line ${i + 1}. Skipping association.`);
                    }
                }
            }

            if (rowEmotionIds.length === 0) {
                 skippedLines++;
                 continue; // Skip words with no associated base emotions
            }


            // Process English word and its translations
            for (const lang of languages) {
                const wordText = parts[lang.columnIndex]?.toLowerCase();

                if (wordText && wordText !== '--' && wordText !== '') {
                    try {
                        let wordId: number | undefined;
                        const cacheKey = `${lang.code}::${wordText}`;

                        // Check cache first
                        wordId = wordCache.get(cacheKey);

                        // If not in cache, query/insert word and then cache it
                        if (wordId === undefined) {
                            const wordResult = await client.query(
                               `INSERT INTO lexicon_words (word_text, language_code)
                                VALUES ($1, $2)
                                ON CONFLICT (word_text, language_code) DO UPDATE SET word_text = EXCLUDED.word_text
                                RETURNING word_id`,
                               [wordText, lang.code]
                            );
                            if (wordResult.rows[0]?.word_id !== undefined) {
                                wordId = wordResult.rows[0].word_id;
                            } else {
                                // Fetch if conflict occurred without returning (should not happen, but defensive)
                                const existingWord = await client.query(
                                    'SELECT word_id FROM lexicon_words WHERE word_text = $1 AND language_code = $2',
                                    [wordText, lang.code]
                                );
                                if (existingWord.rows[0]?.word_id !== undefined) {
                                     wordId = existingWord.rows[0].word_id;
                                } else {
                                     // If still undefined after insert/select, something is wrong
                                     throw new Error(`Failed to insert or find word_id for: '${wordText}' in lang '${lang.code}'`);
                                }
                            }
                            // Cache the successfully obtained wordId
                            wordCache.set(cacheKey, wordId!);
                        }

                        // Now wordId should be a number if no error was thrown
                        // Insert associations for this word (English or translation)
                        const confirmedWordId: number = wordId!;

                        for (const emotionId of rowEmotionIds) {
                            const assocResult = await client.query(
                               `INSERT INTO word_emotion_associations (word_id, emotion_id)
                                VALUES ($1, $2)
                                ON CONFLICT (word_id, emotion_id) DO NOTHING`,
                               [confirmedWordId, emotionId] // Use the confirmed ID
                            );
                            associationsAdded += assocResult.rowCount ?? 0;
                        }
                        wordsProcessed++; // Count successful word processing

                    } catch (err: any) {
                        console.error(`Error processing word "${wordText}" (lang: ${lang.code}) on line ${i + 1}:`, err.message);
                        errors++;
                        // Decide if you want to continue or break on error
                        // break; // Stop processing on first word error
                    }
                }
            }

            // Log progress occasionally
             if ((i + 1) % 1000 === 0) {
                 console.log(`  ... processed ${i + 1} lines (approx ${wordsProcessed} words, ${associationsAdded} new associations added, ${errors} errors).`);
             }
        }

        console.log("Finished processing lines.");
        console.log(`Total words processed: ${wordsProcessed}`);
        console.log(`Total new associations added: ${associationsAdded}`);
        console.log(`Skipped lines (no emotions or malformed): ${skippedLines}`);
        console.log(`Errors encountered during word/association processing: ${errors}`);

        if (errors > 0) {
             console.warn("Errors occurred during processing. Rolling back transaction.");
             await client.query('ROLLBACK');
        } else {
            console.log("Committing transaction...");
            await client.query('COMMIT');
            console.log("Transaction committed successfully.");
        }

    } catch (err: any) {
        console.error('Error during database transaction:', err.message || err);
        try {
            await client.query('ROLLBACK');
            console.log('Transaction rolled back.');
        } catch (rollbackErr: any) {
            console.error('Error rolling back transaction:', rollbackErr.message || rollbackErr);
        }
        // process.exit(1); // Exit after rollback
    } finally {
        console.log("Releasing database client.");
        client.release();
    }
}

// --- Execute Script ---
ingestLexicon()
    .then(() => {
        console.log("Lexicon ingestion script finished.");
        pool.end(() => console.log('Database pool closed.')); // Gracefully close pool
    })
    .catch(async (err) => { // Ensure pool is closed even on unhandled rejection
        console.error("Unhandled error during script execution:", err);
        await pool.end();
        process.exit(1);
    }); 