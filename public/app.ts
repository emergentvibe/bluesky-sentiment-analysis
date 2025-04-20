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

// --- Interfaces (Mirror Backend/Sentiment) ---
// Defines the structure for sentiment scores (count per category).
interface SentimentScores {
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

// Defines the structure for an aggregated data point from the server (raw data).
interface AggregatedScoreEntry {
    timestamp: number;
    scores: SentimentScores;
    postCount: number;
    // MAs will be added directly in the data from server
}

// --- State Variables ---
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

// --- Time Window Configuration ---
const DEFAULT_WINDOW_HOURS = 24; // Initial time range displayed.
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
let currentTimeWindowMs = DEFAULT_WINDOW_HOURS * HOUR_MS; // Currently selected time window in milliseconds.

// --- WebSocket Configuration ---
let socket: WebSocket | null = null; // Holds the WebSocket connection object.
let reconnectInterval: number | null = null; // Timer ID for reconnection attempts.
const RECONNECT_DELAY = 5000; // Delay (ms) before trying to reconnect after a disconnect.
const AGGREGATION_INTERVAL_MS = 10 * 1000; // Backend's aggregation interval (used to request appropriate granularity).

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
// Defines the structure of a single historical data entry received from the backend.
interface HistoryEntry {
    timestamp: number;
    scores: SentimentScores;
    postCount: number;
    shortAvg?: SentimentScores | null;
    longAvg?: SentimentScores | null;
}
// Defines the structure for historical data for a single language.
interface LanguageHistoryData {
    language: string;
    data: HistoryEntry[];
}
// Defines the structure for a single live update entry from the backend.
interface LiveUpdateEntry {
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

// --- WebSocket Connection ---
/**
 * Establishes and manages the WebSocket connection to the backend server.
 * Handles opening, receiving messages, errors, and automatic reconnection.
 */
function connectWebSocket() {
    const wsUrl = `ws://${window.location.host}`;
    console.log(`Connecting WebSocket to ${wsUrl}`);
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        console.log("WebSocket already open or connecting.");
        return;
    }

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log('WebSocket connected');
        if (reconnectInterval) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }
        // Request initial data on connect
        requestHistoryData();
    };

    socket.onmessage = (event) => {
        try {
            const message: ReceivedServerMessage = JSON.parse(event.data.toString());

            if (message.type === 'historyData') {
                console.log(`Received historyData with ${message.payload.results.length} language results.`);
                // --- TODO: Implement history data handling (Phase 2) ---
                handleHistoryData(message.payload.results);

            } else if (message.type === 'liveUpdate') {
                // console.log(`Received liveUpdate with ${message.payload.updates.length} entries.`);
                // --- TODO: Implement live update handling (Phase 2) ---
                 handleLiveUpdate(message.payload.updates);
            }

        } catch (error) {
            console.error('Error processing WebSocket message:', error);
        }
    };

    socket.onerror = (event) => {
        console.error('WebSocket error:', event);
        // Don't automatically attempt reconnect on error, wait for close
    };

    socket.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        socket = null;
        if (!reconnectInterval) {
            console.log(`Attempting to reconnect in ${RECONNECT_DELAY / 1000} seconds...`);
            reconnectInterval = window.setInterval(() => {
                if (!socket || socket.readyState === WebSocket.CLOSED) {
                    connectWebSocket();
                }
            }, RECONNECT_DELAY);
        }
    };
}

// --- Request Data Function ---
/**
 * Sends a 'requestHistory' message to the WebSocket server.
 * Determines the required languages based on the currently plotted signals.
 * Calculates a desired data interval based on the current time window for efficiency.
 */
function requestHistoryData() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        // Determine unique languages needed from plotted signals
        const requiredLanguages = Array.from(new Set(plottedSignals.map(signal => signal.languageCode)));

        // If no signals plotted, request nothing.
        if (requiredLanguages.length === 0) {
            console.log("No signals plotted. Not requesting history.");
            // Clear chart data if no signals are plotted
            if (chartInstances.sentimentChart) chartInstances.sentimentChart.data.datasets = [];
            if (chartInstances.volumeChart) chartInstances.volumeChart.data.datasets = [];
            updateCharts(); // Update to show empty charts
            return;
        }

        // Determine desired interval based on time window (similar to old downsampling logic)
        let desiredIntervalMs = AGGREGATION_INTERVAL_MS; // Default
        const oneDayMs = 24 * HOUR_MS;
        const oneWeekMs = 7 * oneDayMs;
        if (currentTimeWindowMs > oneWeekMs) { // > 1 week
            desiredIntervalMs = 10 * MINUTE_MS; // Request 10 min intervals
        } else if (currentTimeWindowMs > oneDayMs) { // > 1 day <= 1 week
            desiredIntervalMs = 5 * MINUTE_MS;  // Request 5 min intervals
        } else if (currentTimeWindowMs > 2 * HOUR_MS) { // > 2 hours <= 1 day
            desiredIntervalMs = MINUTE_MS;      // Request 1 min intervals
        }

        console.log(`Requesting history for languages: ${requiredLanguages.join(', ')}, window: ${currentTimeWindowMs/60000}m, interval: ${desiredIntervalMs/1000}s`);

        const requestMessage = {
            type: 'requestHistory',
            payload: {
                languages: requiredLanguages,
                timeWindowMs: currentTimeWindowMs,
                desiredIntervalMs: desiredIntervalMs
            }
        };
        socket.send(JSON.stringify(requestMessage));
        // TODO: Show loading indicator?
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

/**
 * Extracts a specific metric value (e.g., 'netSentiment', 'joy') from a data entry.
 * Handles retrieving raw scores, short MA, or long MA values.
 * Normalizes raw scores by the postCount if applicable.
 * @param entry The data entry (HistoryEntry or LiveUpdateEntry).
 * @param metric The metric identifier (e.g., 'netSentiment', 'joy').
 * @param type Whether to retrieve the 'raw' score, 'short' MA, or 'long' MA.
 * @returns The calculated metric value, or null if unavailable or invalid.
 */
function getMetricValue(entry: HistoryEntry | LiveUpdateEntry, metric: string, type: 'raw' | 'short' | 'long'): number | null {
    let source: SentimentScores | null | undefined;
    let count = entry.postCount; // Needed for raw normalization

    switch (type) {
        case 'raw':
            source = entry.scores;
            break;
        case 'short':
            source = entry.shortAvg;
            count = 1; // MAs are already averaged, don't normalize again
            break;
        case 'long':
            source = entry.longAvg;
            count = 1; // MAs are already averaged, don't normalize again
            break;
    }

    if (!source) return null; // Source MA might be null

    let value: number | null | undefined = null;

    if (metric === 'netSentiment') {
        value = (source.positive ?? 0) - (source.negative ?? 0);
    } else if (AVAILABLE_METRICS.hasOwnProperty(metric)) {
        value = source[metric as keyof SentimentScores];
    }

    if (value == null) return null; // Value might be missing in source

    // Normalize *only* raw scores if count > 0
    if (type === 'raw') {
        return count > 0 ? value / count : null;
    } else {
        return value; // Return MA values directly
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
 * Processes the full historical dataset received from the backend (`historyData` message).
 * Clears existing local data (`currentChartData`) and chart datasets.
 * Stores the received data locally.
 * Rebuilds all datasets for both the sentiment and volume charts based on the currently defined `plottedSignals`.
 * Calls `updateCharts()` to refresh the display.
 * @param results An array of `LanguageHistoryData` objects from the backend.
 */
function handleHistoryData(results: LanguageHistoryData[]) {
    console.log("Processing historyData for dynamic signals...");
    // *** DEBUG: Log the state of plottedSignals ***
    console.log("Current plottedSignals:", JSON.stringify(plottedSignals));

    if (!chartInstances.sentimentChart || !chartInstances.volumeChart) {
        console.error("Charts not initialized, cannot handle history data.");
        return;
    }

    // 1. Store new data locally
    currentChartData = {}; // Clear old data first
    results.forEach(result => {
        currentChartData[result.language] = result.data;
    });

    // 2. Clear existing datasets from charts
    // *** DEBUG: Log dataset counts before/after clear ***
    const sentimentChartDatasetsBefore = chartInstances.sentimentChart.data.datasets.length;
    const volumeChartDatasetsBefore = chartInstances.volumeChart.data.datasets.length;
    console.log(`Datasets before clear - Sentiment: ${sentimentChartDatasetsBefore}, Volume: ${volumeChartDatasetsBefore}`);

    chartInstances.sentimentChart.data.datasets = [];
    chartInstances.volumeChart.data.datasets = [];

    const sentimentChartDatasetsAfterClear = chartInstances.sentimentChart.data.datasets.length;
    const volumeChartDatasetsAfterClear = chartInstances.volumeChart.data.datasets.length;
    console.log(`Datasets after clear - Sentiment: ${sentimentChartDatasetsAfterClear}, Volume: ${volumeChartDatasetsAfterClear}`);

    // 3. Rebuild datasets based on plottedSignals
    console.log("Rebuilding datasets based on plottedSignals...");

    // Volume Chart Data
    const requiredLangsForVolume = new Set<string>();
    plottedSignals.forEach(s => requiredLangsForVolume.add(s.languageCode));

    requiredLangsForVolume.forEach(lang => {
        if (!currentChartData[lang]) {
             console.log(` -> Skipping volume for ${lang}: No data received.`);
             return;
        }
        console.log(` -> Adding volume dataset for ${lang}`);
        const langData = currentChartData[lang];
        const volumeData = langData.map(e => ({ x: e.timestamp, y: e.postCount }));
        const volumeColor = getLanguageColor(lang);
        chartInstances.volumeChart!.data.datasets.push(
            createDatasetConfig(lang, `${lang.toUpperCase()} Volume`, volumeData, volumeColor, { type: 'bar' })
        );
    });
    sortVolumeDatasets(chartInstances.volumeChart); // Sort before update

    // Main Chart Data
    plottedSignals.forEach(signal => {
        if (!currentChartData[signal.languageCode]) {
             console.log(` -> Skipping main chart signal ${signal.id}: No data received for ${signal.languageCode}.`);
             return;
        }
        console.log(` -> Processing main chart signal ${signal.id} (${signal.languageCode} - ${signal.metric} - ${signal.color})`);
        const langData = currentChartData[signal.languageCode];

        // Add Raw Score dataset if requested
        if (signal.showRaw) {
            console.log(`   * Adding Raw dataset`);
            const rawData = langData.map(e => ({ x: e.timestamp, y: getMetricValue(e, signal.metric, 'raw') }));
            chartInstances.sentimentChart!.data.datasets.push(
                createSignalDatasetConfig(signal, 'raw', rawData) as any
            );
        }
        // Add Short MA dataset if requested
        if (signal.showShortMA) {
             console.log(`   * Adding Short MA dataset`);
            const shortMAData = langData.map(e => ({ x: e.timestamp, y: getMetricValue(e, signal.metric, 'short') }));
            chartInstances.sentimentChart!.data.datasets.push(
                createSignalDatasetConfig(signal, 'short', shortMAData) as any
            );
        }
        // Add Long MA dataset if requested
        if (signal.showLongMA) {
             console.log(`   * Adding Long MA dataset`);
            const longMAData = langData.map(e => ({ x: e.timestamp, y: getMetricValue(e, signal.metric, 'long') }));
            chartInstances.sentimentChart!.data.datasets.push(
                createSignalDatasetConfig(signal, 'long', longMAData) as any
            );
        }
    });

    // *** DEBUG: Log dataset count after rebuild ***
    const sentimentChartDatasetsAfterRebuild = chartInstances.sentimentChart.data.datasets.length;
    const volumeChartDatasetsAfterRebuild = chartInstances.volumeChart.data.datasets.length;
    console.log(`Datasets after rebuild - Sentiment: ${sentimentChartDatasetsAfterRebuild}, Volume: ${volumeChartDatasetsAfterRebuild}`);

    // 4. Trigger chart update for all charts
    updateCharts(); // This calls chart.update() internally after setting time scale
    console.log("Charts updated with dynamically plotted signals from history.");
}

/**
 * Processes incoming live data points (`liveUpdate` message).
 * Iterates through updates, checking if the language is relevant based on `plottedSignals`.
 * Adds the new data point to the corresponding datasets in both charts.
 * Prunes old data points that fall outside the `currentTimeWindowMs`.
 * Calls `sortVolumeDatasets` and `updateCharts` if any data was modified.
 * @param updates An array of `LiveUpdateEntry` objects from the backend.
 */
function handleLiveUpdate(updates: LiveUpdateEntry[]) {
    const minTime = Date.now() - currentTimeWindowMs;
    let needsUpdate = false;

     // Helper for score normalization (applied to raw and MA scores)
     const normalizeScore = (score: number | null | undefined, count: number): number | null => {
        if (count > 0 && score != null) {
            return score / count;
        }
        return null;
    };

    updates.forEach(update => {
        // *** ADDED: Log the received update object ***
        console.log(`Received live update for [${update.language}]:`, update);

        // Only process updates for currently selected languages
        if (!selectedLanguages.includes(update.language)) return;

        // Helper to add point and prune old data
        const updateDatasetData = (dataset: any, newDataPoint: { x: number, y: number | null }) => {
             if (newDataPoint.y !== null) {
                dataset.data.push(newDataPoint);
                // Prune data outside the current time window
                dataset.data = dataset.data.filter((point: any) => point.x >= minTime);
                return true; // Indicate update occurred
            }
            return false;
        };

        // Update Sentiment Chart (Raw Score Normalized + MAs Direct)
        chartInstances.sentimentChart?.data.datasets.forEach(ds => {
            const dataset = ds as any;
            if (dataset.languageCode === update.language) {
                 let valueToUpdate: number | null = null;
                 let pointTimestamp = update.timestamp; // Use live update timestamp

                 if (dataset.label.includes('Net Score')) {
                     // Normalize raw score
                     valueToUpdate = normalizeScore((update.scores.positive ?? 0) - (update.scores.negative ?? 0), update.postCount);
                 } else if (dataset.label.includes('Short MA') && update.shortAvg) {
                     // Use MA value directly
                     valueToUpdate = (update.shortAvg.positive ?? 0) - (update.shortAvg.negative ?? 0);
                 } else if (dataset.label.includes('Long MA') && update.longAvg) {
                      // Use MA value directly
                     valueToUpdate = (update.longAvg.positive ?? 0) - (update.longAvg.negative ?? 0);
                 }

                 if (valueToUpdate !== null) {
                    const point = { x: pointTimestamp, y: valueToUpdate };
                    if (updateDatasetData(dataset, point)) needsUpdate = true;
                 }
            }
        });

        // Update Volume Chart
        chartInstances.volumeChart?.data.datasets.forEach(ds => {
            const dataset = ds as any;
             if (dataset.languageCode === update.language && dataset.label.includes('Volume')) {
                 const point = { x: update.timestamp, y: update.postCount };
                 if (updateDatasetData(dataset, point)) needsUpdate = true;
             }
         });

        // Update Emotion Charts (Raw Score Normalized + MAs Direct)
        emotionKeys.forEach(emotion => {
            chartInstances[emotion]?.data.datasets.forEach(ds => {
                const dataset = ds as any;
                if (dataset.languageCode === update.language) {
                    let valueToUpdate: number | null = null;
                    let pointTimestamp = update.timestamp;

                    if (dataset.label.includes('Score')) {
                         // Normalize raw score
                         valueToUpdate = normalizeScore(update.scores[emotion], update.postCount);
                    } else if (dataset.label.includes('Short MA') && update.shortAvg) {
                         // Use MA value directly
                         valueToUpdate = update.shortAvg[emotion];
                    } else if (dataset.label.includes('Long MA') && update.longAvg) {
                         // Use MA value directly
                         valueToUpdate = update.longAvg[emotion];
                    }

                    if (valueToUpdate !== null) {
                        const point = { x: pointTimestamp, y: valueToUpdate };
                        if (updateDatasetData(dataset, point)) needsUpdate = true;
                    }
                 }
            });
        });
    });

    if (needsUpdate) {
        sortVolumeDatasets(chartInstances.volumeChart); // <<< Sort before updating
        updateCharts(); // Update charts if any data was changed/added
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
 * Sets up event listeners and populates dropdowns for the UI controls.
 * Handles the "Add Signal" button, the signal configuration popup (language, metric, color, types),
 * the time window selector, and the list of currently plotted signals.
 */
function setupControls() {
    console.log("Setting up controls..."); // Add entry log

    const addSignalBtn = document.getElementById('addSignalBtn');
    const signalSelectorDiv = document.getElementById('signalSelector');
    const langSelect = document.getElementById('langSelect') as HTMLSelectElement;
    const metricSelect = document.getElementById('metricSelect') as HTMLSelectElement;
    const showRawCheckbox = document.getElementById('showRaw') as HTMLInputElement;
    const showShortMACheckbox = document.getElementById('showShortMA') as HTMLInputElement;
    const showLongMACheckbox = document.getElementById('showLongMA') as HTMLInputElement;
    const confirmSignalBtn = document.getElementById('confirmSignalBtn');
    const cancelSignalBtn = document.getElementById('cancelSignalBtn');
    const timeWindowSelect = document.getElementById('timeWindowSelect') as HTMLSelectElement;
    const signalColorInput = document.getElementById('signalColor') as HTMLInputElement; // Get color input

    // *** DEBUGGING: Check if elements are found ***
    console.log("Add Signal Button:", addSignalBtn);
    console.log("Signal Selector Div:", signalSelectorDiv);
    console.log("Signal Color Input:", signalColorInput);

    // *** ADDED: Set default color programmatically ***
    if (signalColorInput) {
        signalColorInput.value = '#007bff'; // Set default blue
    }

    // Populate Language Selector Dropdown
    if (langSelect) {
        langSelect.innerHTML = ''; // Clear previous options
        AVAILABLE_LANGUAGES.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang.code;
            option.textContent = lang.name;
            if (lang.code === 'eng') option.selected = true; // Default to English
            langSelect.appendChild(option);
        });
    }

    // Populate Metric Selector Dropdown
    if (metricSelect) {
        Object.entries(AVAILABLE_METRICS).forEach(([key, value]) => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = value;
            metricSelect.appendChild(option);
        });
    }

    // Add Signal Button Listener
    addSignalBtn?.addEventListener('click', () => {
        // *** DEBUGGING: Check if listener fires ***
        console.log("Add Signal Button clicked!");
        console.log("Signal Selector Div before display change:", signalSelectorDiv);
        if (signalSelectorDiv) {
            signalSelectorDiv.style.display = 'block';
            console.log("Set signalSelectorDiv display to block.");
        } else {
            console.error("Cannot show signal selector: signalSelectorDiv not found.");
        }
    });

    // Cancel Signal Button Listener
    cancelSignalBtn?.addEventListener('click', () => {
        // *** DEBUGGING: Check if listener fires ***
        console.log("Cancel Signal Button clicked!");
        if (signalSelectorDiv) signalSelectorDiv.style.display = 'none';
    });

    // Confirm Signal Button Listener
    confirmSignalBtn?.addEventListener('click', () => {
         console.log("Confirm Signal Button clicked!");
        // *** Read color picker value ***
        if (langSelect && metricSelect && showRawCheckbox && showShortMACheckbox && showLongMACheckbox && signalColorInput) {
            // *** DEBUG: Log the color input value ***
            console.log(`Reading color input value: ${signalColorInput.value}`);
            const selectedColor = signalColorInput.value;
            const newSignal: PlottedSignalConfig = {
                id: `${langSelect.value}-${metricSelect.value}-${Date.now()}`,
                languageCode: langSelect.value,
                metric: metricSelect.value,
                color: selectedColor, // *** Store selected color ***
                showRaw: showRawCheckbox.checked,
                showShortMA: showShortMACheckbox.checked,
                showLongMA: showLongMACheckbox.checked,
            };
            // *** ADDED BACK: Check for duplicates ***
            const isDuplicate = plottedSignals.some(s =>
                s.languageCode === newSignal.languageCode &&
                s.metric === newSignal.metric &&
                s.color === newSignal.color && // Include color in duplicate check?
                s.showRaw === newSignal.showRaw &&
                s.showShortMA === newSignal.showShortMA &&
                s.showLongMA === newSignal.showLongMA
            );

            if (!isDuplicate) {
                plottedSignals.push(newSignal);
                updatePlottedSignalsUI(); // Update the list display
                requestHistoryData(); // Request new data for the updated signal set
            } else {
                console.log("Signal configuration already exists.");
            }
        }
        if (signalSelectorDiv) signalSelectorDiv.style.display = 'none'; // Hide selector
    });

    // Time Window Selector (No change needed in listener logic)
    if (timeWindowSelect) {
        // Set initial value from state
        timeWindowSelect.value = (currentTimeWindowMs / HOUR_MS).toString();

        timeWindowSelect.addEventListener('change', () => {
            const selectedHours = parseFloat(timeWindowSelect.value);
            if (isNaN(selectedHours)) {
                console.error(`Invalid time window value: ${timeWindowSelect.value}`);
                return;
            }
            currentTimeWindowMs = selectedHours * HOUR_MS;
            console.log(`Time window changed to: ${selectedHours} hours (${currentTimeWindowMs}ms)`);
            requestHistoryData();
        });
    }

    // Initial UI update for plotted signals list
    updatePlottedSignalsUI();

    console.log("Controls setup complete."); // Add exit log
}

// Available Metrics for Selection in the UI dropdown.
const AVAILABLE_METRICS: { [key: string]: string } = {
    netSentiment: 'Net Sentiment (Pos-Neg)',
    anger: 'Anger',
    anticipation: 'Anticipation',
    disgust: 'Disgust',
    fear: 'Fear',
    joy: 'Joy',
    sadness: 'Sadness',
    surprise: 'Surprise',
    trust: 'Trust',
};
// Helper array containing only the emotion keys (excluding 'netSentiment').
const emotionKeys = Object.keys(AVAILABLE_METRICS).filter(k => k !== 'netSentiment'); // Helper

/**
 * Defines the configuration for a single signal to be plotted on the charts.
 * Includes language, metric, color, and which data types (raw, short MA, long MA) to show.
 */
interface PlottedSignalConfig {
    id: string; // Unique ID for removal, e.g., "lang-metric-timestamp"
    languageCode: string;
    metric: string; // e.g., 'netSentiment', 'anger', 'joy'
    color: string; // *** ADDED: User-selected color ***
    showRaw: boolean;
    showShortMA: boolean;
    showLongMA: boolean;
}

// Stores the configurations of all signals currently being displayed.
// Initialized with a default signal (English Net Sentiment).
let plottedSignals: PlottedSignalConfig[] = [
    {
        id: `eng-netSentiment-${Date.now()}`,
        languageCode: 'eng',
        metric: 'netSentiment',
        color: '#007bff', // Default blue color
        showRaw: true,
        showShortMA: true,
        showLongMA: true
    }
];

/**
 * Updates the list of plotted signals displayed in the UI.
 * Clears the existing list and rebuilds it based on the `plottedSignals` array.
 * Adds remove buttons for each signal.
 */
function updatePlottedSignalsUI() {
    const listContainer = document.getElementById('plottedSignalsList');
    if (!listContainer) return;

    listContainer.innerHTML = ''; // Clear current list

    if (plottedSignals.length === 0) {
        listContainer.innerHTML = '<p>No signals added yet.</p>';
        return;
    }

    const ul = document.createElement('ul');
    plottedSignals.forEach(signal => {
        const li = document.createElement('li');
        const metricName = AVAILABLE_METRICS[signal.metric] || signal.metric;
        let types: string[] = []; // *** Added explicit type annotation ***
        if (signal.showRaw) types.push('Raw');
        if (signal.showShortMA) types.push('5m');
        if (signal.showLongMA) types.push('1h');

        // *** ADD: Color indicator span ***
        const colorIndicator = document.createElement('span');
        colorIndicator.style.display = 'inline-block';
        colorIndicator.style.width = '10px';
        colorIndicator.style.height = '10px';
        colorIndicator.style.borderRadius = '50%';
        colorIndicator.style.backgroundColor = signal.color;
        colorIndicator.style.marginRight = '8px';
        colorIndicator.style.verticalAlign = 'middle'; // Align with text

        const signalText = document.createElement('span');
        signalText.textContent = `${signal.languageCode.toUpperCase()} - ${metricName} (${types.join(', ')})`;
        signalText.style.verticalAlign = 'middle';

        const removeBtn = document.createElement('button');
        removeBtn.textContent = '✖';
        removeBtn.classList.add('remove-signal-btn');
        removeBtn.title = 'Remove Signal';
        removeBtn.addEventListener('click', () => {
            plottedSignals = plottedSignals.filter(s => s.id !== signal.id);
            updatePlottedSignalsUI(); // Re-render the list
            requestHistoryData(); // Fetch data for the new set of signals
        });

        // *** Prepend color indicator ***
        li.appendChild(colorIndicator);
        li.appendChild(signalText);
        li.appendChild(removeBtn);
        ul.appendChild(li);
    });
    listContainer.appendChild(ul);
}

/**
 * Determines the visual style (color, line style, thickness, points) for a dataset
 * based on the signal's base color and the data type (raw, short MA, long MA).
 * @param signalColor The base hex color chosen for the signal.
 * @param type The type of data ('raw', 'short', 'long').
 * @returns A style configuration object for a Chart.js dataset.
 */
function getSignalStyle(signalColor: string, type: 'raw' | 'short' | 'long'): { color: string, borderDash?: number[], borderWidth: number, tension?: number, pointRadius?: number, pointHoverRadius?: number } {
    const baseColor = signalColor; // Use the signal's specific color
    switch (type) {
        case 'raw':
            // Make raw line very faint using RGBA - assuming baseColor is hex
            const rawRgba = hexToRgba(baseColor, 0.3);
            return { color: rawRgba, borderWidth: 1, tension: 0.1, pointRadius: 0, pointHoverRadius: 2 };
        case 'short':
            const shortRgba = hexToRgba(baseColor, 0.7);
            return { color: shortRgba, borderDash: [5, 5], borderWidth: 1.5, tension: 0.1, pointRadius: 1, pointHoverRadius: 3 }; // Dashed, medium thickness
        case 'long':
             const longRgba = hexToRgba(baseColor, 1); // Solid
            return { color: longRgba, borderWidth: 2.5, tension: 0.1, pointRadius: 1, pointHoverRadius: 3 }; // Solid, thickest
    }
}

/**
 * Converts a HEX color code (e.g., '#FF0000') to an RGBA string.
 * @param hex The HEX color string (3 or 6 digits, with '#').
 * @param alpha The desired alpha transparency (0.0 to 1.0).
 * @returns An RGBA color string (e.g., 'rgba(255, 0, 0, 0.5)').
 */
function hexToRgba(hex: string, alpha: number): string {
    let r = 0, g = 0, b = 0;
    // 3 digits
    if (hex.length === 4) {
        r = parseInt(hex[1] + hex[1], 16);
        g = parseInt(hex[2] + hex[2], 16);
        b = parseInt(hex[3] + hex[3], 16);
    // 6 digits
    } else if (hex.length === 7) {
        r = parseInt(hex.substring(1, 3), 16);
        g = parseInt(hex.substring(3, 5), 16);
        b = parseInt(hex.substring(5, 7), 16);
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Creates a complete Chart.js dataset configuration object for a specific signal and data type.
 * Uses `getSignalStyle` to determine the visual appearance.
 * Generates an appropriate label for the dataset legend.
 * Includes custom properties (`signalId`, `datasetType`) for easier identification later.
 * @param signal The `PlottedSignalConfig` object.
 * @param type The type of data ('raw', 'short', 'long').
 * @param data The actual data points ({x: timestamp, y: value}).
 * @returns A Chart.js dataset configuration object.
 */
function createSignalDatasetConfig(
    signal: PlottedSignalConfig,
    type: 'raw' | 'short' | 'long',
    data: { x: number, y: number | null }[]
): ChartDataset<'line', { x: number, y: number | null }[]> { // Use specific Chart.js type
    const style = getSignalStyle(signal.color, type); // Pass signal's color
    const metricName = AVAILABLE_METRICS[signal.metric] || signal.metric;
    let typeLabel = '';
    switch (type) {
        case 'raw': typeLabel = 'Raw'; break;
        case 'short': typeLabel = '5m'; break;
        case 'long': typeLabel = '1h'; break;
    }

    // *** Use 'as any' to allow custom properties and simplify type compatibility ***
    return {
        // Custom properties for identification
        signalId: signal.id,
        datasetType: type,
        // Standard Chart.js properties
        label: `${signal.languageCode.toUpperCase()} ${metricName} (${typeLabel})`, // More specific label
        data: data,
        borderColor: style.color,
        backgroundColor: style.color.replace(/,[^,]+?\)$/, ', 0.1)'), // Regex to set alpha to 0.1
        borderWidth: style.borderWidth,
        borderDash: style.borderDash,
        pointRadius: style.pointRadius ?? 1,
        pointHoverRadius: style.pointHoverRadius ?? 3,
        tension: style.tension ?? 0.1,
        hidden: false,
    } as any; // <<< Cast to any here
}

// --- Initialization ---
// Main entry point: Runs when the HTML document is fully loaded and parsed.
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Content Loaded - Initializing dynamic signal plotting UI");
    initializeCharts(); // Initialize the two base charts
    setupControls();    // Setup controls, including signal selector logic
    connectWebSocket(); // Connect WebSocket
});