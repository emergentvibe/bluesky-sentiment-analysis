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

7.8 **Add Moving Average Lines (5-min & 1-hour) (✅ Completed):**
    *   **Frontend (`public/app.ts`):**
        *   Defined constants for short (5min) and long (1h) moving average windows (`SHORT_AVG_POINTS`, `LONG_AVG_POINTS`).
        *   Implemented/verified `calculateMovingAverage` helper function.
        *   Modified `initializeCharts`:
            *   Each chart now has two datasets.
            *   Dataset 0: Labeled "5-min Avg", styled dashed/fainter.
            *   Dataset 1: Labeled "1-hour Avg", styled solid/prominent.
        *   Modified `updateCharts`:
            *   Calculates normalized 10s data as a base.
            *   Calculates both 5-minute and 1-hour moving averages for each emotion and net sentiment using the normalized data.
            *   Assigns 5-min MA to `datasets[0]` and 1-hour MA to `datasets[1]` for each chart.

8. **Add Database Persistence (Fly Postgres) (✅ Completed):**
    *   **Infrastructure:**
        *   Provisioned a Fly Postgres instance (`fly postgres create`).
        *   Attached the Postgres instance to the application (`fly postgres attach`), setting the `DATABASE_URL` secret.
    *   **Backend (`src/server.ts`):**
        *   Installed `pg` and `@types/pg` dependencies.
        *   Created a `pg.Pool` instance using `DATABASE_URL`.
        *   Implemented `initializeDatabase` function (called in `main`) to:
            *   Create `sentiment_data` table (timestamp TIMESTAMPTZ PK, scores JSONB, post_count INTEGER) if it doesn't exist.
            *   Create an index on the timestamp column.
        *   Removed the global in-memory `aggregatedData` array.
        *   Modified `aggregateAndStore` to:
            *   `INSERT` new `AggregatedScoreEntry` into `sentiment_data` table.
            *   Broadcast *only* the newly inserted entry (wrapped in an array) via WebSocket.
            *   Periodically `DELETE` old records (e.g., > 1 day) from the table.
        *   Modified WebSocket `connection` handler to:
            *   Query `sentiment_data` for the last 12 hours of data upon connection.
            *   Send the retrieved historical data to the new client.
    *   **Frontend (`public/app.ts`):**
        *   Updated WebSocket `onmessage` handler to differentiate between initial multi-entry historical data (replace `currentChartData`) and single-entry updates (push to `currentChartData`).
        *   Added optional pruning of the frontend `currentChartData` array.
    *   **Deployment:** Verified `Dockerfile` correctly runs `npm install`. Set `PORT=3000` environment variable via `fly secrets set` to match `fly.toml` `internal_port`.

9. **Update Time Range Options (15m-1mo) (✅ Completed):**
    *   **Frontend (`public/index.html`):
        *   Restored previous time range buttons (15m, 1h, 2h, 6h, 12h) alongside the new ones (1d, 1w, 1mo).
        *   Ensured `data-duration` attributes are correct for all buttons.
        *   Set 1d (24h) as the default active button.
    *   **Frontend (`public/app.ts`):
        *   Changed `DEFAULT_WINDOW_HOURS` constant to 24.
    *   **Backend (`src/server.ts`):**
        *   Defined constants for `ONE_MONTH_MS`, `MAX_HISTORY_MS`, `PRUNE_AGE_MS`.
        *   Updated WebSocket `connection` handler to query up to `MAX_HISTORY_MS` (1 month) from the database.
        *   Updated `aggregateAndStore` pruning logic to delete data older than `PRUNE_AGE_MS` (~31 days).
        *   Changed default `PORT` constant to 3000 to align with Fly configuration.

10. **Deployment Preparation (Fly.io) (✅ Completed):**
    *   Created a `Dockerfile` to containerize the application (multi-stage build).
    *   Includes steps to copy necessary files (`package.json`, `src`, `public`, `data`, compiled `dist`).
    *   Installs dependencies (`npm ci --include=dev` then `npm prune --omit=dev`).
    *   NRC Lexicon file included via `COPY . .`.
    *   Sets `CMD` to run the server (`npm start`).
    *   Created a `fly.toml` configuration file.
    *   Defined app name, primary region.
    *   Configured `http_service` (internal port set to 3000, `force_https=true`).
    *   Configured `auto_stop_machines = 'stop'`, `auto_start_machines = true`, `min_machines_running = 0` (later adjusted to 1).
    *   Created `.gitignore` (implicitly includes `.dockerignore` patterns).
    *   Set `PORT=3000` environment variable via `fly secrets set`.
    *   Provisioned and attached Fly Postgres database, setting `DATABASE_URL` secret.
    *   Configured for local development using `dotenv` and `fly proxy`.
    *   Adjusted `min_machines_running = 1` in `fly.toml` to prevent hibernation.

11. **Testing:**
    *   **TODO:** Add unit tests for sentiment analysis logic (`src/sentiment.ts`).
    *   **TODO:** Add unit tests for data aggregation/pruning logic (`src/server.ts`).
    *   **TODO:** Add basic integration tests for WebSocket communication (client connects, receives data).

12. **Deployment (✅ Completed):**
    *   Installed `flyctl` (Implicitly done by user).
    *   Launched the app on Fly.io (`fly launch`).
    *   Deployed the application (`fly deploy`).
    *   Monitored logs (`fly logs`) for debugging.

**Future Enhancements (Refined):**

*   **Data Persistence (✅ Completed):** Implemented using Fly Postgres.
*   **Emoji Sentiment:** Integrate emoji sentiment analysis (e.g., using a dedicated library).
*   **Advanced Filtering:** Allow filtering by keywords, users, or time ranges on the dashboard.
*   **Improved Language Handling:** More sophisticated language detection/filtering (e.g., confidence scores).
*   **UI/UX:** Enhance dashboard appearance, add loading indicators, improve chart interactions.
*   **Robust Static Serving:** Use a more robust method for serving static files (e.g., `express.static` if migrating to Express framework).
*   **Error Handling:** Implement more specific error handling for sentiment analysis, file loading, and network issues.
*   **Scalability:** Consider message queues (e.g., RabbitMQ, Kafka) for decoupling firehose processing from aggregation/broadcasting if load increases significantly.
*   **Firehose Reconnection:** Add robust automatic reconnection logic for the firehose subscription in `src/firehose.ts`.
*   **Logging:** Implement structured logging (e.g., using Winston or Pino) with configurable levels.
*   **Configuration (Partial ✅):** Moved `PORT` and `DATABASE_URL` to environment variables/secrets. Other constants (intervals, throttle factor) could still be moved.
*   **Testing Coverage:** Expand unit and integration test coverage.
*   **Rate Limiting:** Implement more graceful handling of potential Bluesky API rate limits (if using authenticated endpoints in the future).
*   **Authentication:** Add optional authentication/authorization if exposing the dashboard publicly.