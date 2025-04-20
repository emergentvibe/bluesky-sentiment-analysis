// Add proper imports now that we are bundling
import {
    Chart,
    registerables,
    LineController,
    LineElement,
    PointElement,
    TimeScale,
    LinearScale,
    Title,
    Tooltip,
    Legend,
    ChartTypeRegistry,
    InteractionMode,
    ScaleType,
    ChartConfiguration,
    ChartDataset
} from 'chart.js';
import 'chartjs-adapter-moment'; // Import the adapter
import moment from 'moment'; // Import moment

// Register necessary components
Chart.register(...registerables);

// --- Interfaces & Types ---
interface SentimentScores {
    positive?: number;
    negative?: number;
    [key: string]: number | undefined;
}
interface HistoryEntry {
    timestamp: number;
    scores: SentimentScores;
    postCount: number;
    shortAvg?: SentimentScores | null;
    longAvg?: SentimentScores | null;
}
// Add ChartPoint type definition
type ChartPoint = { x: number; y: number | null; };

// >>> DEFINE PlottedSignalConfig Interface <<<
interface PlottedSignalConfig {
    id: string; 
    languageCode: string;
    metric: string; 
    color: string;
    showRaw: boolean;
    showShortMA: boolean;
    showLongMA: boolean;
}

// --- State Variables ---
let ws: WebSocket | null = null;
let charts: { [key: string]: Chart } = {}; // <<< USE 'charts' consistently
// Holds references to the Chart.js instances.
let chartInstances: {
    sentimentChart: Chart | null;
    volumeChart: Chart | null;
    anger: Chart | null;
    anticipation: Chart | null;
    disgust: Chart | null;
    fear: Chart | null;
    joy: Chart | null;
    sadness: Chart | null;
    surprise: Chart | null;
    trust: Chart | null;
} = {
    sentimentChart: null,
    volumeChart: null,
    anger: null,
    anticipation: null,
    disgust: null,
    fear: null,
    joy: null,
    sadness: null,
    surprise: null,
    trust: null
};
// Defines the base colors used for different emotion charts (obsolete?).
const colors = {
    anger: 'rgba(255, 99, 132, 0.8)',
    anticipation: 'rgba(255, 159, 64, 0.8)',
    disgust: 'rgba(153, 102, 255, 0.8)',
    fear: 'rgba(75, 192, 192, 0.8)',
    joy: 'rgba(54, 162, 235, 0.8)',
    sadness: 'rgba(201, 203, 207, 0.8)',
    surprise: 'rgba(255, 206, 86, 0.8)',
    trust: 'rgba(100, 180, 120, 0.8)',
    // Colors for MA lines will be handled dynamically
};
// Label used for the net sentiment line on the main chart.
const netSentimentLabel = 'Net Sentiment (Pos - Neg)';

// Stores the historical and live data received from the WebSocket backend, keyed by language code (e.g., 'eng').
let currentChartData: { [lang: string]: HistoryEntry[] } = {};

// >>> DEFINE plottedSignals Array <<<
let plottedSignals: PlottedSignalConfig[] = []; 

// --- Time Window Configuration ---
const DEFAULT_WINDOW_HOURS = 24; // Initial time range displayed.
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
let currentTimeWindowMs = DEFAULT_WINDOW_HOURS * HOUR_MS; // Currently selected time window in milliseconds.

// --- WebSocket Configuration ---
// Define reconnect variables
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY = 5000; // 5 seconds
const MAX_RECONNECT_DELAY = 30000; // 30 seconds

// Define aggregation interval (should match backend)
const AGGREGATION_INTERVAL_MS = 10000; // 10 seconds

// --- Language Configuration ---
// List of languages available for selection in the UI.
// Should ideally match the languages supported by the backend lexicon.
const AVAILABLE_LANGUAGES: { code: string, name: string }[] = [
    { code: 'eng', name: 'English' },
    { code: 'fra', name: 'French' },
    { code: 'spa', name: 'Spanish' },
    { code: 'ita', name: 'Italian' },
    { code: 'nld', name: 'Dutch' },
    { code: 'por', name: 'Portuguese' },
    { code: 'swe', name: 'Swedish' },
    { code: 'nob', name: 'Norwegian' },
    { code: 'rus', name: 'Russian' },
    { code: 'deu', name: 'German' },
    { code: 'cmn', name: 'Chinese (Simp)' },
    { code: 'jpn', name: 'Japanese' },
    { code: 'ara', name: 'Arabic' },
    { code: 'pol', name: 'Polish' },
    { code: 'tur', name: 'Turkish' },
    { code: 'vie', name: 'Vietnamese' },
    { code: 'kor', name: 'Korean' },
    { code: 'ind', name: 'Indonesian' },
    { code: 'hin', name: 'Hindi' },
    { code: 'ben', name: 'Bengali' }
];

// Currently selected languages (deprecated? Signals are now individually selected).
let selectedLanguages: string[] = ['eng']; // Default selection

// --- Backend Data Types ---
// Defines the structure for historical data for a single language.
interface LanguageHistoryData {
    language: string;
    data: HistoryEntry[];
}
// Defines the structure for a single live update entry from the backend.
interface LiveUpdateEntry {
    signalName: string;
    language: string;
    timestamp: number;
    scores: SentimentScores;
    postCount: number;
    shortAvg?: SentimentScores | null;
    longAvg?: SentimentScores | null;
}
// Type alias for the historical data message received from the WebSocket.
type ServerHistoryData = { type: 'historyData', payload: { results: LanguageHistoryData[] } };
// Type alias for the live update message received from the WebSocket.
type ServerLiveUpdate = { type: 'liveUpdate', payload: { updates: LiveUpdateEntry[] } };
// Combined type for any message received from the WebSocket server.
type ReceivedServerMessage = ServerHistoryData | ServerLiveUpdate;

// --- Color Generation ---
// Cache to store assigned colors for languages to ensure consistency.
const languageColorCache: { [langCode: string]: string } = {};
let colorIndex = 0; // Index for picking from the base color palette.
const baseColors = [ // A basic palette for assigning colors to languages/signals.
    'rgba(54, 162, 235, 1)',   // Blue
    'rgba(255, 99, 132, 1)',   // Red
    'rgba(75, 192, 192, 1)',   // Teal
    'rgba(255, 206, 86, 1)',   // Yellow
    'rgba(153, 102, 255, 1)', // Purple
    'rgba(255, 159, 64, 1)',  // Orange
    'rgba(100, 180, 120, 1)', // Green
    'rgba(201, 203, 207, 1)'  // Grey
];

/**
 * Gets a consistent color for a given language code.
 * Uses a cache and a rotating palette (baseColors).
 * @param langCode The ISO 639-3 language code (e.g., 'eng').
 * @returns A color string (e.g., 'rgba(54, 162, 235, 1)').
 */
function getLanguageColor(langCode: string): string {
    if (!languageColorCache[langCode]) {
        languageColorCache[langCode] = baseColors[colorIndex % baseColors.length];
        colorIndex++;
    }
    return languageColorCache[langCode];
}

/**
 * Modifies a base color string (intended for MA lines).
 * Currently makes the 'short' MA line fainter.
 * @param color The base RGBA color string.
 * @param type Whether it's for the 'short' or 'long' moving average.
 * @returns A modified RGBA color string.
 * @deprecated This approach is less flexible than getSignalStyle.
 */
function modifyColor(color: string, type: 'short' | 'long'): string {
    if (type === 'short') {
        return color.replace(', 1)', ', 0.4)'); // Fainter for short MA
    }
    return color; // Solid for long MA
}

// --- DOM Element References ---
let loadingIndicator: HTMLElement | null = null;
let timeWindowSelector: HTMLSelectElement | null = null;
let languageCheckboxesContainer: HTMLElement | null = null;
let plottedSignalsListElement: HTMLElement | null = null;
let addSignalBtn: HTMLButtonElement | null = null;
let signalSelectorDiv: HTMLElement | null = null;
let availableSignalsList: HTMLElement | null = null;
let signalColorInput: HTMLInputElement | null = null;
let confirmSignalBtn: HTMLButtonElement | null = null;
let cancelSignalBtn: HTMLButtonElement | null = null;
let langSelect: HTMLSelectElement | null = null;
let showRawCheckbox: HTMLInputElement | null = null;
let showShortMACheckbox: HTMLInputElement | null = null;
let showLongMACheckbox: HTMLInputElement | null = null;

// --- WebSocket Connection ---
/**
 * Establishes and manages the WebSocket connection to the backend server.
 * Handles opening, receiving messages, errors, and automatic reconnection.
 */
function connectWebSocket(): void {
    const wsUrl = `ws://${window.location.host}/ws`;
    console.log(`Connecting WebSocket to ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket connection established.');
        reconnectAttempts = 0;
        requestHistoryData();
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            // console.log('WebSocket message received:', message.type);

            switch (message.type) {
                case 'historyData':
                    // Add check for payload existence before calling handler
                    if (message.payload) {
                        handleHistoryData(message.payload);
                    } else {
                        console.warn('Received historyData message with missing payload.');
                    }
                    break;
                case 'liveUpdate':
                     // Add check for payload existence before calling handler
                    if (message.payload) {
                        handleLiveUpdate(message.payload);
                    } else {
                        console.warn('Received liveUpdate message with missing payload.');
                    }
                    break;
                case 'error':
                    console.error('WebSocket server error:', message.payload);
                    break;
                default:
                    console.warn('Received unknown WebSocket message type:', message.type);
            }
        } catch (error) {
            // This is the error location from the logs (line ~237)
            console.error('Error processing WebSocket message:', error);
            console.error('Raw message data:', event.data); // Log raw data for debugging
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    ws.onclose = (event) => {
        console.error(`WebSocket closed: ${event.code} `);
        ws = null;

        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
            console.log(`Attempting to reconnect in ${delay / 1000} seconds...`);
            setTimeout(connectWebSocket, delay);
        } else {
            console.error('Max reconnect attempts reached. Stopping reconnection.');
        }
    };
}

// --- Request Data Function ---
/**
 * Sends a 'requestHistory' message to the WebSocket server.
 * Determines the required languages AND signal names based on the currently plotted signals.
 * Calculates a desired data interval based on the current time window for efficiency.
 */
function requestHistoryData() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        // Correct Check: Base decision on whether any signals are configured to be plotted
        if (plottedSignals.length === 0) {
            console.log("No signals plotted. Not requesting history.");
            // Clear chart data if no signals are plotted
            if (chartInstances.sentimentChart) chartInstances.sentimentChart.data.datasets = [];
            if (chartInstances.volumeChart) chartInstances.volumeChart.data.datasets = [];
            updateCharts(); // Update to show empty charts
            return;
        }

        // Determine unique languages and signal names needed from plotted signals
        const requiredLanguages = Array.from(new Set(plottedSignals.map(signal => signal.languageCode)));
        const requiredSignalNames = Array.from(new Set(plottedSignals.map(signal => signal.metric))); // Get unique metric names

        // Determine desired interval based on time window
        let desiredIntervalMs = AGGREGATION_INTERVAL_MS;
        const oneDayMs = 24 * HOUR_MS;
        const oneWeekMs = 7 * oneDayMs;
        if (currentTimeWindowMs > oneWeekMs) desiredIntervalMs = 10 * MINUTE_MS;
        else if (currentTimeWindowMs > oneDayMs) desiredIntervalMs = 5 * MINUTE_MS;
        else if (currentTimeWindowMs > 2 * HOUR_MS) desiredIntervalMs = MINUTE_MS;

        console.log(`Requesting history for signals: [${requiredSignalNames.join(', ')}], languages: [${requiredLanguages.join(', ')}], window: ${currentTimeWindowMs/MINUTE_MS}m, interval: ${desiredIntervalMs/1000}s`);

        // Include signalNames in the payload
        const requestMessage = {
            type: 'requestHistory',
            payload: {
                languages: requiredLanguages,
                timeWindowMs: currentTimeWindowMs,
                desiredIntervalMs: desiredIntervalMs,
                signalNames: requiredSignalNames // <<< ADD signalNames array
            }
        };
        ws.send(JSON.stringify(requestMessage));
    } else {
        console.log("WebSocket not open. Cannot request history.");
    }
}

// --- Chart Utilities ---

/**
 * Creates a basic dataset configuration object for Chart.js.
 * @param languageCode The language code this dataset belongs to.
 * @param label The display label for the dataset.
 * @param data The chart data points ({x: timestamp, y: value}).
 * @param color The base color for the dataset.
 * @param options Additional Chart.js dataset options to merge.
 * @returns A Chart.js dataset configuration object.
 * @deprecated Replaced by createSignalDatasetConfig for more specific styling.
 */
function createDatasetConfig(
    languageCode: string,
    label: string,
    data: { x: number, y: number | null }[],
    color: string,
    options: Partial<any> = {} // Allow overriding specific options
): any { // Using 'any' for flexibility with Chart.js dataset types
    return {
        languageCode: languageCode, // Custom property to identify language
        label: label,
        data: data,
        borderColor: color,
        backgroundColor: color.replace('1)', '0.2)'), // Semi-transparent fill
        tension: 0.1,
        pointRadius: 1, // Smaller points
        pointHoverRadius: 3,
        borderWidth: 1.5, // Slightly thicker line
        hidden: false, // Initially visible
        ...options // Merge custom options
    };
}

// --- Dynamic Metrics State ---
// Will be populated by fetching from /api/metrics
interface AvailableSignal {
    id: number | string; // Emotion ID (number) or Filter ID (number)
    name: string;
    type: 'metric' | 'filter'; // Differentiator
}

// Holds the dynamically fetched list of metrics and filters (Task 15.9.2)
let availableSignals: AvailableSignal[] = [];

/**
 * Fetches the list of available metrics AND filters from the backend. (Task 15.9.2)
 */
async function fetchAvailableSignals(): Promise<void> {
    console.log("Fetching available signals from /api/metrics...");
    try {
        const response = await fetch('/api/metrics');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data: AvailableSignal[] = await response.json();
        availableSignals = data;
        console.log("Available signals loaded:", availableSignals);
        if (availableSignals.length === 0) {
             console.warn("Warning: No available signals (metrics/filters) received from backend.");
        }
    } catch (error) {
        console.error("Error fetching available signals:", error);
        // Handle error appropriately, maybe show a message to the user
        availableSignals = []; // Ensure it's empty on error
    }
}

/**
 * Gets the relevant score value from a SentimentScores object.
 * Handles metrics directly (converting to lowercase for lookup) and the 'netSentiment' case.
 */
function getMetricValue(
    scores: SentimentScores | null | undefined,
    metric: string // e.g., "Anger", "netSentiment"
): number | null {
    if (!scores) return null;

    const lowerCaseMetric = metric.toLowerCase(); // Convert metric name to lowercase for lookup

    if (lowerCaseMetric === 'netsentiment') { // Compare lowercase
        // Access scores using lowercase keys defined in SentimentScores interface
        const positive = scores['positive'] ?? 0;
        const negative = scores['negative'] ?? 0;
        return positive - negative;
    } else if (scores.hasOwnProperty(lowerCaseMetric)) { // Check lowercase key
        // Access using lowercase key
        return scores[lowerCaseMetric] ?? null;
    } else {
        // console.warn(`Metric key "${lowerCaseMetric}" not found in scores object:`, scores);
        return null; // Metric key not found
    }
}

// --- Chart Initialization ---
/**
 * Creates the configuration object for the time (X) axis in Chart.js.
 * Uses the 'chartjs-adapter-moment' for time handling.
 * Configures display formats and tooltip formats.
 * Includes a custom tick callback to display relative time labels (e.g., '-5m', '-2h').
 * @returns A Chart.js scale configuration object for the time axis.
 */
function createTimeAxisOptions(): any { // Use any for now, specific Chart.js types can be complex
    return {
        type: 'time' as ScaleType, // Explicitly cast
        adapters: {
            date: { // Use Chart.js Moment adapter
                locale: moment.locale()
            }
        },
        time: {
            unit: 'minute' as const, // Sensible default, may adjust dynamically later
            tooltipFormat: 'YYYY-MM-DD HH:mm', // Format for tooltips
            displayFormats: {
                minute: 'HH:mm',
                hour: 'MMM D, HH:mm',
                day: 'MMM D'
            }
        },
        title: {
            display: true,
            text: 'Time'
        },
        ticks: {
            source: 'auto' as const, // Automatically determine ticks
             maxRotation: 0, // Prevent label rotation
             autoSkip: true,
             callback: function (value: any, index: number, ticks: any[]): string | null {
                 const timestamp = typeof value === 'number' ? value : this.getPixelForTick(index); // `this` refers to the scale object
                 const now = Date.now();
                 const diffMinutes = (now - timestamp) / MINUTE_MS;
                 const diffHours = diffMinutes / 60;
                 const diffDays = diffHours / 24;

                 if (Math.abs(diffMinutes) < 1) return 'Now';
                 if (diffMinutes < 60) return `-${Math.round(diffMinutes)}m`;
                 if (diffHours < 24) return `-${Math.round(diffHours)}h`;
                 return `-${Math.round(diffDays)}d`;
             }
        }
    };
}

/**
 * Initializes the main sentiment chart and the volume chart instances.
 * Destroys any existing chart instances first.
 * Sets up common options (responsiveness, time axis, tooltips, legend).
 * Creates the 'line' chart for sentiment trends and the 'bar' chart for volume.
 */
function initializeCharts() {
    console.log("Initializing simplified charts...");

    const mainCtx = (document.getElementById('mainChart') as HTMLCanvasElement)?.getContext('2d');
    const volumeCtx = (document.getElementById('volumeChart') as HTMLCanvasElement)?.getContext('2d');

    if (!mainCtx) console.error('Failed to get 2D context for mainChart');
    if (!volumeCtx) console.error('Failed to get 2D context for volumeChart');

    // Destroy existing charts
    chartInstances.sentimentChart?.destroy();
    chartInstances.volumeChart?.destroy();
    chartInstances.sentimentChart = null; // Explicitly nullify
    chartInstances.volumeChart = null;

    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false as const,
        scales: { x: createTimeAxisOptions() },
        plugins: {
            legend: { position: 'top' as const, labels: { boxWidth: 12, font: { size: 10 } } },
            tooltip: { mode: 'index' as InteractionMode, intersect: false },
        },
        interaction: { mode: 'nearest' as InteractionMode, axis: 'x' as const, intersect: false }
    };

    // --- Initialize Main Chart (Line) ---
    if (mainCtx) {
        try {
            chartInstances.sentimentChart = new Chart(mainCtx, {
                type: 'line',
                data: { datasets: [] }, // Start empty
                options: {
                    ...commonOptions,
                    plugins: { ...commonOptions.plugins, title: { display: true, text: 'Sentiment Trends' } },
                    scales: {
                        x: commonOptions.scales.x,
                        y: { title: { display: true, text: 'Score / Avg. Score' } } // Generic Y-axis label
                    }
                }
            });
            console.log("Main chart instance created.");
        } catch (error) {
            console.error("Error creating main chart:", error);
            chartInstances.sentimentChart = null; // Ensure it's null if creation failed
        }
    } else {
        console.error("Cannot initialize main chart - context not available.");
    }

    // --- Initialize Volume Chart (Bar) ---
    if (volumeCtx) {
         try {
            chartInstances.volumeChart = new Chart(volumeCtx, {
                type: 'bar',
                data: { datasets: [] }, // Start empty
                options: {
                    ...commonOptions,
                    plugins: { ...commonOptions.plugins, title: { display: true, text: 'Post Volume' } },
                    scales: {
                        x: { ...commonOptions.scales.x, stacked: true }, // Stack on time axis
                        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Posts per Interval' } }
                    },
                    datasets: { bar: { barPercentage: 0.9, categoryPercentage: 0.85 } }
                }
            });
            console.log("Volume chart instance created.");
         } catch (error) {
             console.error("Error creating volume chart:", error);
             chartInstances.volumeChart = null; // Ensure it's null if creation failed
         }
    } else {
         console.error("Cannot initialize volume chart - context not available.");
    }

    // console.log("Chart initialization complete."); // Changed log location
}

// --- Chart Update Logic ---

/**
 * Updates all active chart instances.
 * Sets the minimum and maximum time on the X-axis based on `currentTimeWindowMs`.
 * Calls `chart.update('none')` to redraw the charts without animation.
 */
function updateCharts() {
    const now = Date.now();
    const minTime = now - currentTimeWindowMs;

    // Update all charts efficiently
    Object.values(chartInstances).forEach(chart => {
        if (chart) {
            // *** ADDED: Set x-axis min/max based on currentTimeWindowMs ***
            if (chart.options?.scales?.x) {
                 chart.options.scales.x.min = minTime;
                 chart.options.scales.x.max = now;
            }
            chart.update('none'); // Use 'none' to prevent animation
        }
    });
    // console.log("Charts updated."); // Optional debug log
}

/**
 * Handles the initial batch of historical data received from the server.
 * Updates chart datasets based on the new signalLangData structure.
 */
function handleHistoryData(payload: { signalLangData: { [key: string]: HistoryEntry[] } }): void {
    console.log('Processing history data...');
    if (loadingIndicator) {
        loadingIndicator.style.display = 'none';
    }

    if (!payload || !payload.signalLangData) {
        console.warn('Received empty or invalid history data payload.');
        clearAllChartData();
        updateCharts();
        return;
    }

    const { signalLangData } = payload;
    clearAllChartData();

    plottedSignals.forEach(config => {
        const signalKey = `${config.metric}_${config.languageCode}`;
        const historyPoints = signalLangData[signalKey];

        if (historyPoints && historyPoints.length > 0) {
            console.log(` -> Populating history for ${signalKey} with ${historyPoints.length} points.`);
            
            const mainData: ChartPoint[] = [];
            const shortAvgData: ChartPoint[] = [];
            const longAvgData: ChartPoint[] = [];
            const volumeData: ChartPoint[] = [];
            let validPointsCount = 0; // Counter for non-null points

            historyPoints.forEach(point => {
                const timestamp = point.timestamp;
                const pointData: ChartPoint = { x: timestamp, y: null };
                const shortAvgPointData: ChartPoint = { x: timestamp, y: null };
                const longAvgPointData: ChartPoint = { x: timestamp, y: null };
                const volPointData: ChartPoint = { x: timestamp, y: point.postCount };

                // Get raw score sum
                pointData.y = getMetricValue(point.scores, config.metric);
                
                // >>> AVERAGE the raw score by post count <<< 
                if (pointData.y !== null && point.postCount > 0) {
                    pointData.y /= point.postCount;
                } else if (point.postCount === 0) {
                    // If no posts, the average score is 0 (or null, depending on desired display)
                    pointData.y = 0; 
                }
                // >>> END AVERAGE <<<

                // Get MAs (already averaged by backend)
                shortAvgPointData.y = getMetricValue(point.shortAvg, config.metric);
                longAvgPointData.y = getMetricValue(point.longAvg, config.metric);

                // >>> ADD LOGGING HERE <<<
                if (pointData.y !== null || shortAvgPointData.y !== null || longAvgPointData.y !== null) {
                    // Log only if at least one value is non-null to avoid spamming
                    // console.log(`  -> Time: ${new Date(timestamp).toISOString()}, Raw: ${pointData.y?.toFixed(4)}, Short: ${shortAvgPointData.y?.toFixed(4)}, Long: ${longAvgPointData.y?.toFixed(4)}`);
                    validPointsCount++;
                }
                // >>> END LOGGING <<<

                mainData.push(pointData);
                shortAvgData.push(shortAvgPointData);
                longAvgData.push(longAvgPointData);
                volumeData.push(volPointData);
            });
            
            console.log(` -> Processed ${historyPoints.length} history points for ${signalKey}. Found ${validPointsCount} points with non-null scores/MAs.`);

            // Add/update datasets 
            updateDataset(chartInstances.sentimentChart, `${config.metric} (${config.languageCode}) - Raw`, mainData, config.color);
            updateDataset(chartInstances.sentimentChart, `${config.metric} (${config.languageCode}) - Short MA`, shortAvgData, config.color, true, true); 
            updateDataset(chartInstances.sentimentChart, `${config.metric} (${config.languageCode}) - Long MA`, longAvgData, config.color, true, true);
            updateDataset(chartInstances.volumeChart, `Volume (${config.languageCode})`, volumeData, config.color + '80');

        } else {
            console.log(` -> No history data found for plotted signal: ${signalKey}`);
            removeDataset(chartInstances.sentimentChart, `${config.metric} (${config.languageCode}) - Raw`);
            removeDataset(chartInstances.sentimentChart, `${config.metric} (${config.languageCode}) - Short MA`);
            removeDataset(chartInstances.sentimentChart, `${config.metric} (${config.languageCode}) - Long MA`);
            removeDataset(chartInstances.volumeChart, `Volume (${config.languageCode})`);
        }
    });

    updateCharts();
}

// Helper function to clear all datasets from charts
function clearAllChartData(): void {
    if (chartInstances.sentimentChart) {
        chartInstances.sentimentChart.data.datasets = [];
    }
    if (chartInstances.volumeChart) {
        chartInstances.volumeChart.data.datasets = [];
    }
    // Don't call updateCharts() here, let the caller do it after potentially adding new data
}

/**
 * Processes incoming live data points (`liveUpdate` message).
 * Routes updates to the correct signal datasets on the main chart.
 * Aggregates post counts per language and updates the volume chart.
 */
function handleLiveUpdate(payload: { updates: LiveUpdateEntry[] }): void {
    // >>> 1. Log entry and payload <<<
    console.log(`Received liveUpdate with ${payload?.updates?.length || 0} entries.`);
    // console.log("LiveUpdate Payload:", payload);

    if (!payload || !Array.isArray(payload.updates) || payload.updates.length === 0) {
        return; // No updates to process
    }

    let chartNeedsUpdate = false; // Flag to update chart only if data was added

    payload.updates.forEach(update => {
        const signalKey = `${update.signalName}_${update.language}`; // e.g., Anger_eng

        // >>> 2. Log signal key being processed <<<
        // console.log(` -> Processing update for: ${signalKey}`);

        // Check if this specific signal+language is currently plotted
        const correspondingPlottedSignal = plottedSignals.find(p => 
            p.metric === update.signalName && p.languageCode === update.language
        );

        // Only process update if the signal is actively plotted
        if (correspondingPlottedSignal) {
            const chart = chartInstances.sentimentChart;
            const volumeChart = chartInstances.volumeChart;
            if (!chart || !volumeChart) return; // Charts not ready

            // Find datasets by label (ensure labels match handleHistoryData)
            const rawLabel = `${update.signalName} (${update.language}) - Raw`;
            const shortMALabel = `${update.signalName} (${update.language}) - Short MA`;
            const longMALabel = `${update.signalName} (${update.language}) - Long MA`;
            const volumeLabel = `Volume (${update.language})`;

            const rawDataset = chart.data.datasets.find(ds => ds.label === rawLabel);
            const shortMADataset = chart.data.datasets.find(ds => ds.label === shortMALabel);
            const longMADataset = chart.data.datasets.find(ds => ds.label === longMALabel);
            const volumeDataset = volumeChart.data.datasets.find(ds => ds.label === volumeLabel);

            // >>> 3. Log dataset finding results <<<
            // console.log(`   -> Datasets found: Raw=${!!rawDataset}, Short=${!!shortMADataset}, Long=${!!longMADataset}, Volume=${!!volumeDataset}`);

            // Create the new data points
            const timestamp = update.timestamp;
            
            // Get raw score sum
            const rawPoint: ChartPoint = { x: timestamp, y: getMetricValue(update.scores, update.signalName) };
            
            // >>> AVERAGE the raw score by post count <<< 
            if (rawPoint.y !== null && update.postCount > 0) {
                rawPoint.y /= update.postCount;
            } else if (update.postCount === 0) {
                 rawPoint.y = 0; // Or null
            }
            // >>> END AVERAGE <<<

            // Get MAs (already averaged)
            const shortMAPoint: ChartPoint = { x: timestamp, y: getMetricValue(update.shortAvg, update.signalName) };
            const longMAPoint: ChartPoint = { x: timestamp, y: getMetricValue(update.longAvg, update.signalName) };
            const volumePoint: ChartPoint = { x: timestamp, y: update.postCount };

             // >>> 4. Log points being added <<<
            // console.log(`   -> Adding point: Raw=${rawPoint.y}, Short=${shortMAPoint.y}, Long=${longMAPoint.y}, Vol=${volumePoint.y}`);

            // Add data points to the respective datasets if they exist
            // Also remove old data points if buffer exceeds max window + buffer
            const bufferTime = Date.now() - (currentTimeWindowMs + (5 * MINUTE_MS)); // Keep current window + 5min buffer

            if (rawDataset?.data) {
                (rawDataset.data as ChartPoint[]).push(rawPoint);
                // Use 'as any' to assign filtered data back
                rawDataset.data = (rawDataset.data as ChartPoint[]).filter(p => p.x >= bufferTime) as any;
                chartNeedsUpdate = true;
            }
            if (shortMADataset?.data) {
                (shortMADataset.data as ChartPoint[]).push(shortMAPoint);
                // Use 'as any' to assign filtered data back
                shortMADataset.data = (shortMADataset.data as ChartPoint[]).filter(p => p.x >= bufferTime) as any;
                chartNeedsUpdate = true;
            }
            if (longMADataset?.data) {
                (longMADataset.data as ChartPoint[]).push(longMAPoint);
                // Use 'as any' to assign filtered data back
                longMADataset.data = (longMADataset.data as ChartPoint[]).filter(p => p.x >= bufferTime) as any;
                chartNeedsUpdate = true;
            }
            if (volumeDataset?.data) {
                (volumeDataset.data as ChartPoint[]).push(volumePoint);
                // Use 'as any' to assign filtered data back
                volumeDataset.data = (volumeDataset.data as ChartPoint[]).filter(p => p.x >= bufferTime) as any;
                chartNeedsUpdate = true;
            }
        }
    });

    // >>> 5. Ensure updateCharts is called AFTER the loop <<<
    if (chartNeedsUpdate) {
        console.log("Updating charts after live update processing.");
        updateCharts(); // Update both charts if any data was added
    }
}

/**
 * Sorts the datasets in the volume chart (stacked bar chart) by their total volume
 * within the current time window, in descending order.
 * This ensures that the largest volume bars appear at the bottom of the stack.
 * @param chart The Chart.js instance for the volume chart.
 */
function sortVolumeDatasets(chart: Chart | null) {
    // Simplified check: Assume if called on volumeChart, it's a stacked bar chart
    if (!chart || !chart.data?.datasets) {
        return;
    }
    // We know we set the y-axis to stacked for volumeChart in initializeCharts
    // Add a check here if you modify initialization later
    // const isStacked = (chart.options?.scales?.y as any)?.stacked;
    // if (!isStacked) return;

    const now = Date.now();
    const minTime = now - currentTimeWindowMs;

    // Calculate total volume within the current time window for each dataset
    chart.data.datasets.forEach((dataset: any) => {
        // Ensure data exists and is an array before filtering/reducing
        if (Array.isArray(dataset.data)) {
            dataset.totalVolume = dataset.data
                .filter((point: any) => point && typeof point === 'object' && point.x >= minTime && point.y !== null)
                .reduce((sum: number, point: any) => sum + (point.y || 0), 0);
        } else {
            dataset.totalVolume = 0; // Assign 0 if data is missing or not an array
        }
    });

    // Sort datasets array in descending order by totalVolume
    // This makes the largest volume appear at the bottom of the stack in Chart.js
    chart.data.datasets.sort((a: any, b: any) => (b.totalVolume ?? 0) - (a.totalVolume ?? 0));

    // Clean up temporary property (optional)
    chart.data.datasets.forEach((dataset: any) => delete dataset.totalVolume);
}

// --- UI Controls Setup ---
/**
 * Sets up event listeners and populates dropdowns/lists for the UI controls.
 */
function setupControls() {
    console.log("Setting up controls...");

    // Elements should be assigned in DOMContentLoaded before this runs

    // --- Populate Language Selector ---
    if (langSelect) {
        langSelect.innerHTML = '';
        AVAILABLE_LANGUAGES.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang.code;
            option.textContent = lang.name;
            if (lang.code === 'eng') option.selected = true;
            // @ts-ignore - Suppress persistent null check error
            langSelect.appendChild(option);
        });
    }

    // --- Populate Available Signals List ---
    if (availableSignalsList) {
        availableSignalsList.innerHTML = '';
        if (availableSignals.length === 0) {
            availableSignalsList.innerHTML = '<p>No signals available from backend.</p>';
        } else {
            availableSignals.forEach((signal, index) => {
                const div = document.createElement('div');
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.id = `signal-radio-${signal.id || signal.name}`;
                radio.name = 'availableSignal';
                radio.value = signal.name;
                if (index === 0) radio.checked = true;
                const label = document.createElement('label');
                label.htmlFor = radio.id;
                label.textContent = `${signal.name} (${signal.type})`;
                label.style.marginLeft = '5px';
                div.appendChild(radio);
                div.appendChild(label);
                // @ts-ignore - Suppress persistent null check error
                availableSignalsList.appendChild(div);
            });
        }
    } else {
         console.error("Available signals list element not found!");
    }

    // --- Event Listeners ---
    addSignalBtn?.addEventListener('click', () => {
        if (signalSelectorDiv) signalSelectorDiv.style.display = 'block';
    });

    cancelSignalBtn?.addEventListener('click', () => {
        if (signalSelectorDiv) signalSelectorDiv.style.display = 'none';
    });

    confirmSignalBtn?.addEventListener('click', () => {
         console.log("Confirm Signal Button clicked!");
         
         // Keep the explicit null checks for safety
         if (!langSelect || !availableSignalsList || !signalColorInput || !showRawCheckbox || !showShortMACheckbox || !showLongMACheckbox) {
              console.error("Cannot confirm signal: One or more required configuration elements are missing.");
              return;
         }

         // Use @ts-ignore to suppress persistent linter errors within the callback
         // @ts-ignore 
         const selectedLang = langSelect.value;
         // @ts-ignore
         const selectedSignalRadio = availableSignalsList.querySelector('input[name="availableSignal"]:checked') as HTMLInputElement | null;
         const selectedMetric = selectedSignalRadio?.value;
         // @ts-ignore 
         const selectedColor = signalColorInput.value;
         // @ts-ignore 
         const showRaw = showRawCheckbox.checked;
         // @ts-ignore 
         const showShortMA = showShortMACheckbox.checked;
         // @ts-ignore 
         const showLongMA = showLongMACheckbox.checked;

         if (selectedLang && selectedMetric && selectedColor !== undefined) {
             addSignalToPlot(selectedLang, selectedMetric, selectedColor, showRaw, showShortMA, showLongMA);
         } else { 
              console.warn("Could not add signal - Metric not selected or missing?", { selectedLang, selectedMetric });
         }
         
         if (signalSelectorDiv) signalSelectorDiv.style.display = 'none'; 
    });

    timeWindowSelector?.addEventListener('change', () => {
        if (!timeWindowSelector) return;
        // Use @ts-ignore to suppress persistent linter error within the callback
        // @ts-ignore
        const selectedHours = parseFloat(timeWindowSelector.value);
        if (!isNaN(selectedHours)) {
            currentTimeWindowMs = selectedHours * HOUR_MS;
            requestHistoryData();
        }
    });

    console.log("Controls setup complete.");
}

/**
 * Adds a new signal configuration to the plottedSignals array and updates the UI/charts.
 */
function addSignalToPlot(langCode: string, metric: string, color: string, showRaw: boolean, showShortMA: boolean, showLongMA: boolean): void {
    const newSignal: PlottedSignalConfig = {
        id: `${langCode}-${metric}-${Date.now()}`,
        languageCode: langCode,
        metric: metric,
        color: color,
        showRaw: showRaw,
        showShortMA: showShortMA,
        showLongMA: showLongMA,
    };
    const isDuplicate = plottedSignals.some(s => s.languageCode === newSignal.languageCode && s.metric === newSignal.metric);
    if (!isDuplicate) {
        plottedSignals.push(newSignal);
        updatePlottedSignalsUI();
        requestHistoryData();
        console.log(`Added signal: ${metric} (${langCode})`);
    } else {
        console.log("Signal configuration (lang/metric) already plotted.");
    }
}

/**
 * Updates the UI list showing currently plotted signals.
 */
function updatePlottedSignalsUI() {
    if (!plottedSignalsListElement) {
        console.error("Cannot update plotted signals UI: element not found.");
        return;
    }
    plottedSignalsListElement.innerHTML = '';
    if (plottedSignals.length === 0) {
        plottedSignalsListElement.innerHTML = '<p>No signals added yet.</p>';
        return;
    }
    const ul = document.createElement('ul');
    plottedSignals.forEach(signal => {
        const li = document.createElement('li');
        const swatch = document.createElement('span');
        swatch.style.cssText = `display:inline-block; width:12px; height:12px; background-color:${signal.color}; margin-right:8px; border:1px solid #ccc;`;
        const label = document.createElement('span');
        label.textContent = `${signal.metric} (${signal.languageCode.toUpperCase()})`;
        label.style.flexGrow = '1';
        const removeBtn = document.createElement('button');
        removeBtn.textContent = '×';
        removeBtn.className = 'remove-signal-btn';
        removeBtn.title = 'Remove Signal';
        removeBtn.onclick = () => removeSignal(signal.id);
        li.appendChild(swatch);
        li.appendChild(label);
        li.appendChild(removeBtn);
        ul.appendChild(li);
    });
    plottedSignalsListElement.appendChild(ul);
}

/**
 * Removes a signal from the plottedSignals array and updates the UI and charts.
 */
function removeSignal(signalId: string): void {
    console.log(`Removing signal with ID: ${signalId}`);
    plottedSignals = plottedSignals.filter(s => s.id !== signalId);
    updatePlottedSignalsUI();
    requestHistoryData(); 
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM Content Loaded - Initializing...');

    // Assign ALL elements here
    loadingIndicator = document.getElementById('loadingIndicator');
    timeWindowSelector = document.getElementById('timeWindowSelector') as HTMLSelectElement;
    plottedSignalsListElement = document.getElementById('plottedSignalsList');
    addSignalBtn = document.getElementById('addSignalBtn') as HTMLButtonElement;
    signalSelectorDiv = document.getElementById('signalSelector');
    availableSignalsList = document.getElementById('availableSignalsList');
    signalColorInput = document.getElementById('signalColor') as HTMLInputElement;
    confirmSignalBtn = document.getElementById('confirmSignalBtn') as HTMLButtonElement;
    cancelSignalBtn = document.getElementById('cancelSignalBtn') as HTMLButtonElement;
    langSelect = document.getElementById('langSelect') as HTMLSelectElement;
    showRawCheckbox = document.getElementById('showRaw') as HTMLInputElement;
    showShortMACheckbox = document.getElementById('showShortMA') as HTMLInputElement;
    showLongMACheckbox = document.getElementById('showLongMA') as HTMLInputElement;

    // Combine checks
    if (!loadingIndicator || !timeWindowSelector || !plottedSignalsListElement || !addSignalBtn || !signalSelectorDiv || !availableSignalsList || !signalColorInput || !confirmSignalBtn || !cancelSignalBtn || !langSelect || !showRawCheckbox || !showShortMACheckbox || !showLongMACheckbox) {
        console.error("CRITICAL: One or more required UI elements not found! Check IDs in index.html.");
        return;
    }

    if (loadingIndicator) loadingIndicator.style.display = 'block';

    await fetchAvailableSignals();
    initializeCharts();
    setupControls();
    updatePlottedSignalsUI();

    connectWebSocket();

    if (loadingIndicator) loadingIndicator.style.display = 'none';
});

/**
 * Adds or updates a dataset in a given chart instance.
 */
function updateDataset(chart: Chart | null, label: string, data: ChartPoint[], color: string, isDashed: boolean = false, isMA: boolean = false): void {
    if (!chart) return;
    const existingDatasetIndex = chart.data.datasets.findIndex(ds => ds.label === label);
    const datasetConfig: Partial<ChartDataset<'line', ChartPoint[]>> = {
        label: label,
        data: data,
        borderColor: color,
        backgroundColor: color + '30',
        borderWidth: isMA ? 1 : 2,
        pointRadius: isMA ? 0 : 1,
        pointHoverRadius: isMA ? 0 : 3,
        tension: 0.1,
        borderDash: isDashed ? [5, 5] : undefined,
        fill: !isMA,
    };
    if (existingDatasetIndex > -1) {
        chart.data.datasets[existingDatasetIndex] = { 
            ...chart.data.datasets[existingDatasetIndex], 
            ...datasetConfig 
        } as any; // Type assertion
    } else {
        chart.data.datasets.push(datasetConfig as any); // Type assertion
    }
}

/**
 * Removes a dataset from a chart by its label.
 */
function removeDataset(chart: Chart | null, label: string): void {
    if (!chart) return;
    const datasetIndex = chart.data.datasets.findIndex(ds => ds.label === label);
    if (datasetIndex > -1) {
        chart.data.datasets.splice(datasetIndex, 1);
    }
}
