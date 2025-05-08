import { AppBskyFeedPost } from '@atproto/api';
import { franc } from 'franc';
// @ts-ignore - Suppress incorrect "not exported" error
import { analyzeSentiment } from '../sentiment.js';
import { CommitData, SentimentScores, MetricSignal } from '../types.js';
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

        const detectedLangCode = franc(postText, { minLength: 3, ignore: ['und'] });

        if (!detectedLangCode || detectedLangCode === 'und') {
            return; // Skip if language not detected
        }

        // Analyze sentiment for the detected language of the post
        const fullSentimentResult = await analyzeSentiment(postText, detectedLangCode);
        if (fullSentimentResult === null) {
            return; // Skip if analysis failed
        }

        // Accumulate scores for the base 'default' signal using detected language
        const baseSignalName = 'default';
        if (!currentIntervalScores[detectedLangCode]) {
            currentIntervalScores[detectedLangCode] = {};
            currentIntervalPostCount[detectedLangCode] = {};
        }
        if (!currentIntervalScores[detectedLangCode][baseSignalName]) {
            currentIntervalScores[detectedLangCode][baseSignalName] = createEmptyScores();
            currentIntervalPostCount[detectedLangCode][baseSignalName] = 0;
        }
        addScores(currentIntervalScores[detectedLangCode][baseSignalName], fullSentimentResult);
        currentIntervalPostCount[detectedLangCode][baseSignalName]++;

        // Check against dynamic keyword filters
        for (const signal of dynamicSignals) {
            if (signal.type !== 'filter' || !signal.keywords_json) continue;

            // Determine if the post text matches the filter keywords
            let matches = false;
            try {
                const keywords = signal.keywords_json as { include?: string[], exclude?: string[] };
                const includes = keywords.include?.map(k => k.toLowerCase()) || [];
                const excludes = keywords.exclude?.map(k => k.toLowerCase()) || [];
                const postLower = postText.toLowerCase();
                const includesMatch = includes.length === 0 || includes.some(inc => postLower.includes(inc));
                const excludesMatch = excludes.length > 0 && excludes.some(exc => postLower.includes(exc));
                if (includesMatch && !excludesMatch) {
                    matches = true;
                }
            } catch (e) {
                 console.error(`Error parsing keywords_json for signal ${signal.name} (ID: ${signal.id}):`, e);
                 continue; // Skip this filter if keywords are invalid
            }

            if (matches) {
                // Determine the language code and sentiment scores to use for this specific filter signal
                const langCodeToUse = signal.filter_language_code || detectedLangCode;
                let scoresToStore: SentimentScores;

                if (langCodeToUse !== detectedLangCode) {
                    // If filter specifies a different language, re-analyze or skip
                    // For now, let's re-analyze. Consider efficiency later.
                    const specificSentimentResult = await analyzeSentiment(postText, langCodeToUse);
                    if (specificSentimentResult === null) continue; // Skip if analysis fails for the specified lang
                    scoresToStore = specificSentimentResult;
                } else {
                    scoresToStore = fullSentimentResult; // Use already analyzed scores
                }

                // If filter specifies a base metric, extract only that score
                if (signal.base_metric_key) {
                    const metricKey = signal.base_metric_key.toLowerCase();
                    if (Object.prototype.hasOwnProperty.call(scoresToStore, metricKey)) {
                         scoresToStore = { [metricKey]: scoresToStore[metricKey] };
                    } else {
                         console.warn(`Filter ${signal.name} specifies base metric ${metricKey}, but it was not found in sentiment results.`);
                         // Store an empty score for this metric to avoid errors downsteam, but log warning
                         scoresToStore = { [metricKey]: 0 };
                    }
                }
                // If base_metric_key is null, scoresToStore remains the full sentiment result for langCodeToUse

                // Accumulate the (potentially filtered) scores under the signal name and determined language
                if (!currentIntervalScores[langCodeToUse]) {
                    currentIntervalScores[langCodeToUse] = {};
                    currentIntervalPostCount[langCodeToUse] = {};
                }
                if (!currentIntervalScores[langCodeToUse][signal.name]) {
                    // Initialize with zeros for *all* potential keys if storing full results,
                    // or just the specific key if filtered.
                    currentIntervalScores[langCodeToUse][signal.name] = signal.base_metric_key 
                        ? { [signal.base_metric_key.toLowerCase()]: 0 } 
                        : createEmptyScores(); 
                    currentIntervalPostCount[langCodeToUse][signal.name] = 0;
                }
                
                // Add the determined scores (either single metric or full)
                addScores(currentIntervalScores[langCodeToUse][signal.name], scoresToStore);
                currentIntervalPostCount[langCodeToUse][signal.name]++;
            }
        }

    } catch (error: any) {
        console.error('Error processing firehose record callback:', error.message || error);
        console.error(error.stack); // Log stack for better debugging
    }
}

// Consider adding FirehoseSubscription class setup here as well if desired. 