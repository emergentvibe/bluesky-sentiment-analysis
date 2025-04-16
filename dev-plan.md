# Bluesky Real-time Sentiment Analysis Dashboard - Development Plan

This document outlines the plan to build a real-time dashboard that monitors Bluesky posts, performs sentiment analysis using the NRC Emotion Lexicon, and displays emotion trends over time.

**Technology Stack:**

*   **Backend:** Node.js, TypeScript
*   **Frontend:** HTML, CSS, TypeScript (Plain JS initially)
*   **Real-time Communication:** WebSockets (`ws` or `socket.io`)
*   **Sentiment Analysis:** NRC Emotion Lexicon (Manual implementation required)
*   **Language Detection:** `franc`
*   **Charting:** Chart.js
*   **Deployment:** Fly.io (Docker)

**Project Phases:**

1.  **Project Setup (✅ Completed):**
    *   Initialize Node.js project (`npm init -y`).
    *   Set up TypeScript (`npm install -D typescript @types/node @types/ws`, created `tsconfig.json`).
    *   Install base dependencies (`npm install ws @atproto/api franc chart.js`).
    *   Set up project structure (`src/`, `public/`).

2.  **Bluesky Firehose Connection (✅ Completed):**
    *   Implemented a service module (`src/firehose.ts`) using `@atproto/xrpc-server`'s `Subscription` class to connect to the Bluesky Firehose.
    *   Handles `com.atproto.sync.subscribeRepos` method.
    *   Iterates through messages, decodes CAR files for commit events.
    *   Identifies and extracts `app.bsky.feed.post` records.
    *   Provides post records and commit metadata via a callback.
    *   Includes basic error handling and logging for the stream.

3.  **Data Filtering & Processing (✅ Completed):**
    *   Created the main server file (`src/server.ts`).
    *   Calls `subscribeToFirehose` from the server.
    *   Implemented the `processPost` callback function to receive posts.
    *   In the callback:
        *   Extracted post text.
        *   Used `franc` to detect language.
        *   Filtered out non-English posts.

4.  **Sentiment Analysis (NRC) (✅ Completed):**
    *   Created `src/sentiment.ts`.
    *   Created `data` directory and `data/NRC-Emotion-Lexicon-Wordlevel-v0.92.txt` placeholder/instruction file.
    *   Implemented lexicon loading logic in `src/sentiment.ts` to read and parse the lexicon file at startup.
    *   Implemented `analyzeSentiment` function to tokenize text and count emotions based on the loaded lexicon.
    *   Integrated `analyzeSentiment` into the `processPost` callback in `src/server.ts` for English posts.
    *   Sentiment scores are currently logged to the console.

5.  **Data Aggregation (✅ Completed):**
    *   Implemented an in-memory array (`aggregatedData`) in `src/server.ts` to store time-series sentiment scores.
    *   Created a temporary accumulator (`currentIntervalScores`) for incoming scores.
    *   Set up a `setInterval` timer (now 10 seconds) to run the `aggregateAndStore` function.
    *   The `aggregateAndStore` function adds accumulated scores with a timestamp to `aggregatedData` and resets the accumulator.
    *   Implemented pruning logic to remove data older than 12 hours from `aggregatedData`.
    *   Aggregated scores are currently logged to the console.

6.  **Real-time Backend (WebSockets) (✅ Completed):**
    *   Imported and initialized the `ws` library in `src/server.ts`.
    *   Created a `WebSocketServer` listening on `PORT` (default 8088).
    *   Implemented connection handling: sends the full `aggregatedData` history to new clients.
    *   Implemented a `broadcast` function to send data to all connected clients.
    *   Modified the `aggregateAndStore` timer function to call `broadcast` with the updated `aggregatedData` every 10 seconds.
    *   Added basic client disconnect and error logging.

7.  **Frontend Dashboard (✅ Completed):**
    *   Created `public/index.html` with HTML structure, CSS for grid layout, and canvas elements for 8 charts.
    *   Created `public/app.ts` with frontend logic.
    *   **Bundling:** Integrated `esbuild` to bundle frontend JS (`app.ts`) and its dependencies (`chart.js`, adapter) into `public/dist/app.js`.
    *   **Module Loading:** Configured `index.html` to load `app.js` as `type="module"`.
    *   **Functionality:** Frontend connects to WebSocket, receives aggregated data, initializes/updates 8 Chart.js line charts.
    *   Includes basic WebSocket reconnection logic.
    *   Updated `package.json` scripts for building backend (`tsc`) and frontend (`esbuild`).
    *   Removed `tsconfig.public.json` (handled by esbuild).

**Local Testing & Debugging (✅ Completed):**

*   Successfully ran the application locally after addressing several issues:
    *   Migrated backend (`src`) from CommonJS to ES Modules (`"type": "module"`, `tsconfig` changes, `import` syntax, `.js` extensions in imports) to resolve `ERR_REQUIRE_ESM` with `franc`.
    *   Corrected firehose message frame parsing in `src/firehose.ts` based on actual log data (`$type` field).
    *   Fixed HTTP server in `src/server.ts` to properly serve static files (`index.html`, bundled `app.js`) instead of only handling WebSocket upgrades.
    *   Changed default listening port to `8088` to avoid potential conflicts.
    *   Implemented firehose processing throttling (`1/50`) and adjusted aggregation interval (`10s`) for better local performance.
*   **Outcome:** Dashboard successfully renders charts with real-time data on `http://localhost:8088`.
*   **Limitation:** Current data aggregation is in-memory only; data is lost on server restart.

**Feature Enhancements (Phase 7 Follow-up):**

7.1. **Add Chart Smoothing (✅ Completed):**
    *   Modify Chart.js line dataset options in `public/app.ts` to enable line smoothing (e.g., `tension: 0.1`).

7.2. **Add Relative Time Labels (✅ Completed):**
    *   Installed Moment.js and `chartjs-adapter-moment`.
    *   Modify Chart.js x-axis scale options (`ticks.callback`, potentially `time.unit`, `time.stepSize`) in `public/app.ts` to display relative time labels (e.g., -2h, -1h, Now).

7.3. **Initialize Charts with Zero Data (✅ Completed):**
    *   **Frontend (`public/app.ts`):** Modified `public/app.ts` to generate an initial array of zero-score entries for the selected time window using the `AGGREGATION_INTERVAL_MS` constant.
    *   This zero data is displayed initially before the first WebSocket message arrives, providing a baseline.

7.4. **Implement Moving Time Window Display (✅ Completed):**
    *   Modify Chart.js x-axis scale options (`min`, `max`) in `public/app.ts` to be relative to the current time (e.g., `Date.now() - currentTimeWindowMs` to `Date.now()`).
    *   Ensure chart updates handle the moving window smoothly.

7.5. **Implement Time Range Selection Buttons (✅ Completed):**
    *   **Frontend (`public/index.html`):** Added buttons (12h, 6h, 2h, 1h, 15m) with basic styling.
    *   **Frontend (`public/app.ts`):**
        *   Added event listeners to buttons.
        *   Store the selected time window duration (`currentTimeWindowMs`).
        *   Modify `updateCharts` to use `currentTimeWindowMs` when setting `min` on the x-axis.
        *   Redraw charts with existing data (`currentChartData`) when the time range changes.

7.6. **Add Info Icon/Tooltip (✅ Completed):**
    *   Add an info icon (`<span>?</span>`) near the title in `public/index.html`.
    *   Add CSS in `public/index.html` (`<style>` tag) to style the icon and create a hover tooltip displaying the score calculation explanation (avg score per post within the 10s interval).

7.7. **Add Positive/Negative Sentiment Graph (✅ Completed):**
    *   **Backend (`src/sentiment.ts`):**
        *   Updated `SentimentScores` interface (previously `EmotionScores`) to include `positive` and `negative` fields.
        *   Modified lexicon loading to recognize `positive` and `negative` categories.
        *   Updated `analyzeSentiment` to count words associated with `positive` and `negative` sentiments.
    *   **Backend (`src/server.ts`):
        *   Updated `AggregatedScoreEntry` to use `SentimentScores`.
        *   Updated `createEmptyScores` and `addScores` helper functions to handle `positive` and `negative` fields.
        *   Modified `aggregateAndStore` to include the new scores in the broadcast data.
    *   **Frontend (`public/index.html`):**
        *   Added a new, full-width chart container (`div.chart-container.full-width`) at the top of the grid.
        *   Added a canvas (`id="chart-posneg"`) and title (`<h2>`) inside the new container.
    *   **Frontend (`public/app.ts`):**
        *   Updated `SentimentScores` and `AggregatedScoreEntry` interfaces.
        *   Modified `initializeCharts` to create a new Chart.js instance (`chartInstances['posneg']`) for the `chart-posneg` canvas, configured with a **single dataset** (Net Sentiment = Positive - Negative) and appropriate color/legend.
        *   Updated the y-axis configuration for the `posneg` chart to remove `beginAtZero: true`, allowing the axis to center around 0.
        *   Updated `initializeWithZeroData` to include `positive: 0, negative: 0` in the initial zero scores.
        *   Modified `updateCharts` to calculate normalized `positive` and `negative` scores, then compute a **net sentiment score** (`positive - negative`) for the single dataset, and update the `chartInstances['posneg']` chart data and time window.

8.  **Deployment Preparation (Fly.io):**
    *   Create a `Dockerfile` to containerize the application.
        *   Include steps to copy necessary files (`package.json`, `src`, `public`, `data` placeholder, compiled `dist`).
        *   Install dependencies (`npm install --omit=dev`).
        *   Set `CMD` to run the server (`npm start`).
        *   Ensure `.dockerignore` excludes `node_modules`, `.git`, etc.
    *   Create a `fly.toml` configuration file.
        *   Define app name, primary region.
        *   Configure `http_service` (internal port 8088, force https).
        *   Potentially add health checks.
        *   **Note:** Will need to handle getting the NRC lexicon file into the deployed container (e.g., multi-stage build, adding it during deploy).

9.  **Testing:**
    *   **TODO:** Add unit tests for sentiment analysis logic (`src/sentiment.ts`).
    *   **TODO:** Add unit tests for data aggregation/pruning logic (`src/server.ts`).
    *   **TODO:** Add basic integration tests for WebSocket communication (client connects, receives data).

10. **Deployment:**
    *   Install `flyctl`.
    *   Launch the app on Fly.io (`fly launch`).
    *   Deploy the application (`fly deploy`).
    *   Monitor logs (`fly logs`).

**Future Enhancements (Refined):**

*   **Data Persistence:** Implement persistent storage (e.g., Redis for time-series, PostgreSQL/MongoDB for longer history) to retain data across restarts.
*   **Emoji Sentiment:** Integrate emoji sentiment analysis (e.g., using a dedicated library).
*   **Advanced Filtering:** Allow filtering by keywords, users, or time ranges on the dashboard.
*   **Improved Language Handling:** More sophisticated language detection/filtering (e.g., confidence scores).
*   **UI/UX:** Enhance dashboard appearance, add loading indicators, improve chart interactions.
*   **Robust Static Serving:** Use a more robust method for serving static files (e.g., `express.static` if migrating to Express framework).
*   **Error Handling:** Implement more specific error handling for sentiment analysis, file loading, and network issues.
*   **Scalability:** Consider message queues (e.g., RabbitMQ, Kafka) for decoupling firehose processing from aggregation/broadcasting if load increases significantly.
*   **Firehose Reconnection:** Add robust automatic reconnection logic for the firehose subscription in `src/firehose.ts`.
*   **Logging:** Implement structured logging (e.g., using Winston or Pino) with configurable levels.
*   **Configuration:** Move constants like port, intervals, throttle factor to environment variables.
*   **Testing Coverage:** Expand unit and integration test coverage.
*   **Rate Limiting:** Implement more graceful handling of potential Bluesky API rate limits (if using authenticated endpoints in the future).
*   **Authentication:** Add optional authentication/authorization if exposing the dashboard publicly. 