import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Represents the NRC Emotion Lexicon data structure.
 * Maps words (lowercase) to an array of associated emotions.
 */
interface NrcLexicon {
    [word: string]: string[];
}

/**
 * Represents the count of each emotion and overall sentiment found in a text.
 */
export interface SentimentScores {
    anger: number;
    anticipation: number;
    disgust: number;
    fear: number;
    joy: number;
    sadness: number;
    surprise: number;
    trust: number;
    positive: number;
    negative: number;
}

// Replicate __dirname behavior in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the lexicon file (using the new __dirname)
const LEXICON_FILE_PATH = path.join(__dirname, '..', 'data', 'NRC-Emotion-Lexicon-Wordlevel-v0.92.txt');

/**
 * Loads and parses the NRC Emotion Lexicon from the specified file.
 * Expected format: word\temotion\tassociation (1 or 0)
 *
 * @returns The loaded lexicon as an NrcLexicon object.
 * @throws Error if the file cannot be read or parsed.
 */
function loadNrcLexicon(): NrcLexicon {
    console.log(`Loading NRC Lexicon from: ${LEXICON_FILE_PATH}`);
    let fileContent: string;
    try {
        fileContent = fs.readFileSync(LEXICON_FILE_PATH, 'utf-8');
    } catch (error: any) {
        console.error(`Error reading lexicon file: ${error.message}`);
        console.error("Please ensure you have downloaded 'NRC-Emotion-Lexicon-Wordlevel-v0.92.txt' and placed it in the 'data' directory.");
        throw new Error('Failed to load NRC Lexicon file.');
    }

    // Handle potential Windows line endings and split
    const lines = fileContent.split(/\r?\n/);
    const lexicon: NrcLexicon = {};
    let linesLogged = 0;
    let associationsLogged = 0;

    console.log('--- Lexicon File Sample Lines ---');
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue; // Skip empty lines

        // Log first few lines for debugging
        if (linesLogged < 5) {
            console.log(`Line ${linesLogged + 1}: ${trimmedLine}`);
            linesLogged++;
        }

        const [word, emotion, association] = trimmedLine.split('\t');
        if (!word || !emotion || association === undefined) {
            // console.warn(`Skipping malformed line in lexicon: ${trimmedLine}`);
            continue;
        }

        if (association === '1') {
            // Log first few successful associations
            if (associationsLogged < 5) {
                console.log(`  -> Association found: Word=${word}, Emotion=${emotion}, Assoc=${association}`);
                associationsLogged++;
            }

            const lowerWord = word.toLowerCase();
            if (!lexicon[lowerWord]) {
                lexicon[lowerWord] = [];
            }
            // Include 'positive' and 'negative' as valid categories from the lexicon
            const validCategories: (keyof SentimentScores)[] = ['anger', 'anticipation', 'disgust', 'fear', 'joy', 'sadness', 'surprise', 'trust', 'positive', 'negative'];
            if (validCategories.includes(emotion as keyof SentimentScores)) {
                if (!lexicon[lowerWord].includes(emotion)) { // Avoid duplicates if file has them
                     lexicon[lowerWord].push(emotion);
                }
            }
        }
    }
    console.log('--- End Lexicon Sample ---');
    console.log(`NRC Lexicon loaded. ${Object.keys(lexicon).length} words processed.`);
    if (Object.keys(lexicon).length === 0) {
        console.error("CRITICAL: Lexicon is empty after parsing. Check file format and parsing logic.");
    }
    return lexicon;
}

const nrcLexicon: NrcLexicon = loadNrcLexicon();

/**
 * Analyzes the sentiment of a given text based on the loaded NRC Emotion Lexicon.
 *
 * @param text The input text string.
 * @returns An object containing the counts for each of the 8 NRC emotions and positive/negative scores.
 */
export function analyzeSentiment(text: string): SentimentScores {
    const scores: SentimentScores = {
        anger: 0,
        anticipation: 0,
        disgust: 0,
        fear: 0,
        joy: 0,
        sadness: 0,
        surprise: 0,
        trust: 0,
        positive: 0,
        negative: 0,
    };

    if (!text) {
        return scores;
    }

    const tokens = text.toLowerCase().split(/[^a-z0-9]+/);

    for (const token of tokens) {
        if (token && nrcLexicon[token]) {
            const emotions = nrcLexicon[token];
            for (const emotion of emotions) {
                // This will now correctly increment positive/negative if they are in the lexicon[token] list
                if (emotion in scores) { // Check if the category exists in our scores object
                    scores[emotion as keyof SentimentScores]++;
                }
            }
        }
    }

    return scores;
}

// Example Usage:
// const text1 = "I am so happy and excited about the adventure!";
// const scores1 = analyzeSentiment(text1);
// console.log(`Scores for '${text1}':`, scores1);
// // Expected: { anger: 0, anticipation: 2, disgust: 0, fear: 0, joy: 2, sadness: 0, surprise: 0, trust: 0, positive: ?, negative: ? }

// const text2 = "The accident was awful and scary.";
// const scores2 = analyzeSentiment(text2);
// console.log(`Scores for '${text2}':`, scores2);
// // Expected: { anger: 1, anticipation: 0, disgust: 1, fear: 2, joy: 0, sadness: 2, surprise: 1, trust: 0, positive: ?, negative: ? } (Note: 'scary' not in sample) 