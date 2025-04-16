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
    timestamp: number; // Unix timestamp (milliseconds)
    scores: SentimentScores; // Use updated type
    postCount: number; // Add post count
}

// --- Constants ---
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_HOURS = 12;
// Define aggregation interval (must match backend - now 10000ms)
const AGGREGATION_INTERVAL_MS = 10 * 1000;
let currentTimeWindowMs = DEFAULT_WINDOW_HOURS * HOUR_MS; // Default to 12 hours
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
            updateCharts(data);
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
                        datasets: [{
                            label: emotion.charAt(0).toUpperCase() + emotion.slice(1),
                            data: [], // Initialize with empty data
                            borderColor: emotionColors[emotion],
                            backgroundColor: emotionColors[emotion].replace('0.8', '0.5'),
                            tension: 0.1,
                            pointRadius: 2,
                            pointHoverRadius: 4,
                            borderWidth: 1.5
                        }]
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
                            label: 'Net Sentiment (Positive - Negative)', // Single dataset
                            data: [],
                            borderColor: netSentimentColor, // Use new color
                            backgroundColor: netSentimentColor.replace('0.8', '0.5'),
                            tension: 0.1,
                            pointRadius: 2,
                            pointHoverRadius: 4,
                            borderWidth: 1.5
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
    currentChartData = data; // Store the latest data
    if (!currentChartData || currentChartData.length === 0) {
        console.log("No chart data available.");
        return;
    }

    const labels = currentChartData.map(entry => entry.timestamp);

    // Calculate normalized data for all categories
    const normalizedData: { [key in SentimentCategory]: (number | null)[] } = {} as any;
    for (const key in currentChartData[0].scores) {
        const category = key as SentimentCategory;
        normalizedData[category] = currentChartData.map(entry =>
            entry.postCount > 0 ? entry.scores[category] / entry.postCount : 0
        );
    }

    // Calculate Net Sentiment Data
    const normalizedNetSentimentData = normalizedData.positive.map((posScore, index) => {
        const negScore = normalizedData.negative[index];
        const numPosScore = typeof posScore === 'number' ? posScore : 0;
        const numNegScore = typeof negScore === 'number' ? negScore : 0;
        return numPosScore - numNegScore;
    });

    // Calculate dynamic time window based on current setting
    const now = Date.now();
    const minTime = now - currentTimeWindowMs;

    // Update emotion charts
    emotions.forEach(emotion => {
        const chart = chartInstances[emotion];
        if (chart && chart.data.datasets && chart.options?.scales?.x) {
            chart.data.labels = labels;
            chart.data.datasets[0].data = normalizedData[emotion];
            chart.options.scales.x.min = minTime;
            chart.options.scales.x.max = now;
            chart.update('none'); // Use 'none' for smoother updates when only data changes
        }
    });

    // Update the positive/negative (net sentiment) chart
    const posNegChart = chartInstances['posneg'];
    if (posNegChart && posNegChart.data.datasets && posNegChart.options?.scales?.x) {
        posNegChart.data.labels = labels;
        posNegChart.data.datasets[0].data = normalizedNetSentimentData; // Update the single dataset
        posNegChart.options.scales.x.min = minTime;
        posNegChart.options.scales.x.max = now;
        posNegChart.update('none'); // Use 'none' animation
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