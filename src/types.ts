/**
 * Defines the structure for sentiment scores (count per category).
 * Uses a dynamic record type to handle any number of emotions.
 */
export interface SentimentScores {
    [key: string]: number; // Represents scores for different emotions/sentiments
}

/**
 * Base structure for aggregated data stored or processed.
 */
export interface AggregatedScoreEntry {
    timestamp: number;
    language: string;
    signalName: string; // Added
    scores: SentimentScores;
    postCount: number;
}

/** DEPRECATED: Structure for historical data points, including moving averages. */
/*
export interface HistoryEntry {
    timestamp: number;       // Unix timestamp (ms)
    // Rename scores to avgScores to reflect it's the average per post for the interval
    avgScores: SentimentScores | null; // Average scores per post for the interval
    postCount: number;       // Total posts in the interval
    // Add optional pre-calculated MAs
    shortAvg?: SentimentScores | null; // Optional short-term moving average
    longAvg?: SentimentScores | null;  // Optional long-term moving average
}
 */

/** DEPRECATED: Structure representing a raw row fetched from the `sentiment_data` database table. */
/* 
export interface RawDbEntry {
    timestamp: string | Date;
    scores: SentimentScores;
    postCount: number;
}
 */

/** DEPRECATED: Structure for a single live update data point broadcast via WebSocket. */
/*
export interface LiveUpdateEntry {
    signalName: string;      // Specific metric or filter name
    language: string;
    timestamp: number;
    avgScores: SentimentScores | null; // Average scores for the interval
    postCount: number;       // Posts in the interval
    shortAvg: SentimentScores | null; // Latest calculated short MA
    longAvg: SentimentScores | null;  // Latest calculated long MA
}
*/

/**
 * Structure representing a dynamic signal configuration (e.g., a complex filter).
 * Aligns with the `complex_keyword_filters` database table.
 */
export interface MetricSignal {
    id: number | string; // number for filter (DB ID), string for base metric name
    name: string;       // Name used for identification and display
    keywords_json?: { include?: string[], exclude?: string[] }; // For filters
    base_metric_key?: string; // Add this: Metric this filter applies to (optional)
    filter_language_code?: string; // Add this: Language this filter applies to (optional)
    description?: string;
    is_active?: boolean;
    type: 'metric' | 'filter'; // Type identifier
}

/** DEPRECATED: State required for calculating a moving average incrementally. */
/*
export interface WindowState {
    queue: HistoryEntry[]; // HistoryEntry now uses avgScores
    summedScores: SentimentScores | null;
    summedPostCount: number;
    windowPoints: number;
}
*/

/**
 * Defines the structure of commit metadata passed from the FirehoseSubscription callback.
 * Adjust based on the actual data provided by firehose.ts getOpsByType or callback.
 */
export interface CommitData {
    // Define structure based on what you extract or need from the commit event
    seq: number;
    repo: string;
    commit: any; // Replace 'any' with actual commit CID type if available
    time: string;
    // Add other relevant fields like ops, blocks etc. if needed
}

/**
 * Structure for signals returned by the /api/metrics endpoint.
 * Used by the frontend to populate the signal selection UI.
 */
export interface AvailableSignal {
    id: number | string; // Match MetricSignal id type
    name: string;
    type: 'metric' | 'filter';
}

// --- WebSocket Message Types ---

/** Base interface for all WebSocket messages. */
export interface WebSocketMessage {
    type: string;
    payload: any;
}

/** DEPRECATED: Message from client requesting historical data. */
/*
export interface RequestHistoryMessage {
    type: 'requestHistory';
    payload: {
        languages: string[];
        timeWindowMs: number;
        desiredIntervalMs: number;
        signalNames: string[];
    };
}
*/

/** DEPRECATED: Message from server containing historical data. */
/*
export interface HistoryDataMessage extends WebSocketMessage {
    type: 'historyData';
    payload: {
        // Key: composite "signalName_languageCode", Value: Array of data points
        signalLangData: { [signalLangKey: string]: HistoryEntry[] };
    };
}
*/

/** Message from server indicating an error. */
export interface ErrorMessage extends WebSocketMessage {
    type: 'error';
    payload: string; // Error description
}

// Add a general ClientMessage interface back
export interface ClientMessage {
    type: string;
    payload?: any; 
}

// export type ClientDataType = RequestHistoryMessage | { type: 'ping' }; // Example - Likely remove or simplify if no client interaction

// DEPRECATED: For database rows (matches old schema)
/*
export interface SentimentDataDbRow {
    timestamp: Date; // Or string depending on pg driver
    language: string;
    signal_name: string;
    avg_scores: SentimentScores;
    post_count: number;
    short_avg: SentimentScores | null;
    long_avg: SentimentScores | null;
}
*/

// DEPRECATED: State for calculating simple moving average of average scores
/*
export interface AvgWindowState {
    queue: (SentimentScores | null)[]; // Queue of past average scores
    windowPoints: number;
    // Optional: summedAvgScores might be useful if needed for optimization, but simple queue is fine
}
*/

// DEPRECATED: History Data Payload
/*
export interface HistoryDataPayload {
    signalLangData: { [signalLangKey: string]: HistoryEntry[] };
}
*/

// DEPRECATED: History Data Message
/*
export interface HistoryDataMessage {
    type: 'historyData';
    payload: HistoryDataPayload;
}
*/

// DEPRECATED: Structure for total volume update per language
/*
export interface LiveLangVolumeUpdateEntry {
    language: string;
    timestamp: number;       // Unix timestamp (ms)
    totalPostCount: number;  // Total posts for this language in the interval
}
*/

// DEPRECATED: LiveUpdatePayload includes optional language volumes
/*
export interface LiveUpdatePayload {
  updates: LiveUpdateEntry[]; // Per-signal updates (avgScores, MAs, etc.)
  langVolumes?: LiveLangVolumeUpdateEntry[]; // Optional: Total volume per language
}
*/

// DEPRECATED: Corrected LiveUpdateMessage definition (ensure it extends WebSocketMessage)
/*
export interface LiveUpdateMessage extends WebSocketMessage {
  type: 'liveUpdate';
  payload: LiveUpdatePayload;
} 
*/

export interface LiveUpdateEntry {
    signalName?: string; // Added to distinguish between base metrics and filter signals
}

// NEW Type for database rows from sentiment_metrics
export interface SentimentMetricRow {
    timestamp: Date | string;
    language: string;
    signal_name: string;
    metric_name: string;
    raw_value?: number | null;
    short_ma_value?: number | null;
    long_ma_value?: number | null;
}

// Describes the structure for a signal (metric or filter) 