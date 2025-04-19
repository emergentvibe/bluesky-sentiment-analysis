import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import franc from 'franc-all';
// Import natural using default import for CommonJS compatibility
import natural from 'natural';

/**
 * Represents the NRC Emotion Lexicon data structure for a single language
 */
interface NrcLexicon {
    [word: string]: string[]; // word -> [emotion1, emotion2, ...]
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

// Path to the consolidated lexicon file
const LEXICON_FILE_PATH = path.join(__dirname, '..', 'data', 'NRC-Emotion-Lexicon', 'NRC-Emotion-Lexicon-ForVariousLanguages.txt');

/**
 * Loads and parses the consolidated NRC Emotion Lexicon file.
 *
 * @returns A Map where keys are language names (lowercase, e.g., "english", "spanish")
 *          and values are NrcLexicon objects for that language.
 */
function loadConsolidatedNrcLexicon(): Map<string, NrcLexicon> {
    console.log(`Loading Consolidated NRC Lexicon from: ${LEXICON_FILE_PATH}`);
    const lexiconsByLanguage = new Map<string, NrcLexicon>();
    let loadedLanguageCount = 0;

    let fileContent: string;
    try {
        fileContent = fs.readFileSync(LEXICON_FILE_PATH, 'utf-8');
    } catch (error: any) {
        console.error(`Error reading lexicon file ${LEXICON_FILE_PATH}: ${error.message}`);
        console.error("Please ensure 'NRC-Emotion-Lexicon-ForVariousLanguages.txt' is in the 'data/NRC-Emotion-Lexicon' directory.");
        // Exit if the main lexicon file can't be loaded
        process.exit(1);
    }

    const lines = fileContent.split(/\r?\n/);
    if (lines.length < 2) {
        console.error("Lexicon file has too few lines (missing header or data).");
        process.exit(1);
    }

    // Parse header to find language columns
    const headers = lines[0].trim().split('\t');
    const languageColumns: { name: string; index: number }[] = [];
    // Assuming English word is index 0, emotions/sentiments are 1-10
    const emotionHeaders = headers.slice(1, 11);

    // *** ADD: Initialize English lexicon explicitly ***
    lexiconsByLanguage.set('english', {});
    console.log("Explicitly initialized 'english' lexicon map.");

    // console.log("Parsing Lexicon Header:"); // REMOVE Log
    for (let i = 11; i < headers.length; i++) { // Start after the 11 fixed columns
        const headerName = headers[i]; // Get original header
        const langName = headerName.toLowerCase();
        // if (langName === 'english') { // REMOVE Log
        //    console.log(` -> Found potential English column: Header='${headerName}', Index=${i}`);
        // }
        languageColumns.push({ name: langName, index: i });
        lexiconsByLanguage.set(langName, {}); // Initialize lexicon for each language
        loadedLanguageCount++;
    }
    console.log(`Identified ${loadedLanguageCount} languages in lexicon header (excluding English column 0).`);

    // Process data lines
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        const parts = trimmedLine.split('\t');
        if (parts.length < headers.length) continue; // Skip lines shorter than header

        // Get emotions associated with the English word
        const emotions: string[] = [];
        for (let j = 1; j < 11; j++) { // Indices 1 to 10 are emotions/sentiments
            if (parts[j] === '1') {
                emotions.push(headers[j]); // Use header name (e.g., 'anger')
            }
        }

        if (emotions.length === 0) continue; // Skip if English word has no associations

        // *** ADD: Populate English Lexicon using column 0 ***
        const englishWord = parts[0]?.toLowerCase();
        if (englishWord) {
            const englishLexicon = lexiconsByLanguage.get('english')!;
            if (!englishLexicon[englishWord]) {
                englishLexicon[englishWord] = [];
            }
            // Add emotions if not already present for this English word
            for (const emotion of emotions) {
                if (!englishLexicon[englishWord].includes(emotion)) {
                    englishLexicon[englishWord].push(emotion);
                }
            }
        }

        // Add associations for each language translation (Columns 11+)
        for (const langInfo of languageColumns) {
            const translatedWord = parts[langInfo.index]?.toLowerCase();
            if (translatedWord && translatedWord !== '--' && translatedWord !== '') { // Check for valid translation
                const langLexicon = lexiconsByLanguage.get(langInfo.name)!;
                if (!langLexicon[translatedWord]) {
                    langLexicon[translatedWord] = [];
                }
                // Add emotions if not already present for this translated word
                for (const emotion of emotions) {
                    if (!langLexicon[translatedWord].includes(emotion)) {
                        langLexicon[translatedWord].push(emotion);
                    }
                }
            }
        }
    }

    // console.log("Finished processing lexicon lines."); // REMOVE Log
    // console.log("Lexicon keys BEFORE cleanup:", Array.from(lexiconsByLanguage.keys())); // REMOVE Log
    // console.log("Checking for 'english' key BEFORE cleanup:", lexiconsByLanguage.has('english')); // REMOVE Log

    // Clean up empty language lexicons if any were created but had no valid words
    for (const [lang, lexicon] of lexiconsByLanguage.entries()) {
        if (Object.keys(lexicon).length === 0) {
            // if (lang === 'english') { // REMOVE Log
            //     console.warn(" -> WARNING: Deleting 'english' lexicon during cleanup because it was empty!");
            // }
            lexiconsByLanguage.delete(lang);
            // console.warn(`Removed empty lexicon for language: ${lang}`); // Keep this muted unless debugging needed
        }
    }

    if (lexiconsByLanguage.size === 0) {
        console.error("CRITICAL: No language lexicons were successfully populated. Sentiment analysis will not work.");
        // Consider exiting: process.exit(1);
    }
    return lexiconsByLanguage;
}

// Store all loaded lexicons
const nrcLexiconsByLanguage: Map<string, NrcLexicon> = loadConsolidatedNrcLexicon();

// --- Language Filtering & Mapping ---
// Keep only the top ~20 languages based on usage and stemming availability.
// Keys MUST match franc output, values MUST match lexicon header names (lowercase).
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
    // Other High-Usage Languages (Unstemmed)
    'deu': 'german',
    'cmn': 'chinese_simplified', // Verify header name!
    'jpn': 'japanese',
    'ara': 'arabic',
    'pol': 'polish',
    'tur': 'turkish',
    'vie': 'vietnamese',
    'kor': 'korean',
    'ind': 'indonesian',
    'hin': 'hindi',
    'ben': 'bengali'
    // Total: 20 languages
};

// Filtered map for analysis
const francToNrcMap: { [key: string]: string } = TARGET_LANGUAGES;

// --- Stemmer Setup ---
// Create a map from lowercase language name to the stemmer instance
// Use 'any' for the stemmer type for simplicity with default import
const stemmersByLanguage = new Map<string, any>();

// Access stemmers via the default import object
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

console.log("Attempting to initialize stemmers...");

for (const nrcName of Object.values(francToNrcMap)) { // Iterate over TARGET_LANGUAGES map
    const stemmerClass = languagesWithStemmers[nrcName];
    if (stemmerClass) {
        stemmersByLanguage.set(nrcName, stemmerClass);
    }
}
console.log(`Initialized stemmers for ${stemmersByLanguage.size} languages out of ${Object.keys(francToNrcMap).length} target languages.`);

/**
 * Analyzes the sentiment of a given text based on the loaded NRC Emotion Lexicon for the specified language.
 *
 * @param text The input text string.
 * @param langCode The language code (ISO 639-3 from franc).
 * @returns An object containing sentiment scores, or null if the language is unsupported.
 */
export function analyzeSentiment(text: string, langCode: string): SentimentScores | null {
    const nrcLanguageName = francToNrcMap[langCode];
    if (!nrcLanguageName) {
        return null; // Language not mapped
    }

    const lexicon = nrcLexiconsByLanguage.get(nrcLanguageName);
    if (!lexicon) {
        if (langCode === 'eng') {
            console.warn("analyzeSentiment (eng): No lexicon found for 'english'. This shouldn't happen.");
        }
        return null; // Lexicon for the mapped language wasn't loaded/doesn't exist
    }

    // Get the appropriate stemmer for the language, if available
    const stemmer = stemmersByLanguage.get(nrcLanguageName);

    const scores: SentimentScores = {
        anger: 0, anticipation: 0, disgust: 0, fear: 0,
        joy: 0, sadness: 0, surprise: 0, trust: 0,
        positive: 0, negative: 0,
    };

    if (!text) {
        return scores;
    }

    const tokens = text.toLowerCase().split(/\W+/).filter(Boolean); // Split on non-word characters and remove empty strings

    for (const token of tokens) {
        let lookupToken = token;

        // Stem the token IF a stemmer exists for this language
        if (stemmer) {
            try {
                // Use the static stem method
                lookupToken = stemmer.stem(token);
            } catch (e) {
                // Handle potential errors from stemming (e.g., unusual input)
                console.warn(`Stemmer error for token "${token}" in language "${nrcLanguageName}":`, e);
                lookupToken = token; // Fallback to original token
            }
        }

        // Use the potentially stemmed token for lookup
        if (lookupToken && lexicon[lookupToken]) {
            const emotions = lexicon[lookupToken];
            for (const emotion of emotions) {
                if (emotion in scores) {
                    scores[emotion as keyof SentimentScores]++;
                }
            }
        }
    }

    return scores;
}

// Example Usage (remains similar, but language code is now needed)
// const scores1 = analyzeSentiment("I am so happy", 'eng'); 