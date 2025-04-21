import { AppBskyFeedPost } from '@atproto/api';
import { franc } from 'franc';
// @ts-ignore - Suppress incorrect "not exported" error
import { analyzeSentiment } from '../sentiment.js';
import { CommitData } from '../types.js';
import { dynamicSignals, currentIntervalScores, currentIntervalPostCount } from './state.js';
import { createEmptyScores, addScores } from './sentimentUtils.js';

/**
 * Callback function for the FirehoseSubscription.
 * Processes a received post record and its associated commit metadata.
 * Extracts text, detects language, analyzes sentiment, and updates interval accumulators.
 */
export async function handleFirehoseRecord(post: AppBskyFeedPost.Record, commit: CommitData): Promise<void> {
    try {
        if (!post || typeof post !== 'object' || !post.text || typeof post.text !== 'string') {
            return;
        }
        const postText = post.text;
        if (postText.trim().length === 0) {
            return;
        }

        const langCode = franc(postText, { minLength: 3, ignore: ['und'] });

        if (langCode && langCode !== 'und') {
            const sentimentResult = await analyzeSentiment(postText, langCode);
            if (sentimentResult === null) {
                return;
            }
            const lowerCaseSentimentScores = sentimentResult;
            const matchedDbSignalNames: string[] = ['default'];

            for (const signal of dynamicSignals) {
                let matches = false;
                if (typeof signal.keywords_json === 'object' && signal.keywords_json !== null) {
                    const keywords = signal.keywords_json as { include?: string[], exclude?: string[] };
                    const includes = keywords.include?.map(k => k.toLowerCase()) || [];
                    const excludes = keywords.exclude?.map(k => k.toLowerCase()) || [];
                    const postLower = postText.toLowerCase();
                    const includesMatch = includes.length === 0 || includes.some(inc => postLower.includes(inc));
                    const excludesMatch = excludes.length > 0 && excludes.some(exc => postLower.includes(exc));
                    if (includesMatch && !excludesMatch) {
                        matches = true;
                    }
                } else {
                     console.warn(`Signal ${signal.name} (ID: ${signal.id}) has invalid keywords_json format.`);
                }
                if (matches) {
                    matchedDbSignalNames.push(signal.name);
                }
            }

            for (const dbSignalName of matchedDbSignalNames) {
                if (!currentIntervalScores[langCode]) {
                    currentIntervalScores[langCode] = {};
                    currentIntervalPostCount[langCode] = {};
                }
                if (!currentIntervalScores[langCode][dbSignalName]) {
                    currentIntervalScores[langCode][dbSignalName] = createEmptyScores();
                    currentIntervalPostCount[langCode][dbSignalName] = 0;
                }
                addScores(currentIntervalScores[langCode][dbSignalName], lowerCaseSentimentScores);
                currentIntervalPostCount[langCode][dbSignalName]++;
            }
        }
    } catch (error: any) {
        console.error('Error processing firehose record callback:', error.message || error);
    }
}

// Consider adding FirehoseSubscription class setup here as well if desired. 