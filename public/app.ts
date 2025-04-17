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

// --- Types (matching backend) ---
// Rename to SentimentScores and add positive/negative
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

type Emotion = keyof Omit<SentimentScores, 'positive' | 'negative'>; // Exclude pos/neg for individual charts
type SentimentCategory = keyof SentimentScores; // Include pos/neg

interface AggregatedScoreEntry {
    timestamp: number; // Use number consistently now
    scores: SentimentScores;
    postCount: number;
}

// --- Constants ---
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_HOURS = 24; // Changed default to 1 day (24 hours)
// Define aggregation interval (must match backend - now 10000ms)
const AGGREGATION_INTERVAL_MS = 10 * 1000;

// Moving Average Windows
const MINUTE_MS = 60 * 1000;
const SHORT_AVG_WINDOW_MS = 5 * MINUTE_MS; // Changed to 5 minutes
const SHORT_AVG_POINTS = SHORT_AVG_WINDOW_MS / AGGREGATION_INTERVAL_MS; // = 30 points
const LONG_AVG_WINDOW_MS = HOUR_MS; // 1 hour
const LONG_AVG_POINTS = LONG_AVG_WINDOW_MS / AGGREGATION_INTERVAL_MS; // = 360 points

let currentTimeWindowMs = DEFAULT_WINDOW_HOURS * HOUR_MS; // Default to 1 day
let currentChartData: AggregatedScoreEntry[] = []; // Store latest data for redraws

// --- WebSocket Connection ---
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${window.location.host}`;
let socket: WebSocket | null = null;

function connectWebSocket() {
    console.log('Connecting to WebSocket server...', wsUrl);
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log('WebSocket connection established.');
    };

    socket.onmessage = (event) => {
        try {
            const data: AggregatedScoreEntry[] = JSON.parse(event.data);

            if (!Array.isArray(data)) {
                console.error('Received non-array data from WebSocket:', data);
                return;
            }

            if (data.length === 0) {
                // Ignore empty updates
                return;
            }

            // Check if it's the initial historical data load or a single update
            if (data.length > 1 || currentChartData.length === 0) {
                // Initial load or full refresh: Replace existing data
                console.log(`Received ${data.length} initial/historical data points.`);
                currentChartData = data;
            } else {
                // Single update: Append the new data point
                const newEntry = data[0];
                console.log(`Received single update: ${new Date(newEntry.timestamp).toISOString()}`);
                currentChartData.push(newEntry);

                // Optional: Prune very old data from the *frontend* array to prevent unbounded growth
                // (This complements backend DB pruning)
                const cutoffTime = Date.now() - (DEFAULT_WINDOW_HOURS + 1) * HOUR_MS; // Keep slightly more than max view window
                const firstValidIndex = currentChartData.findIndex(entry => entry.timestamp >= cutoffTime);
                if (firstValidIndex > 0) {
                    currentChartData.splice(0, firstValidIndex);
                }
            }

            updateCharts(currentChartData);

        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    };

    socket.onclose = (event) => {
        console.log('WebSocket connection closed. Attempting to reconnect...', event.reason);
        setTimeout(connectWebSocket, 5000);
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        socket?.close();
    };
}

// --- Chart Initialization and Update ---

// Helper function to calculate moving average
function calculateMovingAverage(data: (number | null)[], windowSize: number): (number | null)[] {
    if (!data || data.length === 0 || windowSize <= 0) {
        return [];
    }

    const result: (number | null)[] = [];
    const rollingWindow: number[] = []; // Store only valid numbers
    let rollingSum = 0;

    for (let i = 0; i < data.length; i++) {
        const currentValue = data[i];

        // Add valid current value to window and sum
        if (typeof currentValue === 'number' && isFinite(currentValue)) {
            rollingWindow.push(currentValue);
            rollingSum += currentValue;
        }

        // Remove value outside the window from the left
        if (i >= windowSize) {
            const valueToRemoveIndex = i - windowSize;
            const valueToRemove = data[valueToRemoveIndex];
            // Check if the value we *should* remove was actually added (i.e., was a valid number)
            // This requires finding if the *oldest* number currently in rollingWindow corresponds to valueToRemove
            // A simpler, slightly less precise approach for large windows is to just remove the oldest from rollingWindow if size exceeds windowSize
            if (rollingWindow.length > windowSize) {
                rollingSum -= rollingWindow.shift()!;
            }
        }

        // Calculate and store the average if the window has values
        if (rollingWindow.length > 0) {
            result.push(rollingSum / rollingWindow.length);
        } else {
            result.push(null); // No valid data points in the window yet
        }
    }

    return result;
}

const emotions: Emotion[] = ['anger', 'anticipation', 'disgust', 'fear', 'joy', 'sadness', 'surprise', 'trust'];
const chartInstances: { [key in Emotion | 'posneg']?: Chart } = {};

// Define colors for each emotion chart (adjust as needed)
const emotionColors: { [key in Emotion]: string } = {
    anger: 'rgba(255, 99, 132, 0.8)',    // Red
    anticipation: 'rgba(255, 159, 64, 0.8)',  // Orange
    disgust: 'rgba(153, 102, 255, 0.8)', // Purple
    fear: 'rgba(75, 192, 192, 0.8)',   // Teal
    joy: 'rgba(255, 205, 86, 0.8)',    // Yellow
    sadness: 'rgba(54, 162, 235, 0.8)',  // Blue
    surprise: 'rgba(201, 203, 207, 0.8)',// Grey
    trust: 'rgba(75, 181, 67, 0.8)',    // Green
};

// Define color for the net sentiment line
const netSentimentColor = 'rgba(54, 162, 235, 0.8)'; // Blue (reusing sadness blue)

// Helper function to create shared time axis options
function createTimeAxisOptions() {
    // Use 'as any' here to bypass the type conflict between chart.js and adapter types for now
    return {
        type: 'time', // Keep 'time' as it works functionally with the adapter
        time: {
            unit: 'minute',
            stepSize: 30,
            tooltipFormat: 'YYYY-MM-DD HH:mm:ss',
            displayFormats: {
                hour: 'HH:mm',
                minute: 'HH:mm'
            }
        },
        title: {
            display: true,
            text: 'Time (Relative)'
        },
        ticks: {
            callback: function(value: string | number, index: number, ticks: any[]) {
                const now = moment();
                const tickTime = moment(value);
                const diffMinutes = now.diff(tickTime, 'minutes');
                if (Math.abs(diffMinutes) < 2) return 'Now';
                return tickTime.fromNow();
            },
            maxRotation: 0,
            autoSkipPadding: 15
        }
        // min/max are set dynamically
    } as any; // Add type assertion here
}

function initializeCharts() {
    // Initialize the 8 emotion charts
    emotions.forEach(emotion => {
        const canvas = document.getElementById(`chart-${emotion}`) as HTMLCanvasElement | null;
        if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) {
                const config: ChartConfiguration = { // Use ChartConfiguration type
                    type: 'line',
                    data: {
                        labels: [], // Initialize with empty labels
                        datasets: [
                            {
                                label: '5-min Avg',
                                data: [],
                                // Apply dashed/fainter style to 5-min avg
                                borderColor: emotionColors[emotion].replace('0.8', '0.3'),
                                backgroundColor: 'transparent',
                                borderWidth: 1.5,
                                borderDash: [5, 5],
                                pointRadius: 0,
                                tension: 0.1
                            },
                            {
                                label: '1-hour Avg',
                                data: [],
                                // Apply solid style to 1-hour avg
                                borderColor: emotionColors[emotion],
                                backgroundColor: emotionColors[emotion].replace('0.8', '0.5'),
                                borderWidth: 1.5,
                                pointRadius: 2,
                                pointHoverRadius: 4,
                                tension: 0.1
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        scales: {
                            x: createTimeAxisOptions(), // Use shared options
                            y: {
                                beginAtZero: true,
                                title: {
                                    display: true,
                                    text: 'Avg Score / Post'
                                }
                            }
                        },
                        plugins: {
                            legend: { display: false },
                            tooltip: { mode: 'index', intersect: false }
                        },
                        animation: { duration: 200 }
                    }
                };
                chartInstances[emotion] = new Chart(ctx, config);
            }
        }
    });

    // Initialize the new Positive/Negative chart
    const posNegCanvas = document.getElementById('chart-posneg') as HTMLCanvasElement | null;
    if (posNegCanvas) {
        const ctx = posNegCanvas.getContext('2d');
        if (ctx) {
            const config: ChartConfiguration = { // Use ChartConfiguration type
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        {
                            label: 'Net Sentiment (5-min Avg)',
                            data: [],
                            // Apply dashed/fainter style to 5-min avg
                            borderColor: netSentimentColor.replace('0.8', '0.3'),
                            backgroundColor: 'transparent',
                            borderWidth: 1.5,
                            borderDash: [5, 5],
                            pointRadius: 0,
                            tension: 0.1
                        },
                        {
                            label: 'Net Sentiment (1-hour Avg)',
                            data: [],
                            // Apply solid style to 1-hour avg
                            borderColor: netSentimentColor,
                            backgroundColor: netSentimentColor.replace('0.8', '0.5'),
                            borderWidth: 1.5,
                            pointRadius: 2,
                            pointHoverRadius: 4,
                            tension: 0.1
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    scales: {
                        x: createTimeAxisOptions(), // Use shared options
                        y: {
                            // beginAtZero: false, // Default is false, explicitly removing for clarity
                            title: {
                                display: true,
                                text: 'Avg Net Score / Post' // Update label
                            }
                        }
                    },
                    plugins: {
                        legend: { display: true }, // Show legend for the single line
                        tooltip: { mode: 'index', intersect: false }
                    },
                    animation: { duration: 200 }
                }
            };
            chartInstances['posneg'] = new Chart(ctx, config);
        }
    }
}

// --- Initialize with Zero Data ---
function initializeWithZeroData() {
    const now = Date.now();
    const startTime = now - currentTimeWindowMs;
    const zeroData: AggregatedScoreEntry[] = [];

    const zeroScores: SentimentScores = {
        anger: 0, anticipation: 0, disgust: 0, fear: 0,
        joy: 0, sadness: 0, surprise: 0, trust: 0,
        positive: 0, negative: 0 // Add zero pos/neg
    };

    for (let ts = startTime; ts <= now; ts += AGGREGATION_INTERVAL_MS) {
        zeroData.push({
            timestamp: ts,
            scores: { ...zeroScores },
            postCount: 0
        });
    }

    console.log(`Initializing charts with ${zeroData.length} zero data points.`);
    updateCharts(zeroData); // Populate charts with initial zero data
}

function updateCharts(data: AggregatedScoreEntry[]) {
    currentChartData = data;
    if (!currentChartData || currentChartData.length === 0) {
        console.log("No chart data available.");
        return;
    }

    const labels = currentChartData.map(entry => entry.timestamp);

    // Calculate normalized 10s data for all categories (basis for MAs)
    const normalizedData: { [key in SentimentCategory]: (number | null)[] } = {} as any;
    for (const key in currentChartData[0].scores) {
        const category = key as SentimentCategory;
        normalizedData[category] = currentChartData.map(entry =>
            entry.postCount > 0 ? entry.scores[category] / entry.postCount : 0
        );
    }

    // Calculate 1-min and 1-hour Moving Averages for each emotion
    const shortAvgData: { [key in Emotion]: (number | null)[] } = {} as any;
    const longAvgData: { [key in Emotion]: (number | null)[] } = {} as any;
    emotions.forEach(emotion => {
        shortAvgData[emotion] = calculateMovingAverage(normalizedData[emotion], SHORT_AVG_POINTS);
        longAvgData[emotion] = calculateMovingAverage(normalizedData[emotion], LONG_AVG_POINTS);
    });

    // Calculate Net Sentiment (based on normalized 10s data)
    const normalizedNetSentimentData = normalizedData.positive.map((posScore, index) => {
        const negScore = normalizedData.negative[index];
        const numPosScore = typeof posScore === 'number' ? posScore : 0;
        const numNegScore = typeof negScore === 'number' ? negScore : 0;
        return numPosScore - numNegScore;
    });

    // Calculate 1-min and 1-hour Moving Averages for Net Sentiment
    const netSentimentShortAvg = calculateMovingAverage(normalizedNetSentimentData, SHORT_AVG_POINTS);
    const netSentimentLongAvg = calculateMovingAverage(normalizedNetSentimentData, LONG_AVG_POINTS);

    // Calculate dynamic time window based on current setting
    const now = Date.now();
    const minTime = now - currentTimeWindowMs;

    // Update emotion charts
    emotions.forEach(emotion => {
        const chart = chartInstances[emotion];
        if (chart && chart.data.datasets && chart.options?.scales?.x) {
            chart.data.labels = labels;
            chart.data.datasets[0].data = shortAvgData[emotion]; // Update dataset 0 with 1-min avg
            chart.data.datasets[1].data = longAvgData[emotion]; // Update dataset 1 with 1-hour avg
            chart.options.scales.x.min = minTime;
            chart.options.scales.x.max = now;
            chart.update('none');
        }
    });

    // Update the positive/negative (net sentiment) chart
    const posNegChart = chartInstances['posneg'];
    if (posNegChart && posNegChart.data.datasets && posNegChart.options?.scales?.x) {
        posNegChart.data.labels = labels;
        posNegChart.data.datasets[0].data = netSentimentShortAvg; // Update dataset 0 with 1-min avg
        posNegChart.data.datasets[1].data = netSentimentLongAvg; // Update dataset 1 with 1-hour avg
        posNegChart.options.scales.x.min = minTime;
        posNegChart.options.scales.x.max = now;
        posNegChart.update('none');
    }
}

// --- Control Button Logic ---
function setupControls() {
    const controlsDiv = document.querySelector('.controls');
    if (!controlsDiv) return;

    const buttons = controlsDiv.querySelectorAll('button[data-duration]');

    buttons.forEach(button => {
        button.addEventListener('click', () => {
            buttons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            const durationHours = parseFloat(button.getAttribute('data-duration') || `${DEFAULT_WINDOW_HOURS}`);
            currentTimeWindowMs = durationHours * HOUR_MS;
            console.log(`Time window changed to ${durationHours} hours (${currentTimeWindowMs}ms)`);

            // Redraw charts with the new window using existing data
            updateCharts(currentChartData);
        });
    });
}

// --- Initialize ---
document.addEventListener('DOMContentLoaded', () => {
    initializeCharts();
    setupControls();
    initializeWithZeroData();
    connectWebSocket();
});