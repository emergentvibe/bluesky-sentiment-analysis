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
    CartesianScaleOptions
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
    LiveUpdateEntry
} from './types.ts';
import { loadingIndicator } from './dom.ts';
import { getMetricValue } from './utils/metrics.ts';

// Register necessary components (Could potentially be moved to main app.ts if needed elsewhere)
// Chart.register(...registerables); // Keep commented out here unless chart.js is ONLY used in this module

// --- Chart Initialization and Utils ---

/**
 * Creates the configuration object for the time (X) axis in Chart.js.
 */
function createTimeAxisOptions(): TimeScaleOptions {
    const timeAxisOptions: TimeScaleOptions = {
        type: 'time',
        adapters: {
            date: {
                locale: moment.locale()
            }
        },
        time: {
            unit: 'minute',
            tooltipFormat: 'YYYY-MM-DD HH:mm',
            displayFormats: {
                minute: 'HH:mm',
                hour: 'MMM D, HH:mm',
                day: 'MMM D'
            }
        },
        title: {
            display: true,
            text: 'Time'
        } as Partial<TitleOptions>,
        ticks: {
            source: 'auto',
            maxRotation: 0,
            autoSkip: true,
            callback: function (this: TimeScale, value: any, index: number, ticks: any[]): string | null {
                const timestamp = typeof value === 'number' ? value : this.getPixelForTick(index);
                const now = Date.now();
                const diffMinutes = (now - timestamp) / MINUTE_MS;
                const diffHours = diffMinutes / 60;
                const diffDays = diffHours / 24;

                if (Math.abs(diffMinutes) < 1) return 'Now';
                if (diffMinutes < 60) return `-${Math.round(diffMinutes)}m`;
                if (diffHours < 24) return `-${Math.round(diffHours)}h`;
                return `-${Math.round(diffDays)}d`;
            }
        } as Partial<TickOptions>
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
            const lineChartConfig: ChartConfiguration<'line', ChartPoint[]> = {
                type: 'line',
                data: { datasets: [] as ChartDataset<'line', ChartPoint[]>[] },
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
             const barChartConfig: ChartConfiguration<'bar', ChartPoint[]> = {
                type: 'bar',
                data: { datasets: [] as ChartDataset<'bar', ChartPoint[]>[] },
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
 */
export function updateDataset(
    chart: Chart<'line' | 'bar', ChartPoint[]> | null,
    label: string,
    data: ChartPoint[],
    color: string,
    isDashed: boolean = false,
    isMA: boolean = false
): void {
    if (!chart || !chart.data) return;

    const existingDatasetIndex = chart.data.datasets.findIndex(ds => ds.label === label);

    const baseDatasetConfig: Partial<ChartDataset<'line' | 'bar', ChartPoint[]>> = {
        label: label,
        data: data,
        borderColor: color,
    };

    let specificConfig: Partial<ChartDataset<'line', ChartPoint[]>> | Partial<ChartDataset<'bar', ChartPoint[]>>;

    if (chart.config.type === 'line') {
        specificConfig = {
            backgroundColor: color + '30',
            borderWidth: isMA ? 1.5 : 2,
            pointRadius: isMA ? 0 : 1,
            pointHoverRadius: isMA ? 0 : 3,
            tension: 0.1,
            borderDash: isDashed ? [5, 5] : undefined,
            fill: !isMA,
        };
    } else if (chart.config.type === 'bar') {
        specificConfig = {
            backgroundColor: color,
            borderWidth: 1,
            barPercentage: 0.9,
            categoryPercentage: 0.85,
        };
    } else {
        console.warn(`updateDataset called on unsupported chart type: ${chart.config.type}`);
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
 * Removes a dataset from a chart by its label.
 */
export function removeDataset(chart: Chart<'line' | 'bar', ChartPoint[]> | null, label: string): void {
    if (!chart || !chart.data) return;
    const datasetIndex = chart.data.datasets.findIndex(ds => ds.label === label);
    if (datasetIndex > -1) {
        chart.data.datasets.splice(datasetIndex, 1);
    }
}

/** Helper function to clear all datasets from charts */
export function clearAllChartData(): void {
    if (chartInstances.sentimentChart?.data) {
        chartInstances.sentimentChart.data.datasets = [];
    }
    if (chartInstances.volumeChart?.data) {
        chartInstances.volumeChart.data.datasets = [];
    }
}

/**
 * Sorts the datasets in the volume chart by total volume.
 */
export function sortVolumeDatasets(chart: Chart<'bar', ChartPoint[]> | null) {
    if (!chart || chart !== chartInstances.volumeChart || !chart.data?.datasets) {
        return;
    }

    const now = Date.now();
    const minTime = now - currentTimeWindowMs;

    const volumeMap = new Map<ChartDataset<'bar', ChartPoint[]>, number>();

    chart.data.datasets.forEach((dataset: ChartDataset<'bar', ChartPoint[]>) => {
        let totalVolume = 0;
        if (Array.isArray(dataset.data)) {
            totalVolume = dataset.data
                .filter(point => point && typeof point === 'object' && point.x >= minTime && point.y !== null)
                .reduce((sum: number, point) => sum + (point.y || 0), 0);
        }
        volumeMap.set(dataset, totalVolume);
    });

    chart.data.datasets.sort((a, b) => (volumeMap.get(b) ?? 0) - (volumeMap.get(a) ?? 0));
}


// --- Data Handlers --- (Moved from websocket.ts or app.ts)

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
    clearAllChartData();
    const plottedLangs = new Set<string>();

    plottedSignals.forEach(config => {
        const signalKey = `${config.metric}_${config.languageCode}`;
        const historyPoints = signalLangData[signalKey];
        plottedLangs.add(config.languageCode);

        if (historyPoints && historyPoints.length > 0) {
            const mainData: ChartPoint[] = [];
            const shortAvgData: ChartPoint[] = [];
            const longAvgData: ChartPoint[] = [];

            historyPoints.forEach(point => {
                const timestamp = point.timestamp;
                const rawScore = getMetricValue(point.scores, config.metric);
                const pointDataY = point.postCount === 0 && rawScore === null ? 0 : rawScore;
                mainData.push({ x: timestamp, y: pointDataY });
                shortAvgData.push({ x: timestamp, y: getMetricValue(point.shortAvg, config.metric) });
                longAvgData.push({ x: timestamp, y: getMetricValue(point.longAvg, config.metric) });
            });

            if (config.showRaw) updateDataset(chartInstances.sentimentChart, `${config.metric} (${config.languageCode}) - Raw`, mainData, config.color);
            if (config.showShortMA) updateDataset(chartInstances.sentimentChart, `${config.metric} (${config.languageCode}) - Short MA`, shortAvgData, config.color, true, true);
            if (config.showLongMA) updateDataset(chartInstances.sentimentChart, `${config.metric} (${config.languageCode}) - Long MA`, longAvgData, config.color, true, true);
        } else {
            removeDataset(chartInstances.sentimentChart, `${config.metric} (${config.languageCode}) - Raw`);
            removeDataset(chartInstances.sentimentChart, `${config.metric} (${config.languageCode}) - Short MA`);
            removeDataset(chartInstances.sentimentChart, `${config.metric} (${config.languageCode}) - Long MA`);
        }
    });

    const uniqueLangs = Array.from(plottedLangs);
    uniqueLangs.forEach(langCode => {
         const volumeData: ChartPoint[] = [];
         const relevantKeys = Object.keys(signalLangData).filter(key => key.endsWith(`_${langCode}`));
         if (relevantKeys.length > 0) {
             const firstKey = relevantKeys[0];
             const numPoints = signalLangData[firstKey]?.length || 0;
             for (let i = 0; i < numPoints; i++) {
                 let totalPostCount = 0;
                 let timestamp = 0;
                 relevantKeys.forEach(key => {
                      const point = signalLangData[key]?.[i];
                      if (point) {
                          totalPostCount += point.postCount;
                          if (timestamp === 0) timestamp = point.timestamp;
                      }
                 });
                 if (timestamp !== 0) volumeData.push({ x: timestamp, y: totalPostCount });
             }
         }
         const firstSignalForLang = plottedSignals.find(p => p.languageCode === langCode);
         const color = firstSignalForLang ? firstSignalForLang.color + '80' : '#CCCCCC';
         if (volumeData.length > 0) updateDataset(chartInstances.volumeChart, `Volume (${langCode})`, volumeData, color);
         else removeDataset(chartInstances.volumeChart, `Volume (${langCode})`);
    });

    const existingVolumeLabels = chartInstances.volumeChart?.data.datasets.map(ds => ds.label).filter(l => l?.startsWith('Volume (')) ?? [];
    existingVolumeLabels.forEach(label => {
        const langCodeMatch = label?.match(/Volume \((.*)\)/);
        const langCode = langCodeMatch ? langCodeMatch[1] : null;
        if (label && langCode && !uniqueLangs.includes(langCode)) removeDataset(chartInstances.volumeChart, label);
    });

    sortVolumeDatasets(chartInstances.volumeChart);
    updateCharts();
}


/**
 * Processes incoming live data points (`liveUpdate` message).
 */
export function handleLiveUpdate(payload: ServerLiveUpdatePayload): void {
    if (!payload || !Array.isArray(payload.updates) || payload.updates.length === 0) return;

    let chartNeedsUpdate = false;
    const chart = chartInstances.sentimentChart;
    const volumeChart = chartInstances.volumeChart;
    if (!chart || !volumeChart) return;

    const bufferTime = Date.now() - (currentTimeWindowMs + (5 * MINUTE_MS));
    const volumeUpdatesByLang = new Map<string, { timestamp: number, totalPostCount: number }>();

    payload.updates.forEach(update => {
        const { signalName, language: langCode, timestamp, postCount } = update;

        const correspondingPlottedSignal = plottedSignals.find(p => p.metric === signalName && p.languageCode === langCode);

        if (correspondingPlottedSignal) {
            const rawLabel = `${signalName} (${langCode}) - Raw`;
            const shortMALabel = `${signalName} (${langCode}) - Short MA`;
            const longMALabel = `${signalName} (${langCode}) - Long MA`;

            let rawDataset = chart.data.datasets.find(ds => ds.label === rawLabel);
            let shortMADataset = chart.data.datasets.find(ds => ds.label === shortMALabel);
            let longMADataset = chart.data.datasets.find(ds => ds.label === longMALabel);

            let rawScoreValue = getMetricValue(update.scores, signalName);
            if (rawScoreValue !== null && postCount > 0) rawScoreValue /= postCount;
            else if (postCount === 0) rawScoreValue = 0;

            const rawPoint: ChartPoint = { x: timestamp, y: rawScoreValue };
            const shortMAPoint: ChartPoint = { x: timestamp, y: getMetricValue(update.shortAvg, signalName) };
            const longMAPoint: ChartPoint = { x: timestamp, y: getMetricValue(update.longAvg, signalName) };

            function pushAndFilter(dataset: ChartDataset<any, any> | undefined, point: ChartPoint) {
                if (!dataset) return;
                const dataArray = dataset.data as ChartPoint[];
                dataArray.push(point);
                dataset.data = dataArray.filter(p => p.x >= bufferTime);
                chartNeedsUpdate = true;
            }

            if (correspondingPlottedSignal.showRaw) pushAndFilter(rawDataset, rawPoint);
            if (correspondingPlottedSignal.showShortMA) pushAndFilter(shortMADataset, shortMAPoint);
            if (correspondingPlottedSignal.showLongMA) pushAndFilter(longMADataset, longMAPoint);
        }

        if (!volumeUpdatesByLang.has(langCode)) volumeUpdatesByLang.set(langCode, { timestamp: timestamp, totalPostCount: 0 });
        volumeUpdatesByLang.get(langCode)!.totalPostCount += postCount;
    });

    volumeUpdatesByLang.forEach((aggregatedVolumeData, langCode) => {
        const volumeLabel = `Volume (${langCode})`;
        const volumeDataset = volumeChart.data.datasets.find(ds => ds.label === volumeLabel);

        if (volumeDataset) {
            const volumePoint: ChartPoint = { x: aggregatedVolumeData.timestamp, y: aggregatedVolumeData.totalPostCount };
            const dataArray = volumeDataset.data as ChartPoint[];
            dataArray.push(volumePoint);
            volumeDataset.data = dataArray.filter(p => p.x >= bufferTime);
            chartNeedsUpdate = true;
        } else {
             console.warn(`[handleLiveUpdate] Volume dataset not found for label: ${volumeLabel}.`);
        }
    });

    if (chartNeedsUpdate) {
        updateCharts();
    }
} 