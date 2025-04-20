import 'dotenv/config'; // Load .env file variables first
import pg from 'pg';
import { fileURLToPath } from 'url';
import path from 'path';
import Anthropic, { APIConnectionError, RateLimitError } from '@anthropic-ai/sdk';

const { Pool } = pg;

// Replicate __dirname behavior in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Anthropic Setup ---
if (!process.env.ANTHROPIC_API_KEY) {
    console.error('CRITICAL: ANTHROPIC_API_KEY environment variable is not set.');
    console.error('Please ensure you have it set in your .env file or environment.');
    process.exit(1);
}
const anthropic = new Anthropic(); // API key is automatically picked up from env var

// Configuration for LLM calls
const LLM_MODEL_EMOTION = "claude-3-haiku-20240307";
const LLM_MODEL_TRANSLATION = "claude-3-haiku-20240307";
const LLM_MAX_RETRIES = 3;
const LLM_RETRY_DELAY_MS = 5000; // milliseconds
const ENGLISH_LANGUAGE_CODE = 'english'; // Corrected based on DB data

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
 * Simple delay function for retries.
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

/**
 * Gets all English words from the database.
 */
async function getAllEnglishWords(client: pg.PoolClient): Promise<{ word_id: number, word_text: string }[]> {
    const result = await client.query('SELECT word_id, word_text FROM lexicon_words WHERE language_code = $1', [ENGLISH_LANGUAGE_CODE]);
    return result.rows;
}

/**
 * Gets all emotion names and IDs from the database.
 */
async function getAllEmotions(client: pg.PoolClient): Promise<{ emotion_id: number, emotion_name: string }[]> {
    const result = await client.query('SELECT emotion_id, emotion_name FROM lexicon_emotions');
    return result.rows;
}

/**
 * Gets all language codes and names from the database, excluding English.
 */
async function getAllNonEnglishLanguages(client: pg.PoolClient): Promise<{ language_code: string, language_name: string }[]> {
    const result = await client.query('SELECT language_code, language_name FROM lexicon_languages WHERE language_code != $1', [ENGLISH_LANGUAGE_CODE]);
    return result.rows;
}

// --- LLM Interaction Functions ---

/**
 * Calls the Anthropic API with retries and error handling.
 */
async function callAnthropicLlm(prompt: string, model: string, max_tokens: number): Promise<string | null> {
    let retries = 0;
    while (retries < LLM_MAX_RETRIES) {
        try {
            const msg = await anthropic.messages.create({
                model: model,
                max_tokens: max_tokens,
                messages: [{ role: 'user', content: prompt }],
            });

            if (msg.content && msg.content.length > 0 && msg.content[0].type === 'text') {
                return msg.content[0].text.trim();
            } else {
                console.warn("  [LLM Warning] Received empty or unexpected content structure from API.");
                return null;
            }
        } catch (error: any) {
            if (error instanceof APIConnectionError) {
                console.error(`  [LLM Error] Anthropic API request failed to connect: ${error}`);
            } else if (error instanceof RateLimitError) {
                console.error(`  [LLM Error] Anthropic API rate limit exceeded: ${error}. Retrying in ${LLM_RETRY_DELAY_MS / 1000}s...`);
                await sleep(LLM_RETRY_DELAY_MS * (retries + 1)); // Exponential backoff might be better
            } else if (error instanceof Anthropic.APIError && error.status) {
                console.error(`  [LLM Error] Anthropic API returned an error status: ${error.status} ${error.message}`);
                // Don't retry on persistent status errors like 4xx
                if (error.status >= 400 && error.status < 500) {
                    return null;
                }
            } else {
                console.error(`  [LLM Error] An unexpected error occurred during API call: ${error}`);
            }
        }
        retries++;
        if (retries < LLM_MAX_RETRIES) {
            console.log(`    Retrying (${retries}/${LLM_MAX_RETRIES})...`);
            await sleep(LLM_RETRY_DELAY_MS * retries); // Basic exponential backoff
        } else {
            console.error("  [LLM Error] Max retries reached.");
        }
    }
    return null;
}

/**
 * Gets a 0/1 emotion score from the LLM for an English word and an emotion dimension.
 */
async function getEmotionScoreFromLlm(word: string, emotionDimension: string): Promise<number | null> {
    const prompt = `Does the English word '${word}' strongly relate to the emotion '${emotionDimension}'? Respond with only the single digit 1 for yes or 0 for no.`;
    console.log(`  [LLM Query] Emotion score for '${word}' / '${emotionDimension}'...`);
    const response = await callAnthropicLlm(prompt, LLM_MODEL_EMOTION, 5); // Small max_tokens for 0/1

    if (response !== null) {
        try {
            const score = parseInt(response, 10);
            if (score === 0 || score === 1) {
                return score;
            } else {
                console.warn(`    [LLM Warning] Invalid score digit received: '${response}'`);
                return null;
            }
        } catch (e) {
            console.warn(`    [LLM Warning] Non-integer score received: '${response}'`);
            return null;
        }
    }
    return null; // API call failed or returned invalid data
}

/**
 * Gets a translation from the LLM for an English word into a target language.
 */
async function getTranslationFromLlm(word: string, languageName: string): Promise<string | null> {
    const plainLanguage = languageName.split(' (')[0]; // Extract plain name if format is "Language (code)"
    const prompt = `What is the most common translation of the English word '${word}' into ${plainLanguage}? Respond with only the single translated word or short phrase. If no direct translation exists or is appropriate, respond with 'N/A'.`;
    console.log(`  [LLM Query] Translation for '${word}' to '${languageName}'...`);
    const response = await callAnthropicLlm(prompt, LLM_MODEL_TRANSLATION, 50); // More tokens for translation

    if (response !== null) {
        if (response.toUpperCase() === 'N/A') {
            console.log(`    [LLM Info] No direct translation found for '${word}' to '${languageName}'.`);
            return null; // Return null for N/A to distinguish from empty string error
        }
        // Basic cleanup: remove potential quotes
        return response.replace(/^["']|["']$/g, '');
    }
    return null; // API call failed
}


// --- Management Functions (Refactored) ---

/**
 * Adds a new custom emotion and uses LLM to associate it with existing English words.
 */
export async function addEmotion(emotionName: string): Promise<void> {
    const client = await pool.connect();
    let newEmotionId: number | null = null;
    const lowerEmotionName = emotionName.toLowerCase();

    try {
        await client.query('BEGIN');

        // 1. Add the emotion
        const result = await client.query(
            `INSERT INTO lexicon_emotions (emotion_name, is_base_nrc)
             VALUES ($1, FALSE)
             ON CONFLICT (emotion_name) DO NOTHING
             RETURNING emotion_id`,
            [lowerEmotionName]
        );

        if ((result.rowCount ?? 0) > 0) {
            newEmotionId = result.rows[0].emotion_id;
            console.log(`Successfully added new emotion '${lowerEmotionName}' with ID: ${newEmotionId}.`);
        } else {
            // Emotion already exists, find its ID
            newEmotionId = await findEmotionId(client, lowerEmotionName);
            if (!newEmotionId) {
                 // Should not happen if ON CONFLICT worked or findEmotionId is correct
                 throw new Error(`Failed to add or find existing emotion '${lowerEmotionName}'.`)
            }
            console.log(`Emotion '${lowerEmotionName}' already exists with ID: ${newEmotionId}. Proceeding to associate words.`);
        }

        // 2. Get all English words
        const englishWords = await getAllEnglishWords(client);
        console.log(`Found ${englishWords.length} English words to process for the new emotion.`);

        // 3. Use LLM to associate words with the new emotion
        let associatedCount = 0;
        for (const word of englishWords) {
            console.log(`Processing word: '${word.word_text}' (ID: ${word.word_id})`);
            const score = await getEmotionScoreFromLlm(word.word_text, lowerEmotionName);

            if (score === 1) {
                console.log(`  -> Associating '${word.word_text}' with '${lowerEmotionName}'...`);
                await client.query(
                    `INSERT INTO word_emotion_associations (word_id, emotion_id)
                     VALUES ($1, $2)
                     ON CONFLICT (word_id, emotion_id) DO NOTHING`,
                    [word.word_id, newEmotionId]
                );
                associatedCount++;
            } else if (score === 0) {
                 console.log(`  -> Score 0, not associating.`);
            } else {
                 console.warn(`  -> Warning: Could not get score for '${word.word_text}'. Skipping association.`);
            }
        }
        console.log(`Associated ${associatedCount} English words with the new emotion '${lowerEmotionName}'.`);

        await client.query('COMMIT');
    } catch (err: any) {
        await client.query('ROLLBACK');
        console.error(`Error adding emotion '${emotionName}' and associating words:`, err.message);
        console.error(err.stack); // Log stack for more detail
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Adds a new English word, uses LLM to associate it with existing emotions,
 * and uses LLM to find and add translations for other languages.
 */
export async function addWord(englishWordText: string): Promise<void> {
    const client = await pool.connect();
    let englishWordId: number | null = null;
    const lowerWordText = englishWordText.toLowerCase();

    try {
        await client.query('BEGIN');

        // 1. Add the English word
        const wordResult = await client.query(
            `INSERT INTO lexicon_words (word_text, language_code)
             VALUES ($1, $2)
             ON CONFLICT (word_text, language_code) DO NOTHING
             RETURNING word_id`,
            [lowerWordText, ENGLISH_LANGUAGE_CODE]
        );

        if ((wordResult.rowCount ?? 0) > 0) {
            englishWordId = wordResult.rows[0].word_id;
            console.log(`Successfully added English word '${lowerWordText}' with ID: ${englishWordId}.`);
        } else {
            englishWordId = await findWordId(client, lowerWordText, ENGLISH_LANGUAGE_CODE);
             if (!englishWordId) {
                 throw new Error(`Failed to add or find existing English word '${lowerWordText}'.`)
            }
            console.log(`English word '${lowerWordText}' already exists with ID: ${englishWordId}. Proceeding with associations and translations.`);
        }

        // 2. Associate with existing emotions via LLM
        const allEmotions = await getAllEmotions(client);
        console.log(`
Associating '${lowerWordText}' with ${allEmotions.length} existing emotions...`);
        let emotionAssociationCount = 0;
        for (const emotion of allEmotions) {
            const score = await getEmotionScoreFromLlm(lowerWordText, emotion.emotion_name);
            if (score === 1) {
                 console.log(`  -> Associating with '${emotion.emotion_name}'...`);
                 await client.query(
                     `INSERT INTO word_emotion_associations (word_id, emotion_id)
                      VALUES ($1, $2)
                      ON CONFLICT (word_id, emotion_id) DO NOTHING`,
                     [englishWordId, emotion.emotion_id]
                 );
                 emotionAssociationCount++;
            } else if (score === 0) {
                 console.log(`  -> Score 0 for '${emotion.emotion_name}', not associating.`);
            } else {
                 console.warn(`  -> Warning: Could not get score for '${emotion.emotion_name}'. Skipping association.`);
            }
        }
         console.log(`Associated '${lowerWordText}' with ${emotionAssociationCount} emotions.`);


        // 3. Get translations for other languages via LLM
        const otherLanguages = await getAllNonEnglishLanguages(client);
        console.log(`
Attempting translations for '${lowerWordText}' into ${otherLanguages.length} other languages...`);
        let translationCount = 0;
        for (const lang of otherLanguages) {
            const translation = await getTranslationFromLlm(lowerWordText, lang.language_name);
            if (translation) {
                const lowerTranslation = translation.toLowerCase();
                 console.log(`  -> Adding translation for ${lang.language_code} (${lang.language_name}): '${lowerTranslation}'`);
                 // Add the translated word to the lexicon_words table
                 await client.query(
                     `INSERT INTO lexicon_words (word_text, language_code)
                      VALUES ($1, $2)
                      ON CONFLICT (word_text, language_code) DO NOTHING`,
                     [lowerTranslation, lang.language_code]
                 );
                 translationCount++;
            } else {
                // Logged within getTranslationFromLlm if N/A or error
            }
        }
        console.log(`Added ${translationCount} translations for '${lowerWordText}'.`);


        await client.query('COMMIT');
    } catch (err: any) {
        await client.query('ROLLBACK');
        console.error(`Error adding word '${englishWordText}' and processing:`, err.message);
        console.error(err.stack);
        throw err;
    } finally {
        client.release();
    }
}


/**
 * Associates an existing word (in a specific language) with an existing emotion.
 * (Kept for manual adjustments if needed)
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
 * (Kept for manual adjustments if needed)
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

    console.log("Lexicon Management Script (with LLM Integration)");
    console.log("-----------------------------------------------");
    console.log("Usage:");
    console.log("  npm run manage-lexicon -- add-emotion <emotionName>        # Adds emotion and associates existing English words via LLM");
    console.log("  npm run manage-lexicon -- add-word <englishWordText>       # Adds English word, associates with emotions via LLM, gets translations via LLM");
    console.log("  --- Manual Adjustments (Optional) ---");
    console.log("  npm run manage-lexicon -- associate <wordText> <languageCode> <emotionName>");
    console.log("  npm run manage-lexicon -- disassociate <wordText> <languageCode> <emotionName>");
    console.log("-----------------------------------------------");

    try {
        switch (command) {
            case 'add-emotion':
                if (args.length !== 2) throw new Error("Usage: add-emotion <emotionName>");
                await addEmotion(args[1]);
                break;
            case 'add-word':
                 // No longer takes languageCode as it primarily adds English word and finds translations
                if (args.length !== 2) throw new Error("Usage: add-word <englishWordText>");
                await addWord(args[1]);
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
                } else {
                     console.log("Please provide a command.");
                }
                // If no command or unknown command, show usage (already printed above)
                 process.exitCode = 1;
                break;
        }
         if (process.exitCode !== 1) { // Don't print success if a command failed or wasn't run
             console.log("\nCommand finished successfully.");
         }
    } catch (error: any) {
        console.error("\nOperation failed:", error.message);
        // Error is already logged within functions, exit code indicates failure
        process.exitCode = 1; // Indicate failure without exiting immediately
    }
}

// Execute the run function and then close the pool
run().finally(async () => {
    // Wait briefly for any outstanding console logs before closing pool
    await sleep(100);
    pool.end(() => console.log('\nDatabase pool closed.'));
}); 