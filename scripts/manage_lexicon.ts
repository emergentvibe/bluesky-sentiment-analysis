import 'dotenv/config'; // Load .env file variables first
import pg from 'pg';
import { fileURLToPath } from 'url';
import path from 'path';
const { Pool } = pg;

// Replicate __dirname behavior in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Database Setup ---
if (!process.env.DATABASE_URL) {
    console.error('CRITICAL: DATABASE_URL environment variable is not set.');
    console.error('Please ensure you have a .env file with DATABASE_URL=<your_connection_string>');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// --- Helper Functions ---

/**
 * Finds the emotion_id for a given emotion name.
 */
async function findEmotionId(client: pg.PoolClient, emotionName: string): Promise<number | null> {
    const result = await client.query('SELECT emotion_id FROM lexicon_emotions WHERE emotion_name = $1', [emotionName.toLowerCase()]);
    return result.rows[0]?.emotion_id ?? null;
}

/**
 * Finds the word_id for a given word text and language code.
 */
async function findWordId(client: pg.PoolClient, wordText: string, languageCode: string): Promise<number | null> {
    const result = await client.query(
        'SELECT word_id FROM lexicon_words WHERE word_text = $1 AND language_code = $2',
        [wordText.toLowerCase(), languageCode.toLowerCase()]
    );
    return result.rows[0]?.word_id ?? null;
}

// --- Management Functions ---

/**
 * Adds a new custom emotion to the lexicon.
 */
export async function addEmotion(emotionName: string): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const lowerEmotionName = emotionName.toLowerCase();
        const result = await client.query(
           `INSERT INTO lexicon_emotions (emotion_name, is_base_nrc)
            VALUES ($1, FALSE)
            ON CONFLICT (emotion_name) DO UPDATE SET emotion_name = EXCLUDED.emotion_name -- No real update, just handles conflict
            RETURNING emotion_id, is_base_nrc`,
           [lowerEmotionName]
        );

        if ((result.rowCount ?? 0) > 0) {
            console.log(`Successfully added/found emotion '${lowerEmotionName}' with ID: ${result.rows[0].emotion_id}. is_base_nrc: ${result.rows[0].is_base_nrc}`);
        } else {
             console.warn(`Emotion '${lowerEmotionName}' already exists.`); // Should not happen with RETURNING
        }
        await client.query('COMMIT');
    } catch (err: any) {
        await client.query('ROLLBACK');
        console.error(`Error adding emotion '${emotionName}':`, err.message);
        throw err; // Re-throw error after logging
    } finally {
        client.release();
    }
}

/**
 * Adds a word for a specific language to the lexicon.
 * Does not associate it with any emotions yet.
 */
export async function addWord(wordText: string, languageCode: string): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const lowerWordText = wordText.toLowerCase();
        const lowerLangCode = languageCode.toLowerCase();

        // Check if language exists first
        const langCheck = await client.query('SELECT 1 FROM lexicon_languages WHERE language_code = $1', [lowerLangCode]);
        if (langCheck.rowCount === 0) {
            throw new Error(`Language code '${lowerLangCode}' does not exist in lexicon_languages.`);
        }

        const result = await client.query(
           `INSERT INTO lexicon_words (word_text, language_code)
            VALUES ($1, $2)
            ON CONFLICT (word_text, language_code) DO NOTHING
            RETURNING word_id`,
           [lowerWordText, lowerLangCode]
        );

        if ((result.rowCount ?? 0) > 0) {
            console.log(`Successfully added word '${lowerWordText}' (lang: ${lowerLangCode}) with ID: ${result.rows[0].word_id}`);
        } else {
             console.log(`Word '${lowerWordText}' (lang: ${lowerLangCode}) already exists.`);
        }
        await client.query('COMMIT');
    } catch (err: any) {
        await client.query('ROLLBACK');
        console.error(`Error adding word '${wordText}' (lang: ${languageCode}):`, err.message);
         throw err;
    } finally {
        client.release();
    }
}

/**
 * Associates an existing word (in a specific language) with an existing emotion.
 */
export async function associateWordEmotion(wordText: string, languageCode: string, emotionName: string): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const lowerWordText = wordText.toLowerCase();
        const lowerLangCode = languageCode.toLowerCase();
        const lowerEmotionName = emotionName.toLowerCase();

        // Find IDs
        const wordId = await findWordId(client, lowerWordText, lowerLangCode);
        const emotionId = await findEmotionId(client, lowerEmotionName);

        if (!wordId) {
            throw new Error(`Word '${lowerWordText}' (lang: ${lowerLangCode}) not found.`);
        }
        if (!emotionId) {
            throw new Error(`Emotion '${lowerEmotionName}' not found.`);
        }

        // Insert association
        const result = await client.query(
           `INSERT INTO word_emotion_associations (word_id, emotion_id)
            VALUES ($1, $2)
            ON CONFLICT (word_id, emotion_id) DO NOTHING`,
           [wordId, emotionId]
        );

        if ((result.rowCount ?? 0) > 0) {
            console.log(`Successfully associated '${lowerWordText}' (lang: ${lowerLangCode}) with emotion '${lowerEmotionName}'.`);
        } else {
            console.log(`Association between '${lowerWordText}' (lang: ${lowerLangCode}) and '${lowerEmotionName}' already exists.`);
        }
        await client.query('COMMIT');
    } catch (err: any) {
        await client.query('ROLLBACK');
        console.error(`Error associating word '${wordText}' (lang: ${languageCode}) with emotion '${emotionName}':`, err.message);
         throw err;
    } finally {
        client.release();
    }
}

/**
 * Disassociates a word (in a specific language) from an emotion.
 */
export async function disassociateWordEmotion(wordText: string, languageCode: string, emotionName: string): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const lowerWordText = wordText.toLowerCase();
        const lowerLangCode = languageCode.toLowerCase();
        const lowerEmotionName = emotionName.toLowerCase();

        // Find IDs first to ensure they exist
        const wordId = await findWordId(client, lowerWordText, lowerLangCode);
        const emotionId = await findEmotionId(client, lowerEmotionName);

        if (!wordId) {
            console.warn(`Word '${lowerWordText}' (lang: ${lowerLangCode}) not found. Cannot disassociate.`);
             await client.query('ROLLBACK'); // No changes needed
             return;
        }
        if (!emotionId) {
             console.warn(`Emotion '${lowerEmotionName}' not found. Cannot disassociate.`);
             await client.query('ROLLBACK'); // No changes needed
             return;
        }

        // Delete the association
        const result = await client.query(
            'DELETE FROM word_emotion_associations WHERE word_id = $1 AND emotion_id = $2',
            [wordId, emotionId]
        );

        if ((result.rowCount ?? 0) > 0) {
            console.log(`Successfully disassociated '${lowerWordText}' (lang: ${lowerLangCode}) from emotion '${lowerEmotionName}'.`);
        } else {
            console.log(`No existing association found between '${lowerWordText}' (lang: ${lowerLangCode}) and '${lowerEmotionName}'.`);
        }
        await client.query('COMMIT');
    } catch (err: any) {
        await client.query('ROLLBACK');
        console.error(`Error disassociating word '${wordText}' (lang: ${languageCode}) from emotion '${emotionName}':`, err.message);
         throw err;
    } finally {
        client.release();
    }
}

// --- Command Line Argument Parsing & Execution ---

async function run() {
    const args = process.argv.slice(2); // Remove 'node' and script path
    const command = args[0];

    console.log("Lexicon Management Script");
    console.log("Usage:");
    console.log("  npm run manage-lexicon -- add-emotion <emotionName>");
    console.log("  npm run manage-lexicon -- add-word <wordText> <languageCode>");
    console.log("  npm run manage-lexicon -- associate <wordText> <languageCode> <emotionName>");
    console.log("  npm run manage-lexicon -- disassociate <wordText> <languageCode> <emotionName>");
    console.log("-------------------------");

    try {
        switch (command) {
            case 'add-emotion':
                if (args.length !== 2) throw new Error("Usage: add-emotion <emotionName>");
                await addEmotion(args[1]);
                break;
            case 'add-word':
                if (args.length !== 3) throw new Error("Usage: add-word <wordText> <languageCode>");
                await addWord(args[1], args[2]);
                break;
            case 'associate':
                if (args.length !== 4) throw new Error("Usage: associate <wordText> <languageCode> <emotionName>");
                await associateWordEmotion(args[1], args[2], args[3]);
                break;
            case 'disassociate':
                if (args.length !== 4) throw new Error("Usage: disassociate <wordText> <languageCode> <emotionName>");
                await disassociateWordEmotion(args[1], args[2], args[3]);
                break;
            default:
                if (command) {
                    console.error(`Unknown command: ${command}`);
                }
                // else: just print usage
                break;
        }
        console.log("\nCommand finished.");
    } catch (error: any) {
        console.error("\nOperation failed:", error.message);
        // Error is already logged within functions, exit code indicates failure
        process.exitCode = 1; // Indicate failure without exiting immediately
    }
}

// Execute the run function and then close the pool
run().finally(() => {
    pool.end(() => console.log('\nDatabase pool closed.'));
}); 