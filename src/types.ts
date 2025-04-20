/**
 * Defines the structure for sentiment scores (count per category).
 * Uses a dynamic record type to handle any number of emotions.
 */
export type SentimentScores = Record<string, number>;

/**
 * Base structure for aggregated data stored or processed.
 */
export interface AggregatedScoreEntry {
    timestamp: number | Date; // Allow both for flexibility (DB vs buffer)
    scores: SentimentScores;
    postCount: number;
    language?: string; // Optional: Useful for maps keyed by language
}

/**
 * Structure for historical data points, including moving averages.
 * Extends AggregatedScoreEntry, specifying timestamp as number and adding MAs.
 */
export interface HistoryEntry extends Omit<AggregatedScoreEntry, 'timestamp' | 'language'> {
    timestamp: number; // Use number for consistency in history/live updates
    shortAvg?: SentimentScores | null; // Now uses dynamic SentimentScores type
    longAvg?: SentimentScores | null; // Now uses dynamic SentimentScores type
}

/**
 * Structure representing a raw row fetched from the `sentiment_data` database table.
 * Extends AggregatedScoreEntry, specifying timestamp as Date.
 */
export interface RawDbEntry extends Omit<AggregatedScoreEntry, 'timestamp'> {
    timestamp: Date; // Comes from DB as Date
    language: string; // Language is required in DB
}

/**
 * Structure for a single live update data point broadcast via WebSocket.
 * Contains data for a specific signal and language.
 */
export interface LiveUpdateEntry {
    signalName: string; // Which metric or filter this update is for
    language: string;
    timestamp: number; // Use number timestamp
    scores: SentimentScores; // Now uses dynamic SentimentScores type
    postCount: number;
    shortAvg?: SentimentScores | null; // Optional MAs (might not apply to filters)
    longAvg?: SentimentScores | null;
}

/**
 * Structure representing a dynamic signal configuration (e.g., a complex filter).
 * Aligns with the `complex_keyword_filters` database table.
 */
export interface MetricSignal {
    id: number; // Or string if using UUIDs
    name: string;
    description?: string | null;
    keywords_json: string | object; // Store as string from DB, parse as needed
    is_active: boolean;
    type: 'metric' | 'filter'; // Added type discriminator
    // Add other relevant fields if needed
}

/** State required for calculating a moving average incrementally. */
export interface WindowState {
    queue: HistoryEntry[];
    summedScores: SentimentScores; // Now uses dynamic SentimentScores type
    summedPostCount: number;
    windowPoints: number;
}

/**
 * Defines the structure of commit metadata passed from the FirehoseSubscription callback.
 * Adjust based on the actual data provided by firehose.ts getOpsByType or callback.
 */
export interface CommitData {
    repo: string;
    time: string; // Or Date?
    // Include other relevant fields from the original commit if needed by processPost
    // commit: any; // The raw commit object if necessary
    // ops: any[]; // Parsed operations if necessary
}

/**
 * Structure for signals returned by the /api/metrics endpoint.
 * Used by the frontend to populate the signal selection UI.
 */
export interface AvailableSignal {
    id: number | string; // ID from DB (for filters) or name (for default metrics)
    name: string;
    type: 'metric' | 'filter';
}

// --- WebSocket Message Types ---

/** Base interface for all WebSocket messages. */
export interface WebSocketMessage {
    type: string;
    payload: any;
}

/** Message from client requesting historical data. */
export interface RequestHistoryMessage extends WebSocketMessage {
    type: 'requestHistory';
    payload: {
        languages: string[];
        timeWindowMs: number;
        desiredIntervalMs: number;
        signalNames: string[]; // Names of metrics/filters to fetch
    };
}

/** Message from server containing historical data. */
export interface HistoryDataMessage extends WebSocketMessage {
    type: 'historyData';
    payload: {
        // Key: composite "signalName_languageCode", Value: Array of data points
        signalLangData: { [signalLangKey: string]: HistoryEntry[] };
    };
}

/** Message from server containing live data updates. */
export interface LiveUpdateMessage extends WebSocketMessage {
    type: 'liveUpdate';
    payload: {
        updates: LiveUpdateEntry[]; // Array of updates for various signals/langs
    };
}

/** Message from server indicating an error. */
export interface ErrorMessage extends WebSocketMessage {
    type: 'error';
    payload: string; // Error description
}

/** Type alias for messages the client can send. */
export type ClientMessage = RequestHistoryMessage; // Add other client message types if any

/** Type alias for messages the server can send. */
export type ServerMessage = HistoryDataMessage | LiveUpdateMessage | ErrorMessage; // Add other server message types 