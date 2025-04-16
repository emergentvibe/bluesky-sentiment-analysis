import { Chart, registerables } from 'chart.js';
import 'chartjs-adapter-moment'; // Import the moment adapter
// Register Chart.js components (including time scale)
Chart.register(...registerables);
// --- WebSocket Connection ---
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${window.location.host}`;
let socket = null;
function connectWebSocket() {
    console.log('Connecting to WebSocket server...', wsUrl);
    socket = new WebSocket(wsUrl);
    socket.onopen = () => {
        console.log('WebSocket connection established.');
    };
    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            // console.log('Received data:', data);
            updateCharts(data);
        }
        catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    };
    socket.onclose = (event) => {
        console.log('WebSocket connection closed. Attempting to reconnect...', event.reason);
        // Simple reconnect logic (every 5 seconds)
        setTimeout(connectWebSocket, 5000);
    };
    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        // The onclose event will likely trigger reconnection attempt
        socket === null || socket === void 0 ? void 0 : socket.close(); // Ensure connection is closed if an error occurs
    };
}
// --- Chart Initialization and Update ---
const emotions = ['anger', 'anticipation', 'disgust', 'fear', 'joy', 'sadness', 'surprise', 'trust'];
const chartInstances = {};
// Define colors for each emotion chart (adjust as needed)
const emotionColors = {
    anger: 'rgba(255, 99, 132, 0.8)', // Red
    anticipation: 'rgba(255, 159, 64, 0.8)', // Orange
    disgust: 'rgba(153, 102, 255, 0.8)', // Purple
    fear: 'rgba(75, 192, 192, 0.8)', // Teal
    joy: 'rgba(255, 205, 86, 0.8)', // Yellow
    sadness: 'rgba(54, 162, 235, 0.8)', // Blue
    surprise: 'rgba(201, 203, 207, 0.8)', // Grey
    trust: 'rgba(75, 181, 67, 0.8)', // Green
};
function initializeCharts() {
    emotions.forEach(emotion => {
        const canvas = document.getElementById(`chart-${emotion}`);
        if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) {
                chartInstances[emotion] = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: [], // Timestamps
                        datasets: [{
                                label: emotion.charAt(0).toUpperCase() + emotion.slice(1), // Capitalize emotion name
                                data: [], // Scores for this emotion
                                borderColor: emotionColors[emotion],
                                backgroundColor: emotionColors[emotion].replace('0.8', '0.5'), // Lighter fill
                                tension: 0.1, // Slightly smooth the line
                                pointRadius: 2,
                                pointHoverRadius: 4,
                                borderWidth: 1.5
                            }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        scales: {
                            x: {
                                type: 'time',
                                time: {
                                    unit: 'hour', // Display hours by default
                                    tooltipFormat: 'YYYY-MM-DD HH:mm:ss', // Tooltip format
                                    displayFormats: {
                                        hour: 'HH:mm',
                                        minute: 'HH:mm',
                                        second: 'HH:mm:ss'
                                    }
                                },
                                title: {
                                    display: true,
                                    text: 'Time'
                                }
                            },
                            y: {
                                beginAtZero: true,
                                title: {
                                    display: true,
                                    text: 'Score Count'
                                }
                            }
                        },
                        plugins: {
                            legend: {
                                display: false // Hide legend as title is above chart
                            },
                            tooltip: {
                                mode: 'index',
                                intersect: false
                            }
                        },
                        animation: {
                            duration: 200 // Faster animation for real-time updates
                        }
                    }
                });
            }
        }
    });
}
function updateCharts(data) {
    if (!data || data.length === 0) {
        console.log("No data received or empty data array.");
        return;
    }
    // Prepare data for each chart
    const labels = data.map(entry => entry.timestamp);
    const emotionData = {
        anger: data.map(entry => entry.scores.anger),
        anticipation: data.map(entry => entry.scores.anticipation),
        disgust: data.map(entry => entry.scores.disgust),
        fear: data.map(entry => entry.scores.fear),
        joy: data.map(entry => entry.scores.joy),
        sadness: data.map(entry => entry.scores.sadness),
        surprise: data.map(entry => entry.scores.surprise),
        trust: data.map(entry => entry.scores.trust),
    };
    // Update each chart instance
    emotions.forEach(emotion => {
        const chart = chartInstances[emotion];
        if (chart) {
            chart.data.labels = labels;
            chart.data.datasets[0].data = emotionData[emotion];
            chart.update(); // Update the chart visually
        }
    });
}
// --- Initialize --- 
document.addEventListener('DOMContentLoaded', () => {
    initializeCharts();
    connectWebSocket();
});
//# sourceMappingURL=app.js.map