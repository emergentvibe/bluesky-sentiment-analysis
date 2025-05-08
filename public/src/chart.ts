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
    ChartDataset,
    Point,
    BubbleDataPoint,
    ChartOptions,
    ScaleOptionsByType,
    CoreScaleOptions,
    FontSpec,
    TickOptions,
    TitleOptions,
    TimeScaleOptions,
    CartesianScaleOptions,
    ChartData
} from 'chart.js';
import 'chartjs-adapter-moment'; // Import the adapter
import moment from 'moment'; // Import moment

import { MINUTE_MS } from './config.ts';
import { chartInstances, plottedSignals, currentTimeWindowMs } from './state.ts';
import {
    HistoryEntry,
    SentimentScores,
    ChartPoint,
    ServerHistoryPayload,
    ServerLiveUpdatePayload,
    LiveUpdateEntry,
    LiveLangVolumeUpdateEntry,
    PlottedSignalConfig
} from './types.ts';
import { loadingIndicator } from './dom.ts';

// Register necessary components (Could potentially be moved to main app.ts if needed elsewhere)
// Chart.register(...registerables); // Keep commented out here unless chart.js is ONLY used in this module

// --- Add getMetricValue directly here with logging ---
/**
 * Safely retrieves a numeric metric value from a SentimentScores object.
 * Returns null if the key is not found or the value is not a number.
 */
export function getMetricValue(scores: SentimentScores | null | undefined, key: string | null): number | null {
    // Log entry and parameters
    // console.log(`[getMetricValue] Called with key: ${key}, scores: ${scores ? Object.keys(scores).join(', ') : 'null/undefined'}`);

    if (!scores || typeof scores !== 'object' || key === null) {
        // console.log(`[getMetricValue] Returning null (invalid scores or key)`);
        return null;
    }
    const value = scores[key];
    if (typeof value === 'number' && !isNaN(value)) {
         // console.log(`[getMetricValue] Found numeric value for key '${key}': ${value}`);
        return value;
    }
    // console.log(`[getMetricValue] Returning null (key '${key}' not found or value is not a number: ${value})`);
    return null;
}

// --- Chart Initialization and Utils ---

/**
 * Creates the configuration object for the time (X) axis in Chart.js.
 */
function createTimeAxisOptions(): TimeScaleOptions {
    const timeAxisOptions: TimeScaleOptions = {
        type: 'time',
        adapters: {
            date: {
                // locale: moment.locale() // Might not be needed if Chart.js handles locale implicitly
            }
        },
        time: {
            unit: 'minute',
            tooltipFormat: 'YYYY-MM-DD HH:mm',
            displayFormats: {
                minute: 'HH:mm',
                hour: 'MMM D, HH:mm',
                day: 'MMM D'
            },
            // Add potentially missing properties based on Chart.js types/defaults
            parser: 'auto', // Or specify your timestamp format if needed
            round: false, // or 'minute', 'hour', etc.
            isoWeekday: false, // Added missing property
            minUnit: 'millisecond' // Added missing property
        },
        title: {
            display: true,
            text: 'Time',
            align: 'center',
            // Add potentially missing properties based on Chart.js types/defaults
            color: '#666', // Default or your preferred color
            font: { // FontSpec object
                size: 12
            },
            padding: 10 // Added missing property (default or adjust as needed)
        },
        ticks: {
            // Remove previously added properties, rely on defaults where possible
            // display: true,
            // color: '#666',
            // padding: 3,
            // font: { size: 10 },
            // Specify only necessary customizations
            source: 'auto',
            maxRotation: 0,
            autoSkip: true,
            callback: function (this: Scale<CoreScaleOptions>, value: number | string, index: number, ticks: any[]): string | null {
                // Attempt to get timestamp; value might be label (string) or numeric value
                let timestamp: number | null = null;
                if (typeof value === 'number') {
                    timestamp = value;
                } else if (typeof value === 'string' && this.chart?.data?.labels?.[index]) {
                    // If value is a string label, try parsing it via moment if needed, or get from scale
                    // Here, we assume the scale provides the numeric value correctly via getPixelForTick
                    // If labels are used directly, parsing logic might be needed here.
                    // For a time scale, the value passed to the callback is usually the numeric timestamp.
                    // Let's rely on getPixelForTick if value isn't numeric, though it might be less direct.
                    // A safer approach might be to access the actual tick object if available.
                    timestamp = this.getPixelForValue(ticks[index]?.value);
                }

                if (timestamp === null) return String(value); // Fallback if timestamp cannot be determined

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
    return timeAxisOptions;
}

/**
 * Initializes the main sentiment chart and the volume chart instances.
 */
export function initializeCharts() {
    console.log("Initializing simplified charts...");

    const mainCtx = (document.getElementById('mainChart') as HTMLCanvasElement)?.getContext('2d');
    const volumeCtx = (document.getElementById('volumeChart') as HTMLCanvasElement)?.getContext('2d');

    if (!mainCtx) console.error('Failed to get 2D context for mainChart');
    if (!volumeCtx) console.error('Failed to get 2D context for volumeChart');

    chartInstances.sentimentChart?.destroy();
    chartInstances.volumeChart?.destroy();
    chartInstances.sentimentChart = null;
    chartInstances.volumeChart = null;

    const commonOptions: ChartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
            legend: { position: 'top', labels: { boxWidth: 12, font: { size: 10 } } },
            tooltip: { mode: 'index', intersect: false },
        },
        interaction: { mode: 'nearest', axis: 'x', intersect: false }
    };

    // --- Initialize Main Chart (Line) ---
    if (mainCtx) {
        try {
            // Use ChartData type for data property
            const lineChartConfig: ChartConfiguration<'line', ChartPoint[]> = {
                type: 'line',
                data: { datasets: [] as ChartDataset<'line', ChartPoint[]>[] }, // Explicitly type datasets array
                options: {
                    ...commonOptions,
                    scales: {
                        x: createTimeAxisOptions(),
                        y: { type: 'linear', title: { display: true, text: 'Score / Avg. Score' } }
                    },
                    plugins: {
                        ...commonOptions.plugins,
                        title: { display: true, text: 'Sentiment Trends' }
                    }
                }
            };
            // Type the chart instance more generally, Chart.js handles specifics
            chartInstances.sentimentChart = new Chart(mainCtx, lineChartConfig);
            console.log("Main chart instance created.");
        } catch (error) {
            console.error("Error creating main chart:", error);
            chartInstances.sentimentChart = null;
        }
    } else {
        console.error("Cannot initialize main chart - context not available.");
    }

    // --- Initialize Volume Chart (Bar) ---
    if (volumeCtx) {
         try {
             // Use ChartData type for data property
             const barChartConfig: ChartConfiguration<'bar', ChartPoint[]> = {
                type: 'bar',
                data: { datasets: [] as ChartDataset<'bar', ChartPoint[]>[] }, // Explicitly type datasets array
                options: {
                    ...commonOptions,
                     scales: {
                        x: { ...createTimeAxisOptions(), stacked: true },
                        y: { type: 'linear', stacked: true, beginAtZero: true, title: { display: true, text: 'Posts per Interval' } }
                    },
                     plugins: {
                        ...commonOptions.plugins,
                        title: { display: true, text: 'Post Volume' }
                    },
                }
            };
             // Type the chart instance more generally
            chartInstances.volumeChart = new Chart(volumeCtx, barChartConfig);
            console.log("Volume chart instance created.");
         } catch (error) {
             console.error("Error creating volume chart:", error);
             chartInstances.volumeChart = null;
         }
    } else {
         console.error("Cannot initialize volume chart - context not available.");
    }
}


// --- Chart Update Logic ---

/**
 * Updates all active chart instances.
 */
export function updateCharts() {
    const now = Date.now();
    const minTime = now - currentTimeWindowMs;

    Object.values(chartInstances).forEach(chart => {
        if (chart?.options?.scales?.x) {
             const timeScale = chart.options.scales.x as TimeScaleOptions;
             timeScale.min = minTime;
             timeScale.max = now;
             chart.update('none');
        }
    });
}

/**
 * Adds or updates a dataset in a given chart instance.
 * - isMA: Indicates if this is a Moving Average dataset (controls dashing, fill, point size)
 */
export function updateDataset(
    chart: Chart | null, // Use the base Chart type
    label: string,
    data: ChartPoint[],
    color: string,
    isMA: boolean = false
): void {
    if (!chart || !chart.data) return;

    const existingDatasetIndex = chart.data.datasets.findIndex(ds => ds.label === label);
    const isRaw = !isMA;
    const isShortMA = isMA && label.includes('Short MA');
    const isLongMA = isMA && label.includes('Long MA');

    const baseDatasetConfig: Partial<ChartDataset<'line' | 'bar', ChartPoint[]>> = {
        label: label,
        data: data,
        borderColor: color,
    };

    let specificConfig: Partial<ChartDataset<'line', ChartPoint[]>> | Partial<ChartDataset<'bar', ChartPoint[]>>;

    if (chart === chartInstances.sentimentChart) {
        specificConfig = {
            backgroundColor: 'transparent',
            borderWidth: isRaw ? 1.5 : (isShortMA ? 2 : (isLongMA ? 2.5 : 2)),
            pointRadius: isRaw ? 1 : 0,
            pointHoverRadius: isRaw ? 3 : 0,
            tension: 0.1,
            borderDash: isRaw ? [5, 5] : undefined,
            fill: false,
        };
    } else if (chart === chartInstances.volumeChart) {
        specificConfig = {
            backgroundColor: color,
            borderWidth: 1,
            barPercentage: 0.9,
            categoryPercentage: 0.85,
        };
    } else {
        console.warn(`updateDataset called on unknown chart instance`);
        return;
    }

    const finalDatasetConfig = { ...baseDatasetConfig, ...specificConfig };

    if (existingDatasetIndex > -1) {
        Object.assign(chart.data.datasets[existingDatasetIndex], finalDatasetConfig);
    } else {
        chart.data.datasets.push(finalDatasetConfig as ChartDataset<'line' | 'bar', ChartPoint[]>);
    }
}

/**
 * Removes a dataset from a given chart instance based on its label.
 */
export function removeDataset(chart: Chart | null, label: string): void { // Use base Chart type
    if (!chart || !chart.data) return;
    const datasetIndex = chart.data.datasets.findIndex(ds => ds.label === label);
    if (datasetIndex > -1) {
        chart.data.datasets.splice(datasetIndex, 1);
    }
}

/** Clears all data from both sentiment and volume charts. */
export function clearAllChartData(): void {
    console.log("[clearAllChartData] Clearing all chart data.");
    // Iterate using Object.entries. Explicit cast removed as type should now match.
    Object.entries(plottedSignals).forEach(([signalId, config]) => {
        console.log(`[clearAllChartData] Clearing data for signal: ${config.label} (ID: ${signalId})`);
        removeDataset(chartInstances.sentimentChart, config.label);
        removeDataset(chartInstances.sentimentChart, `${config.label} Short MA`);
        removeDataset(chartInstances.sentimentChart, `${config.label} Long MA`);
        // Also remove language-specific volume datasets
        Object.keys(config.langData || {}).forEach(lang => {
            removeDataset(chartInstances.volumeChart, `${config.label} (${lang})`);
        });
    });
    // Ensure datasets arrays are truly empty after removals
    if (chartInstances.sentimentChart?.data) chartInstances.sentimentChart.data.datasets = [];
    if (chartInstances.volumeChart?.data) chartInstances.volumeChart.data.datasets = [];

    updateCharts(); // Update to reflect cleared state
}

/**
 * Sorts the datasets in the volume chart alphabetically by language within each signal.
 */
export function sortVolumeDatasets(chart: Chart<'bar', ChartPoint[]> | null) {
    if (!chart || !chart.data?.datasets) return;

    // Example label format: "Signal Name (en)"
    chart.data.datasets.sort((a, b) => {
        const labelA = a.label || '';
        const labelB = b.label || '';

        // Extract signal name and language
        const matchA = labelA.match(/^(.*?)\s*\(([^)]+)\)$/);
        const matchB = labelB.match(/^(.*?)\s*\(([^)]+)\)$/);

        const signalA = matchA ? matchA[1].trim() : labelA;
        const langA = matchA ? matchA[2] : '';
        const signalB = matchB ? matchB[1].trim() : labelB;
        const langB = matchB ? matchB[2] : '';

        // Primary sort by signal name
        if (signalA < signalB) return -1;
        if (signalA > signalB) return 1;

        // Secondary sort by language
        if (langA < langB) return -1;
        if (langA > langB) return 1;

        return 0;
    });

    chart.update('none');
}


// --- Data Handlers ---

/**
 * Handles the initial batch of historical data received from the server.
 */
export function handleHistoryData(payload: ServerHistoryPayload): void {
    console.log('Processing history data...');
    if (loadingIndicator) loadingIndicator.style.display = 'none';

    if (!payload || !payload.signalLangData) {
        console.warn('Received empty or invalid history data payload.');
        clearAllChartData();
        updateCharts();
        return;
    }

    const { signalLangData } = payload;
    // Log received keys
    console.log(`[handleHistoryData] Received signalLangData keys: ${Object.keys(signalLangData).join(', ')}`);

    clearAllChartData();
    const plottedLangs = new Set<string>();

    plottedSignals.forEach(config => {
        const signalKey = `${config.signalName}_${config.languageCode}`;
        const historyPoints = signalLangData[signalKey];
        plottedLangs.add(config.languageCode); // Add lang regardless of data presence for volume calc later

        console.log(`[handleHistoryData] Processing signal: ${signalKey}, Type: ${config.type}`);

        // --- Determine Metric Key ---
        let metricKeyForValue: string | null = config.signalName; // Default
        if (config.type === 'filter' && historyPoints && historyPoints.length > 0) {
            // Try to find the key from the first valid 'scores' object
            let foundKey = false;
            for (const point of historyPoints) {
                if (point.scores && typeof point.scores === 'object' && Object.keys(point.scores).length > 0) {
                    const scoreKeys = Object.keys(point.scores);
                    if (scoreKeys.length === 1) {
                        metricKeyForValue = scoreKeys[0];
                        console.log(`[handleHistoryData] Filter signal '${config.signalName}': Using single score key '${metricKeyForValue}' from historical data.`);
                        foundKey = true;
                        break; // Found the key
                    } else if (scoreKeys.length > 1) {
                        // If multiple keys, maybe one matches the signal name convention (e.g., filter name uses base metric)
                        // This is heuristic - might need refinement based on actual backend behavior
                        const baseMetricGuess = scoreKeys.find(k => config.signalName.toLowerCase().includes(k.toLowerCase()));
                        if (baseMetricGuess) {
                             metricKeyForValue = baseMetricGuess;
                             console.warn(`[handleHistoryData] Filter signal '${config.signalName}': Multiple score keys (${scoreKeys.join(', ')}). Guessed base metric: '${metricKeyForValue}'.`);
                             foundKey = true;
                             break;
                        } else {
                            console.warn(`[handleHistoryData] Filter signal '${config.signalName}': Multiple score keys (${scoreKeys.join(', ')}), but couldn't guess base metric. Defaulting to signal name '${metricKeyForValue}'. Data might be incorrect.`);
                            // Keep default metricKeyForValue = config.signalName
                            foundKey = true; // Treat as found to avoid falling through
                            break;
                        }
                    }
                }
            }
            if (!foundKey) {
                 console.warn(`[handleHistoryData] Filter signal '${config.signalName}': Could not find any scores object in history to determine the metric key. Defaulting to signal name '${metricKeyForValue}'.`);
            }
        } else if (config.type !== 'filter') {
             console.log(`[handleHistoryData] Regular signal '${config.signalName}': Using signal name as metric key.`);
             metricKeyForValue = config.signalName;
        } else {
            // Filter signal but no history points
             console.log(`[handleHistoryData] Filter signal '${config.signalName}': No history points found. Cannot determine specific metric key yet.`);
             // Keep default metricKeyForValue = config.signalName, it might be set by live updates later if needed
        }
        console.log(`[handleHistoryData] Final metric key for ${signalKey}: ${metricKeyForValue}`);
        // --- End Determine Metric Key ---


        if (historyPoints && historyPoints.length > 0) {
            const mainData: ChartPoint[] = [];
            const shortAvgData: ChartPoint[] = [];
            const longAvgData: ChartPoint[] = [];

            historyPoints.forEach(point => {
                const timestamp = point.timestamp;
                // Use the determined metricKeyForValue
                const rawScore = getMetricValue(point.scores, metricKeyForValue);
                const pointDataY = point.postCount === 0 && rawScore === null ? 0 : rawScore; // Keep zero-filling for missing data if postCount is also 0
                mainData.push({ x: timestamp, y: pointDataY });
                // MAs should also use the determined key
                shortAvgData.push({ x: timestamp, y: getMetricValue(point.shortAvg, metricKeyForValue) });
                longAvgData.push({ x: timestamp, y: getMetricValue(point.longAvg, metricKeyForValue) });
            });

            const baseLabel = `${config.signalName} (${config.languageCode})`;

            // Original logging for raw data presence
            console.log(`[handleHistoryData] Updating raw dataset: ${baseLabel} - Raw`);
            if (mainData.length > 0) {
                 const firstValid = mainData.find(p => p.y !== null);
                 const lastValid = [...mainData].reverse().find(p => p.y !== null);
                 console.log(`[handleHistoryData] Raw data points: ${mainData.length}. First valid: x=${firstValid?.x}, y=${firstValid?.y}. Last valid: x=${lastValid?.x}, y=${lastValid?.y}`);
                 // console.log(`[handleHistoryData] Sample raw data point: x=${mainData[0].x}, y=${mainData[0].y}`);
                 // if (mainData.length > 1) {
                 //     console.log(`[handleHistoryData] Last raw data point: x=${mainData[mainData.length - 1].x}, y=${mainData[mainData.length - 1].y}`);
                 // }
            } else {
                 console.log(`[handleHistoryData] No data points for raw dataset: ${baseLabel} - Raw`);
            }
            console.log(`[handleHistoryData] ShowRaw flag: ${config.showRaw}`);


            if (config.showRaw) updateDataset(chartInstances.sentimentChart, `${baseLabel} - Raw`, mainData, config.color, false);
            if (config.showShortMA) updateDataset(chartInstances.sentimentChart, `${baseLabel} - Short MA`, shortAvgData, config.color, true);
            if (config.showLongMA) updateDataset(chartInstances.sentimentChart, `${baseLabel} - Long MA`, longAvgData, config.color, true);
        } else {
            console.log(`[handleHistoryData] No history points found for ${signalKey}. Removing datasets.`);
            const baseLabel = `${config.signalName} (${config.languageCode})`;
            removeDataset(chartInstances.sentimentChart, `${baseLabel} - Raw`);
            removeDataset(chartInstances.sentimentChart, `${baseLabel} - Short MA`);
            removeDataset(chartInstances.sentimentChart, `${baseLabel} - Long MA`);
        }
    });

    // --- Volume Calculation ---
    const uniqueLangs = Array.from(plottedLangs);
    console.log(`[handleHistoryData] Calculating volume for plotted languages: ${uniqueLangs.join(', ')}`);

    uniqueLangs.forEach(langCode => {
         console.log(`[handleHistoryData] Processing volume for language: ${langCode}`);
         const volumeData: ChartPoint[] = [];
         // Find ALL keys from the *original* payload that end with this language code
         const relevantServerKeys = Object.keys(signalLangData).filter(key => key.endsWith(`_${langCode}`));
         console.log(`[handleHistoryData] Relevant keys from server for ${langCode} volume: ${relevantServerKeys.join(', ')}`);

         if (relevantServerKeys.length > 0) {
             const firstKey = relevantServerKeys[0];
             const numPoints = signalLangData[firstKey]?.length || 0;
             console.log(`[handleHistoryData] ${langCode}: Found ${numPoints} time points based on key ${firstKey}`);

             for (let i = 0; i < numPoints; i++) {
                 let totalPostCount = 0;
                 let timestamp = 0;
                 // Sum post counts across ALL relevant server keys for this timestamp index
                 relevantServerKeys.forEach(key => {
                      const point = signalLangData[key]?.[i];
                      if (point) {
                          totalPostCount += point.postCount;
                          if (timestamp === 0) timestamp = point.timestamp; // Assume timestamps align
                      }
                 });
                 if (timestamp !== 0) {
                     volumeData.push({ x: timestamp, y: totalPostCount });
                 } else {
                     // This shouldn't happen if numPoints > 0 and data exists
                     console.warn(`[handleHistoryData] ${langCode}: Timestamp was 0 at index ${i}, skipping point.`);
                 }
             }
         } else {
             console.log(`[handleHistoryData] ${langCode}: No relevant server keys found for volume calculation.`);
         }

         const firstSignalForLang = plottedSignals.find(p => p.languageCode === langCode);
         const color = firstSignalForLang ? firstSignalForLang.color + '80' : '#CCCCCC'; // Use color from the *first* signal added for that lang
         const volumeLabel = `Volume (${langCode})`;
         console.log(`[handleHistoryData] Updating/Adding volume dataset: ${volumeLabel} with ${volumeData.length} points.`);
         updateDataset(chartInstances.volumeChart, volumeLabel, volumeData, color);
    });

    // Remove volume datasets for languages that are no longer in plottedLangs
    const existingVolumeLabels = chartInstances.volumeChart?.data.datasets.map(ds => ds.label).filter(l => l?.startsWith('Volume (')) ?? [];
    console.log(`[handleHistoryData] Existing volume labels: ${existingVolumeLabels.join(', ')}`);
    existingVolumeLabels.forEach(label => {
        const langCodeMatch = label?.match(/Volume \((.*)\)/);
        const langCode = langCodeMatch ? langCodeMatch[1] : null;
        if (label && langCode && !uniqueLangs.includes(langCode)) {
            console.log(`[handleHistoryData] Removing volume dataset for unplotted language: ${label}`);
            removeDataset(chartInstances.volumeChart, label);
        }
    });
    // --- End Volume Calculation ---

    sortVolumeDatasets(chartInstances.volumeChart);
    updateCharts();
    console.log('[handleHistoryData] Finished processing.');
}


/**
 * Processes incoming live data points (`liveUpdate` message).
 */
export function handleLiveUpdate(payload: ServerLiveUpdatePayload): void {
    if (!payload || (!Array.isArray(payload.updates) && !Array.isArray(payload.langVolumes))) {
        // console.warn("Received live update with no updates or langVolumes."); // Reduce noise
        return;
    }

    let chartNeedsUpdate = false;
    const chart = chartInstances.sentimentChart;
    const volumeChart = chartInstances.volumeChart;
    if (!chart || !volumeChart) return;

    const bufferTime = Date.now() - (currentTimeWindowMs + (5 * MINUTE_MS));

    // --- Process Per-Signal Updates (Sentiment/MA) ---
    if (payload.updates && payload.updates.length > 0) {
        payload.updates.forEach(update => {
            const { signalName, language: langCode, timestamp, postCount } = update;
            const correspondingPlottedSignal = plottedSignals.find(p => p.signalName === signalName && p.languageCode === langCode);

            if (correspondingPlottedSignal) {
                // --- Determine Metric Key for Live Update ---
                let metricKeyForValue: string | null = signalName; // Default
                if (correspondingPlottedSignal.type === 'filter' && update.scores) {
                     const scoreKeys = Object.keys(update.scores);
                     if (scoreKeys.length === 1) {
                         metricKeyForValue = scoreKeys[0];
                         // console.log(`[handleLiveUpdate] Filter signal '${signalName}': Using single score key '${metricKeyForValue}'`);
                     } else if (scoreKeys.length > 1) {
                         const baseMetricGuess = scoreKeys.find(k => signalName.toLowerCase().includes(k.toLowerCase()));
                         if (baseMetricGuess) {
                              metricKeyForValue = baseMetricGuess;
                              // console.warn(`[handleLiveUpdate] Filter signal '${signalName}': Multiple score keys (${scoreKeys.join(', ')}). Guessed base metric: '${metricKeyForValue}'.`);
                         } else {
                             // console.warn(`[handleLiveUpdate] Filter signal '${signalName}': Multiple score keys (${scoreKeys.join(', ')}), cannot guess base metric. Defaulting to signal name '${metricKeyForValue}'.`);
                             metricKeyForValue = signalName; // Fallback
                         }
                     } else {
                         // console.warn(`[handleLiveUpdate] Filter signal '${signalName}': Scores object is empty. Defaulting to signal name '${metricKeyForValue}'.`);
                         metricKeyForValue = signalName; // Fallback
                     }
                } else if (correspondingPlottedSignal.type !== 'filter') {
                    // console.log(`[handleLiveUpdate] Regular signal '${signalName}': Using signal name as metric key.`);
                    metricKeyForValue = signalName;
                } else {
                    // Filter signal but no scores in this update? Unlikely but handle.
                    // console.warn(`[handleLiveUpdate] Filter signal '${signalName}': No scores object in this update. Defaulting to signal name '${metricKeyForValue}'.`);
                    metricKeyForValue = signalName; // Fallback
                }
                // console.log(`[handleLiveUpdate] Final metric key for ${signalName} (${langCode}): ${metricKeyForValue}`);
                // --- End Determine Metric Key ---


                const baseLabel = `${signalName} (${langCode})`;
                const rawLabel = `${baseLabel} - Raw`;
                const shortMALabel = `${baseLabel} - Short MA`;
                const longMALabel = `${baseLabel} - Long MA`;
                let rawDataset = chart.data.datasets.find(ds => ds.label === rawLabel);
                let shortMADataset = chart.data.datasets.find(ds => ds.label === shortMALabel);
                let longMADataset = chart.data.datasets.find(ds => ds.label === longMALabel);

                // Use determined key
                let rawScoreValue = getMetricValue(update.scores, metricKeyForValue);
                if (rawScoreValue === null && postCount === 0) rawScoreValue = 0; // Keep zero-filling
                const rawPoint: ChartPoint = { x: timestamp, y: rawScoreValue };
                // MAs should also use the determined key
                const shortMAPoint: ChartPoint = { x: timestamp, y: getMetricValue(update.shortAvg, metricKeyForValue) };
                const longMAPoint: ChartPoint = { x: timestamp, y: getMetricValue(update.longAvg, metricKeyForValue) };

                function pushAndFilter(dataset: ChartDataset<any, any> | undefined, point: ChartPoint) {
                    if (!dataset || !dataset.data) return; // Add null check for dataset.data
                    const dataArray = dataset.data as ChartPoint[];
                    // Avoid pushing duplicates if timestamp is identical (can happen with rapid updates)
                    if (dataArray.length > 0 && dataArray[dataArray.length - 1].x === point.x) {
                        // Optional: Update last point instead? Or just skip? Skipping for now.
                        // console.log(`[pushAndFilter] Skipping duplicate timestamp ${point.x} for ${dataset.label}`);
                        return;
                    }
                    dataArray.push(point);
                    // Filter points older than the buffer time
                    dataset.data = dataArray.filter(p => typeof p === 'object' && p !== null && typeof p.x === 'number' && p.x >= bufferTime);
                    chartNeedsUpdate = true;
                }

                // Ensure dataset exists before trying to push/filter
                if (correspondingPlottedSignal.showRaw) {
                     if (!rawDataset) { // Dataset might not exist if history failed or showRaw was toggled
                         updateDataset(chart, rawLabel, [rawPoint], correspondingPlottedSignal.color, false);
                         rawDataset = chart.data.datasets.find(ds => ds.label === rawLabel); // Re-find dataset
                     } else {
                         pushAndFilter(rawDataset, rawPoint);
                     }
                }
                if (correspondingPlottedSignal.showShortMA) {
                    if (!shortMADataset) {
                        updateDataset(chart, shortMALabel, [shortMAPoint], correspondingPlottedSignal.color, true);
                        shortMADataset = chart.data.datasets.find(ds => ds.label === shortMALabel);
                    } else {
                        pushAndFilter(shortMADataset, shortMAPoint);
                    }
                }
                if (correspondingPlottedSignal.showLongMA) {
                     if (!longMADataset) {
                         updateDataset(chart, longMALabel, [longMAPoint], correspondingPlottedSignal.color, true);
                         longMADataset = chart.data.datasets.find(ds => ds.label === longMALabel);
                     } else {
                         pushAndFilter(longMADataset, longMAPoint);
                     }
                }
            }
        });
    }

    // --- Process Language Volume Updates ---
    if (payload.langVolumes && payload.langVolumes.length > 0) {
        function pushAndFilterVolume(dataset: ChartDataset<'bar', ChartPoint[]> | undefined, point: ChartPoint) {
             if (!dataset || !dataset.data) return;
             const dataArray = dataset.data as ChartPoint[];
             if (dataArray.length > 0 && dataArray[dataArray.length - 1].x === point.x) {
                 // Update the last point's value instead of adding duplicate timestamp
                 dataArray[dataArray.length - 1].y = (dataArray[dataArray.length - 1].y ?? 0) + (point.y ?? 0);
                 // console.log(`[pushAndFilterVolume] Updating volume for existing timestamp ${point.x} for ${dataset.label}`);
             } else {
                dataArray.push(point);
                // console.log(`[pushAndFilterVolume] Pushing new volume point for ${dataset.label}: x=${point.x}, y=${point.y}`);
             }
             dataset.data = dataArray.filter(p => typeof p === 'object' && p !== null && typeof p.x === 'number' && p.x >= bufferTime);
             chartNeedsUpdate = true;
        }
        payload.langVolumes.forEach(volumeUpdate => {
            const { language: langCode, timestamp, totalPostCount } = volumeUpdate;
            const volumeLabel = `Volume (${langCode})`;
            let dataset = volumeChart.data.datasets.find(ds => ds.label === volumeLabel) as ChartDataset<'bar', ChartPoint[]> | undefined;
            const point: ChartPoint = { x: timestamp, y: totalPostCount };

            // Only update volume if the language is currently plotted
            const isLangPlotted = plottedSignals.some(p => p.languageCode === langCode);
            // console.log(`[handleLiveUpdate] Volume update for ${langCode}. Is plotted: ${isLangPlotted}`);

            if (isLangPlotted) {
                 if (dataset) {
                     pushAndFilterVolume(dataset, point);
                 } else {
                     // Dataset might not exist if history failed or language was just added
                     const firstSignalForLang = plottedSignals.find(p => p.languageCode === langCode);
                     const color = firstSignalForLang ? firstSignalForLang.color + '80' : '#CCCCCC';
                     console.log(`[handleLiveUpdate] Creating volume dataset ${volumeLabel} via live update.`);
                     updateDataset(volumeChart, volumeLabel, [point], color);
                     chartNeedsUpdate = true;
                 }
            } else {
                // If language is not plotted, ensure its volume dataset is removed (belt and suspenders)
                 if (dataset) {
                     console.log(`[handleLiveUpdate] Removing volume dataset ${volumeLabel} because language ${langCode} is no longer plotted.`);
                     removeDataset(volumeChart, volumeLabel);
                     chartNeedsUpdate = true;
                 }
            }
        });
    }

    if (chartNeedsUpdate) {
        sortVolumeDatasets(volumeChart);
        updateCharts();
        // console.log('[handleLiveUpdate] Finished processing, charts updated.'); // Reduce noise
    }
} 