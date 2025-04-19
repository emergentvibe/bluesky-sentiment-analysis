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
    ChartConfiguration // Import ChartConfiguration type
} from 'chart.js';
import 'chartjs-adapter-moment'; // Import the adapter
import moment from 'moment'; // Import moment

// Register necessary components
Chart.register(...registerables);

// --- Interfaces (Mirror Backend/Sentiment) ---
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

// Keep this simple for now, details come from server MAs
interface AggregatedScoreEntry {
    timestamp: number;
    scores: SentimentScores;
    postCount: number;
    // MAs will be added directly in the data from server
}

// --- State Variables ---
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
const emotionKeys: (keyof SentimentScores)[] = ['anger', 'anticipation', 'disgust', 'fear', 'joy', 'sadness', 'surprise', 'trust'];
const netSentimentLabel = 'Net Sentiment (Pos - Neg)';

// Store data received from backend, keyed by language
let currentChartData: { [lang: string]: HistoryEntry[] } = {};

// Time window state
const DEFAULT_WINDOW_HOURS = 24;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
let currentTimeWindowMs = DEFAULT_WINDOW_HOURS * HOUR_MS;

// WebSocket state
let socket: WebSocket | null = null;
let reconnectInterval: number | null = null;
const RECONNECT_DELAY = 5000; // 5 seconds
const AGGREGATION_INTERVAL_MS = 10 * 1000; // Used for requesting interval

// Define Available Languages (Mirroring backend TARGET_LANGUAGES keys)
// TODO: Ideally, fetch this from backend or derive from initial data
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

let selectedLanguages: string[] = ['eng']; // Default selection

// Define types needed from backend messages
interface HistoryEntry {
    timestamp: number;
    scores: SentimentScores;
    postCount: number;
    shortAvg?: SentimentScores | null;
    longAvg?: SentimentScores | null;
}
interface LanguageHistoryData {
    language: string;
    data: HistoryEntry[];
}
interface LiveUpdateEntry {
    language: string;
    timestamp: number;
    scores: SentimentScores;
    postCount: number;
    shortAvg?: SentimentScores | null;
    longAvg?: SentimentScores | null;
}
// Combined type for received data
type ServerHistoryData = { type: 'historyData', payload: { results: LanguageHistoryData[] } };
type ServerLiveUpdate = { type: 'liveUpdate', payload: { updates: LiveUpdateEntry[] } };
type ReceivedServerMessage = ServerHistoryData | ServerLiveUpdate;

// --- Color Generation ---
// Simple function to generate distinct colors - can be improved
// Or use a predefined palette array
const languageColorCache: { [langCode: string]: string } = {};
let colorIndex = 0;
const baseColors = [ // Basic palette
    'rgba(54, 162, 235, 1)',   // Blue
    'rgba(255, 99, 132, 1)',   // Red
    'rgba(75, 192, 192, 1)',   // Teal
    'rgba(255, 206, 86, 1)',   // Yellow
    'rgba(153, 102, 255, 1)', // Purple
    'rgba(255, 159, 64, 1)',  // Orange
    'rgba(100, 180, 120, 1)', // Green
    'rgba(201, 203, 207, 1)'  // Grey
];

function getLanguageColor(langCode: string): string {
    if (!languageColorCache[langCode]) {
        languageColorCache[langCode] = baseColors[colorIndex % baseColors.length];
        colorIndex++;
    }
    return languageColorCache[langCode];
}

// Helper to slightly modify color alpha/style for MA lines
function modifyColor(color: string, type: 'short' | 'long'): string {
    if (type === 'short') {
        return color.replace(', 1)', ', 0.4)'); // Fainter for short MA
    }
    return color; // Solid for long MA
}

// --- WebSocket Connection ---
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
function requestHistoryData() {
    if (socket && socket.readyState === WebSocket.OPEN) {
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

        console.log(`Requesting history for languages: ${selectedLanguages.join(', ')}, window: ${currentTimeWindowMs/60000}m, interval: ${desiredIntervalMs/1000}s`);

        const requestMessage = {
            type: 'requestHistory',
            payload: {
                languages: selectedLanguages,
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

// Helper to create dataset configuration
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

// --- Chart Initialization ---
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

function initializeCharts() {
    console.log("Initializing charts...");

    // Get contexts for all charts
    const contexts: { [key: string]: CanvasRenderingContext2D | null } = {
        sentimentChart: (document.getElementById('sentimentChart') as HTMLCanvasElement)?.getContext('2d'),
        volumeChart: (document.getElementById('volumeChart') as HTMLCanvasElement)?.getContext('2d'),
    };
    emotionKeys.forEach(key => {
        contexts[key] = (document.getElementById(`chart-${key}`) as HTMLCanvasElement)?.getContext('2d');
    });

    // Check if all contexts were found
    const allContextsFound = Object.values(contexts).every(ctx => ctx !== null);
    if (!allContextsFound) {
        console.error('Cannot find all required chart canvas elements. Check IDs in index.html.');
        // Log which ones are missing
        Object.entries(contexts).forEach(([key, ctx]) => {
            if (!ctx) console.error(` - Missing context for chart ID: ${key === 'sentimentChart' || key === 'volumeChart' ? key : `chart-${key}`}`);
        });
        return;
    }

    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false as const, // Use literal false for type compatibility
        scales: {
            x: createTimeAxisOptions()
        },
        plugins: {
            legend: {
                position: 'top' as const,
                labels: { boxWidth: 12, font: { size: 10 } } // Smaller legend items
            },
            tooltip: {
                mode: 'index' as InteractionMode,
                intersect: false,
            },
        },
        interaction: { // Optimize interaction modes
            mode: 'nearest' as InteractionMode,
            axis: 'x' as const,
            intersect: false
        }
    };

    // Destroy existing charts if they exist
    Object.keys(chartInstances).forEach(key => {
        const chartKey = key as keyof typeof chartInstances;
        if (chartInstances[chartKey]) {
            chartInstances[chartKey]?.destroy();
            chartInstances[chartKey] = null;
        }
    });


    // --- Initialize Sentiment Chart --- (Net Score)
    chartInstances.sentimentChart = new Chart(contexts.sentimentChart!, {
        type: 'line',
        data: { datasets: [] }, // Start with empty datasets
        options: {
            ...commonOptions,
            plugins: {
                 ...commonOptions.plugins,
                 title: { display: true, text: 'Avg. Net Score' }
            },
            scales: {
                 x: commonOptions.scales.x,
                y: {
                    title: { display: true, text: 'Avg. Net Score' }
                }
            }
        }
    });

    // --- Initialize Volume Chart --- (Bar)
    chartInstances.volumeChart = new Chart(contexts.volumeChart!, {
        type: 'bar',
        data: { datasets: [] },
        options: {
            ...commonOptions,
             plugins: {
                 ...commonOptions.plugins,
                 title: { display: true, text: 'Post Volume' }
            },
            scales: {
                 x: {
                    ...commonOptions.scales.x, // Inherit time axis options
                    stacked: true // <<< Enable stacking on X axis
                },
                y: {
                    stacked: true, // <<< Enable stacking on Y axis
                    beginAtZero: true,
                    title: { display: true, text: 'Posts per Interval' }
                }
            },
            datasets: {
                bar: {
                     barPercentage: 0.9,
                     categoryPercentage: 0.85
                 }
            }
        }
    });

    // --- Initialize Individual Emotion Charts --- (Line)
    emotionKeys.forEach(key => {
        chartInstances[key] = new Chart(contexts[key]!, {
            type: 'line',
            data: { datasets: [] },
            options: {
                 ...commonOptions,
                 plugins: {
                     ...commonOptions.plugins,
                     title: { display: true, text: key.charAt(0).toUpperCase() + key.slice(1) } // Capitalize title
                 },
                 scales: {
                    x: commonOptions.scales.x,
                    y: {
                        beginAtZero: true,
                        title: { display: true, text: 'Avg. Score' }
                    }
                }
            }
        });
    });

    console.log("All charts initialized with dynamic Y-axes.");
}

// --- Chart Update Logic ---

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

// Process historical data and update charts completely
function handleHistoryData(results: LanguageHistoryData[]) {
    console.log("Processing historyData...");

    // *** ADDED: Log received MA data for debugging ***
    if (results.length > 0 && results[0].data.length > 0) {
        console.log("Sample received history entry[0]:", results[0].data[0]);
        if (results[0].data.length > 1) {
             console.log("Sample received history entry[1]:", results[0].data[1]);
        }
    }

    // Check if charts are initialized
    if (!chartInstances.sentimentChart || !chartInstances.volumeChart) {
        console.error("Primary charts not initialized, cannot handle history data.");
        return;
    }

    // 1. Store new data locally
    currentChartData = {}; // Clear old data first
    results.forEach(result => {
        currentChartData[result.language] = result.data;
    });

    // 2. Identify language changes (works across all charts, assuming they stay in sync)
    const currentLanguages = new Set<string>(
        chartInstances.sentimentChart.data.datasets.map(ds => (ds as any).languageCode).filter(Boolean)
    );
    const selectedSet = new Set<string>(selectedLanguages);
    const languagesToAdd = selectedLanguages.filter(lang => !currentLanguages.has(lang));
    const languagesToRemove = Array.from(currentLanguages).filter(lang => !selectedSet.has(lang));

    // Debug logs for language changes
    // console.log(`Selected: [${selectedLanguages.join(', ')}]`);
    // console.log(`Currently displayed: [${Array.from(currentLanguages).join(', ')}]`);
    // console.log(` -> Adding: [${languagesToAdd.join(', ')}]`);
    // console.log(` -> Removing: [${languagesToRemove.join(', ')}]`);

    // Helper to filter datasets by language
    const filterDatasets = (chart: Chart | null) => {
        if (chart) {
            chart.data.datasets = chart.data.datasets.filter(ds =>
                !languagesToRemove.includes((ds as any).languageCode)
            );
        }
    };

    // 3. Remove datasets for deselected languages from ALL charts
    filterDatasets(chartInstances.sentimentChart);
    filterDatasets(chartInstances.volumeChart);
    emotionKeys.forEach(key => filterDatasets(chartInstances[key]));

    // Helper to calculate normalized score (ONLY for raw scores)
    const normalizeScore = (score: number | null | undefined, count: number): number | null => {
        if (count > 0 && score != null) {
            return score / count;
        }
        return null;
    };

    // 4. Add datasets (Normalize Raw, Plot MA Direct)
    languagesToAdd.forEach(lang => {
        if (!currentChartData[lang]) return; // Skip if no data for this lang
        const langData = currentChartData[lang];
        const langName = lang.toUpperCase();

        // --- Add to Sentiment Chart ---
        if (chartInstances.sentimentChart) {
            // Prepare args for Net Score
            const netScoreData = langData.map(e => ({ x: e.timestamp, y: normalizeScore((e.scores.positive ?? 0) - (e.scores.negative ?? 0), e.postCount) }));
            const netScoreColor = getLanguageColor(lang).replace(', 1)', ', 0.4)');
            const netScoreOptions = { borderWidth: 1 };
            chartInstances.sentimentChart.data.datasets.push(
                createDatasetConfig(lang, `${langName} Net Score`, netScoreData, netScoreColor, netScoreOptions)
            );

            // Prepare args for Net Score Short MA
            const shortMAData = langData.map(e => ({ x: e.timestamp, y: e.shortAvg ? (e.shortAvg.positive ?? 0) - (e.shortAvg.negative ?? 0) : null }));
            const shortMAColor = getLanguageColor(lang).replace(', 1)', ', 0.7)');
            const shortMAOptions = { borderDash: [5, 5], borderWidth: 1.5 };
            chartInstances.sentimentChart.data.datasets.push(
                createDatasetConfig(lang, `${langName} Short MA`, shortMAData, shortMAColor, shortMAOptions)
            );

            // Prepare args for Net Score Long MA
            const longMAData = langData.map(e => ({ x: e.timestamp, y: e.longAvg ? (e.longAvg.positive ?? 0) - (e.longAvg.negative ?? 0) : null }));
            const longMAColor = getLanguageColor(lang);
            const longMAOptions = { borderWidth: 2.5 };
            chartInstances.sentimentChart.data.datasets.push(
                createDatasetConfig(lang, `${langName} Long MA`, longMAData, longMAColor, longMAOptions)
            );
        }

        // --- Add to Volume Chart ---
        if (chartInstances.volumeChart) {
            const volumeData = langData.map(e => ({ x: e.timestamp, y: e.postCount }));
            const volumeColor = getLanguageColor(lang);
            const volumeOptions = { type: 'bar' };
            chartInstances.volumeChart.data.datasets.push(
                createDatasetConfig(lang, `${langName} Volume`, volumeData, volumeColor, volumeOptions)
            );
        }

        // --- Add to Individual Emotion Charts ---
        emotionKeys.forEach(emotion => {
            const chart = chartInstances[emotion];
            if (chart) {
                const baseColor = getLanguageColor(lang);

                // Prepare args for Raw Score
                const scoreData = langData.map(e => ({ x: e.timestamp, y: normalizeScore(e.scores[emotion], e.postCount) }));
                const scoreColor = baseColor.replace(', 1)', ', 0.4)');
                const scoreOptions = { borderWidth: 1 };
                 chart.data.datasets.push(
                     createDatasetConfig(lang, `${langName} Score`, scoreData, scoreColor, scoreOptions)
                 );

                 // Prepare args for Short MA
                 const shortMAData = langData.map(e => ({ x: e.timestamp, y: e.shortAvg ? e.shortAvg[emotion] : null }));
                 const shortMAColor = baseColor.replace(', 1)', ', 0.7)');
                 const shortMAOptions = { borderDash: [5, 5], borderWidth: 1.5 };
                 chart.data.datasets.push(
                     createDatasetConfig(lang, `${langName} Short MA`, shortMAData, shortMAColor, shortMAOptions)
                 );

                 // Prepare args for Long MA
                 const longMAData = langData.map(e => ({ x: e.timestamp, y: e.longAvg ? e.longAvg[emotion] : null }));
                 const longMAColor = baseColor;
                 const longMAOptions = { borderWidth: 2.5 };
                 chart.data.datasets.push(
                     createDatasetConfig(lang, `${langName} Long MA`, longMAData, longMAColor, longMAOptions)
                 );
            }
        });
    });

    // 5. Update data (Normalize Raw, Plot MA Direct)
    const languagesToUpdate = Array.from(currentLanguages).filter(lang => selectedSet.has(lang));
    languagesToUpdate.forEach(lang => {
        if (!currentChartData[lang]) return;
        const langData = currentChartData[lang];

        // Helper function to update datasets
        const updateChartDatasets = (chart: Chart | null, getDataFunc: (entry: HistoryEntry, type: 'score' | 'short' | 'long') => number | null) => {
            if (!chart) return;
            chart.data.datasets.forEach(ds => {
                const dataset = ds as any;
                if (dataset.languageCode === lang) {
                    if (dataset.label.includes('Score')) {
                        // Normalize raw score
                        dataset.data = langData.map(entry => ({ x: entry.timestamp, y: normalizeScore(getDataFunc(entry, 'score'), entry.postCount) }));
                    } else if (dataset.label.includes('Short MA')) {
                         // Plot MA directly
                        dataset.data = langData.map(entry => ({ x: entry.timestamp, y: getDataFunc(entry, 'short') }));
                    } else if (dataset.label.includes('Long MA')) {
                         // Plot MA directly
                        dataset.data = langData.map(entry => ({ x: entry.timestamp, y: getDataFunc(entry, 'long') }));
                    }
                }
            });
        };

        // Update Sentiment Chart (Raw Normalized, MA Direct)
        updateChartDatasets(chartInstances.sentimentChart, (e, type) => {
            const source = type === 'score' ? e.scores : (type === 'short' ? e.shortAvg : e.longAvg);
            return source ? (source.positive ?? 0) - (source.negative ?? 0) : null;
        });

        // Update Volume Chart
        updateChartDatasets(chartInstances.volumeChart, (e, type) => type === 'score' ? e.postCount : null);

        // Update Emotion Charts (Raw Normalized, MA Direct)
        emotionKeys.forEach(emotion => {
            updateChartDatasets(chartInstances[emotion], (e, type) => {
                const source = type === 'score' ? e.scores : (type === 'short' ? e.shortAvg : e.longAvg);
                 return source ? source[emotion] : null;
            });
        });
    });

    // 6. Trigger chart update for all charts
    sortVolumeDatasets(chartInstances.volumeChart); // <<< Sort before updating
    Object.values(chartInstances).forEach(chart => chart?.update());
    console.log("All charts updated with new history data.");
}

// Handle incoming live data points (Normalize Raw, Plot MA Direct)
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

// *** ADDED: Helper function to sort volume datasets for stacking ***
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
function setupControls() {
    const languageSelector = document.getElementById('languageSelector');
    const timeWindowSelect = document.getElementById('timeWindowSelect') as HTMLSelectElement;

    // Populate Language Selector
    if (languageSelector) {
        AVAILABLE_LANGUAGES.forEach(lang => {
            const div = document.createElement('div');
            div.classList.add('language-option');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `lang-${lang.code}`;
            checkbox.value = lang.code;
            checkbox.checked = selectedLanguages.includes(lang.code);
            checkbox.addEventListener('change', (event) => {
                 const target = event.target as HTMLInputElement;
                const langCode = target.value;
                if (target.checked) {
                    if (!selectedLanguages.includes(langCode)) {
                        selectedLanguages.push(langCode);
                    }
                } else {
                    selectedLanguages = selectedLanguages.filter(code => code !== langCode);
                }
                console.log("Selected languages:", selectedLanguages);
                requestHistoryData(); // Request new data when selection changes
            });

            const label = document.createElement('label');
            label.htmlFor = `lang-${lang.code}`;
            label.textContent = lang.name;

            div.appendChild(checkbox);
            div.appendChild(label);
            languageSelector.appendChild(div);
        });
    }

    // Time Window Selector
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
}


// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Content Loaded");
    initializeCharts();
    setupControls();
    connectWebSocket(); // Connect after setting up UI and charts
});