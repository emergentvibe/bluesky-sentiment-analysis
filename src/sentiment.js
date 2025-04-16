import * as fs from 'fs';
import * as path from 'path';
// Path to the lexicon file
const LEXICON_FILE_PATH = path.join(__dirname, '..', 'data', 'NRC-Emotion-Lexicon-Wordlevel-v0.92.txt');
/**
 * Loads and parses the NRC Emotion Lexicon from the specified file.
 * Expected format: word\temotion\tassociation (1 or 0)
 *
 * @returns The loaded lexicon as an NrcLexicon object.
 * @throws Error if the file cannot be read or parsed.
 */
function loadNrcLexicon() {
    console.log(`Loading NRC Lexicon from: ${LEXICON_FILE_PATH}`);
    let fileContent;
    try {
        fileContent = fs.readFileSync(LEXICON_FILE_PATH, 'utf-8');
    }
    catch (error) {
        console.error(`Error reading lexicon file: ${error}`);
        console.error("Please ensure you have downloaded 'NRC-Emotion-Lexicon-Wordlevel-v0.92.txt' and placed it in the 'data' directory.");
        throw new Error('Failed to load NRC Lexicon file.');
    }
    const lines = fileContent.split('\n');
    const lexicon = {};
    for (const line of lines) {
        if (!line.trim())
            continue; // Skip empty lines
        const [word, emotion, association] = line.split('\t');
        if (!word || !emotion || association === undefined) {
            console.warn(`Skipping malformed line in lexicon: ${line}`);
            continue;
        }
        // Only add the emotion if the association is 1
        if (association === '1') {
            const lowerWord = word.toLowerCase();
            if (!lexicon[lowerWord]) {
                lexicon[lowerWord] = [];
            }
            // Ensure the emotion is one of the keys in EmotionScores (for safety)
            const validEmotions = ['anger', 'anticipation', 'disgust', 'fear', 'joy', 'sadness', 'surprise', 'trust'];
            if (validEmotions.includes(emotion)) {
                lexicon[lowerWord].push(emotion);
            }
        }
    }
    console.log(`NRC Lexicon loaded successfully. ${Object.keys(lexicon).length} words found.`);
    return lexicon;
}
// Load the lexicon when the module is initialized
const nrcLexicon = loadNrcLexicon();
/**
 * Analyzes the sentiment of a given text based on the loaded NRC Emotion Lexicon.
 *
 * @param text The input text string.
 * @returns An object containing the counts for each of the 8 NRC emotions.
 */
export function analyzeSentiment(text) {
    const scores = {
        anger: 0,
        anticipation: 0,
        disgust: 0,
        fear: 0,
        joy: 0,
        sadness: 0,
        surprise: 0,
        trust: 0,
    };
    if (!text) {
        return scores;
    }
    // Basic tokenization: lowercase and split by non-alphanumeric characters
    const tokens = text.toLowerCase().split(/[^a-z0-9]+/);
    for (const token of tokens) {
        if (token && nrcLexicon[token]) {
            const emotions = nrcLexicon[token];
            for (const emotion of emotions) {
                // The loading function already ensures emotions are valid keys
                scores[emotion]++;
            }
        }
    }
    return scores;
}
// Example Usage:
// const text1 = "I am so happy and excited about the adventure!";
// const scores1 = analyzeSentiment(text1);
// console.log(`Scores for '${text1}':`, scores1);
// // Expected: { anger: 0, anticipation: 2, disgust: 0, fear: 0, joy: 2, sadness: 0, surprise: 0, trust: 0 }
// const text2 = "The accident was awful and scary.";
// const scores2 = analyzeSentiment(text2);
// console.log(`Scores for '${text2}':`, scores2);
// // Expected: { anger: 1, anticipation: 0, disgust: 1, fear: 2, joy: 0, sadness: 2, surprise: 1, trust: 0 } (Note: 'scary' not in sample) 
//# sourceMappingURL=sentiment.js.map