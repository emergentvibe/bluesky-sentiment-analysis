// --- Interfaces & Types ---
export interface SentimentScores {
    positive?: number;
    negative?: number;
    [key: string]: number | undefined;
}
export interface HistoryEntry {
    timestamp: number;
    scores: SentimentScores;
    postCount: number;
    shortAvg?: SentimentScores | null;
    longAvg?: SentimentScores | null;
}

export type ChartPoint = { x: number; y: number | null; };

export interface PlottedSignalConfig {
    id: string;
    languageCode: string;
    metric: string;
    color: string;
    showRaw: boolean;
    showShortMA: boolean;
    showLongMA: boolean;
}

// --- Backend Data Types ---
export interface LanguageHistoryData {
    language: string;
    data: HistoryEntry[];
}
export interface LiveUpdateEntry {
    signalName: string;
    language: string;
    timestamp: number;
    scores: SentimentScores;
    postCount: number;
    shortAvg?: SentimentScores | null;
    longAvg?: SentimentScores | null;
}

export interface AvailableSignal {
    id: number | string; // Emotion ID (number) or Filter ID (number)
    name: string;
    type: 'metric' | 'filter'; // Differentiator
}

// Message types (consider refining these if needed)
export type ServerHistoryPayload = { signalLangData: { [key: string]: HistoryEntry[] } };
export type ServerLiveUpdatePayload = { updates: LiveUpdateEntry[] };

export type ServerHistoryMessage = { type: 'historyData', payload: ServerHistoryPayload };
export type ServerLiveUpdateMessage = { type: 'liveUpdate', payload: ServerLiveUpdatePayload };
export type ServerErrorMessage = { type: 'error', payload: string };

export type ReceivedServerMessage = ServerHistoryMessage | ServerLiveUpdateMessage | ServerErrorMessage; // Add other message types if they exist

// Client message types
export interface RequestHistoryPayload {
    languages: string[];
    timeWindowMs: number;
    desiredIntervalMs: number;
    signalNames: string[];
}
export type ClientRequestHistoryMessage = { type: 'requestHistory', payload: RequestHistoryPayload };
// Add other client message types if needed
export type ClientMessage = ClientRequestHistoryMessage; // Union of all client message types 