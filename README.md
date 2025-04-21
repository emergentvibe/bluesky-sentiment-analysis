# Bluesky Real-time Sentiment Analysis Dashboard

A real-time dashboard that monitors the Bluesky firehose, performs sentiment analysis on posts, aggregates the results, and displays sentiment trends over time.

**Live Demo:** [https://bluesky-sentiment-analysis.fly.dev](https://bluesky-sentiment-analysis.fly.dev)

![Dashboard Screenshot](screenshot.png)

## Features

*   Connects to the Bluesky Firehose via WebSockets.
*   Filters posts by language using `franc`.
*   Performs sentiment analysis based on the NRC Emotion Lexicon.
*   Supports custom keyword-based filter signals.
*   Aggregates scores into configurable intervals (default: 10 seconds).
*   Real-time updates pushed to frontend clients via WebSockets (`ws`).
*   Interactive dashboard built with HTML, CSS, and TypeScript (using Chart.js).
*   Displays separate charts for sentiment signals/MAs and post volume.
*   Calculates and displays configurable short-term and long-term moving averages.
*   Allows selection of different time range views.
*   Data persistence using PostgreSQL.
*   Deployed on Fly.io using Docker.

## Technology Stack

*   **Backend:** Node.js, TypeScript, `ws` (WebSockets), `pg` (Postgres client), `tsx`
*   **Frontend:** HTML, CSS, TypeScript, Chart.js, Moment.js
*   **Data:** Bluesky Firehose, NRC Emotion Lexicon
*   **Libraries:** `@atproto/api`, `franc`, `esbuild`
*   **Infrastructure:** Docker, Fly.io (optional deployment)
*   **Package Manager:** `pnpm`

## Local Development Setup (using Docker for PostgreSQL)

**Prerequisites:**

*   Node.js (v20.x recommended)
*   `pnpm` (Install via `npm install -g pnpm`)
*   Docker Desktop (or Docker Engine/CLI)
*   NRC Emotion Lexicon file (see step 4)

**Steps:**

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd bluesky-sentiment-analysis
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Set up Environment Variables:**
    *   Create a `.env` file in the project root by copying the example:
        ```bash
        cp .env.example .env
        ```
    *   Review the variables in `.env`. The defaults should work for local Docker setup, but you might adjust `PORT` or Firehose URL if needed.

4.  **Set up PostgreSQL with Docker:**
    *   **Create a Docker volume** to persist database data:
        ```bash
        docker volume create bluesky-db-data
        ```
    *   **Run the PostgreSQL container:**
        ```bash
        docker run --name local-bluesky-db -e POSTGRES_PASSWORD=mysecretpassword -p 5432:5432 -v bluesky-db-data:/var/lib/postgresql/data -d postgres:15
        ```
        *   This starts a PostgreSQL 15 container named `local-bluesky-db`.
        *   The superuser `postgres` will have the password `mysecretpassword`.
        *   It maps port 5432 on your host to the container's port 5432.
        *   It uses the `bluesky-db-data` volume.
        *   Wait a few seconds for the database to initialize.
    *   **(Optional) Find Container IP if `localhost` fails:** In some cases, another service on your machine might conflict with `localhost:5432`. If you encounter connection issues, find the container's IP:
        ```bash
        # macOS / Linux
        docker inspect local-bluesky-db | grep IPAddress

        # Windows (PowerShell)
        docker inspect local-bluesky-db | Select-String IPAddress
        ```
        Then, update the `DATABASE_URL` in your `.env` file, replacing `localhost` with the container IP address (e.g., `postgres://postgres:mysecretpassword@172.17.0.2:5432/postgres`).

5.  **Initialize the Database Schema:**
    *   Run the main server **once** to create the necessary tables:
        ```bash
        npm start
        ```
    *   Watch the logs. Once you see messages like `Initializing database...` and `...table "sentiment_data" ensured`, `...index ensured`, etc., the schema is ready. Press `Ctrl+C` to stop the server.

6.  **Ingest Lexicon Data:**
    *   Run the ingestion script:
        ```bash
        npm run ingest-lexicon
        ```
    *   This should now succeed as the `lexicon_emotions` table exists.

7.  **Build & Run Server:**
    *   Build both backend and frontend code:
        ```bash
        npm run build
        ```
    *   Start the server:
        ```bash
        npm start
        ```
8.  Open your browser to `http://localhost:3000` (or the port configured in `.env`).

## Deployment

This project is configured for deployment on [Fly.io](https://fly.io/).

*   The `Dockerfile` handles building the application container.
*   The `fly.toml` file contains the deployment configuration.
*   Deployment is typically done via `fly deploy`.
*   Required secrets (`DATABASE_URL`, `PORT`) are set via `fly secrets set`.
*   A Fly Postgres database is expected to be provisioned and attached.
*   Ensure `min_machines_running` is set to `1` in `fly.toml` for continuous operation.

## Contributing & Backlog

Contributions are welcome!
Please see the [backlog.md](backlog.md) file for a list of planned features and tasks.

Feel free to open issues or submit pull requests.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
