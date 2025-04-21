import { MetricSignal, HistoryEntry, WindowState, SentimentScores, AvgWindowState } from '../types.js';

// Export mutable state variables
export let dynamicSignals: MetricSignal[] = [];
export let currentEmotionKeys: string[] = [];
export let baseMetricKeysMap: Map<string, boolean> = new Map();
export let currentIntervalScores: { [lang: string]: { [signalName: string]: SentimentScores } } = {};
export let currentIntervalPostCount: { [lang: string]: { [signalName: string]: number } } = {};
export let recentHistoryBuffer: { [signalLangKey: string]: HistoryEntry[] } = {};
export let liveMAState: { [signalLangKey: string]: { short: WindowState; long: WindowState } } = {};
export let liveAvgMAState: { [signalLangKey: string]: { short: AvgWindowState; long: AvgWindowState } } = {}; 