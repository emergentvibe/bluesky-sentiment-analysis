/**
 * Represents the count of each emotion found in a text.
 */
export interface EmotionScores {
    anger: number;
    anticipation: number;
    disgust: number;
    fear: number;
    joy: number;
    sadness: number;
    surprise: number;
    trust: number;
}
/**
 * Analyzes the sentiment of a given text based on the loaded NRC Emotion Lexicon.
 *
 * @param text The input text string.
 * @returns An object containing the counts for each of the 8 NRC emotions.
 */
export declare function analyzeSentiment(text: string): EmotionScores;
