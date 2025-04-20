# Directory and File Outline

This document outlines the structure of the Bluesky Real-time Sentiment Dashboard project.

```
.
├── Dockerfile            # Defines the container image for deployment (e.g., on Fly.io).
├── fly.toml              # Configuration file for Fly.io deployment.
├── package.json          # Node.js project manifest, lists dependencies and scripts.
├── package-lock.json     # Records exact versions of installed dependencies.
├── tsconfig.json         # TypeScript compiler configuration for the backend.
├── .env.example          # Example environment variables file. Copy to .env for local setup.
├── .gitignore            # Specifies intentionally untracked files that Git should ignore.
│
├── data/                 # Contains static data files.
│   └── NRC-Emotion-Lexicon-Wordlevel-v0.92.txt # The lexicon file used for sentiment analysis.
│
├── dist/                 # Output directory for compiled backend TypeScript code (from `tsc`).
│   └── src/              # Contains compiled JavaScript files.
│
├── docs/                 # Contains project documentation.
│   ├── dev-plan.md       # Outlines the development plan, phases, and feature status.
│   ├── dev-rules.md      # Defines coding standards and development guidelines.
│   ├── system-architecture.md # Describes the overall system architecture and data flow.
│   └── directory-outline.md # This file - outlines the project structure.
│   └── SETUP.md          # Instructions for setting up the project for local development.
│
├── node_modules/         # Contains installed Node.js dependencies (ignored by Git).
│
├── public/               # Contains frontend static assets served by the HTTP server.
│   ├── index.html        # The main HTML file for the dashboard UI.
│   ├── app.ts            # Frontend TypeScript code managing UI, WebSocket, and Chart.js.
│   └── dist/             # Output directory for bundled frontend code (from `esbuild`).
│       └── app.js        # Bundled and minified JavaScript for the frontend.
│       └── app.js.map    # Sourcemap for debugging bundled frontend code.
│
├── src/                  # Contains backend TypeScript source code.
│   ├── firehose.ts       # Handles connection to the Bluesky Firehose and event processing.
│   ├── server.ts         # Main backend application: HTTP/WebSocket server, aggregation, API logic.
│   ├── sentiment.ts      # Handles lexicon loading and sentiment analysis logic.
│   └── franc.d.ts        # Type declaration file for the 'franc' library.
│
└── .env                  # Local environment variables (e.g., DATABASE_URL). (Untracked by Git).
```

## Key Components:

*   **Backend (`src/`):** Written in TypeScript, runs on Node.js. Responsible for fetching data from Bluesky, processing it, analyzing sentiment, aggregating results, storing data in PostgreSQL, and communicating with the frontend via WebSockets.
*   **Frontend (`public/`):** Basic HTML, CSS, and TypeScript. Connects to the backend WebSocket, receives data, manages user selections, and renders charts using Chart.js. Uses `esbuild` for bundling.
*   **Database:** PostgreSQL database stores time-series sentiment data (both base language and planned keyword-filtered streams), as well as planned signal definitions and custom metrics.
*   **Deployment (`Dockerfile`, `fly.toml`):** Configured for deployment on Fly.io using Docker containers.
*   **Documentation (`docs/`):** Contains planning, architecture, rules, setup, and structure information. 