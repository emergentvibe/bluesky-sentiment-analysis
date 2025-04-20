# Local Development Setup

This guide provides instructions for setting up the Bluesky Real-time Sentiment Dashboard project for local development and testing.

## 1. Prerequisites

*   **Node.js:** Required for running the backend and frontend build process. Download from [nodejs.org](https://nodejs.org/). (LTS version recommended).
*   **npm (or yarn):** Node package manager, comes bundled with Node.js.
*   **Git:** Required for cloning the repository.
*   **Docker:** Required for running a local PostgreSQL database instance easily. Download from [docker.com](https://www.docker.com/products/docker-desktop/).
*   **(Optional) Fly CLI (`flyctl`):** Needed if you plan to deploy to Fly.io or use `fly proxy` for local testing against Fly services. Install instructions at [fly.io/docs/hands-on/install-flyctl/](https://fly.io/docs/hands-on/install-flyctl/).

## 2. Getting Started

1.  **Clone the Repository:**
    ```bash
    git clone <repository-url>
    cd <repository-directory> # e.g., bluesky-sentiment-analysis
    ```

2.  **Install Dependencies:**
    ```bash
    npm install
    ```
    This installs both runtime dependencies and development dependencies (like TypeScript, esbuild).

## 3. Environment Setup

1.  **Copy Example Environment File:**
    ```bash
    cp .env.example .env
    ```

2.  **Set up Local PostgreSQL Database (using Docker):**
    *   Ensure Docker Desktop is running.
    *   Run the following command in your terminal to start a PostgreSQL container:
        ```bash
        docker run --name bsky-sentiment-db -e POSTGRES_PASSWORD=mysecretpassword -p 5433:5432 -d postgres:15
        ```
        *   `--name bsky-sentiment-db`: Assigns a name to the container.
        *   `-e POSTGRES_PASSWORD=mysecretpassword`: Sets the database password (change `mysecretpassword` to something secure if desired, but match it in `.env`).
        *   `-p 5433:5432`: Maps port 5433 on your local machine to port 5432 inside the container. We use 5433 externally to avoid potential conflicts with other local Postgres instances.
        *   `-d`: Runs the container in detached mode (in the background).
        *   `postgres:15`: Specifies the PostgreSQL version 15 image.
    *   **(Optional) Verify Container:** You can check if the container is running using `docker ps`.

3.  **Update `.env` File:**
    *   Open the `.env` file you created.
    *   Set the `DATABASE_URL` variable to connect to your local Docker container. Replace `mysecretpassword` if you changed it:
        ```
        DATABASE_URL=postgresql://postgres:mysecretpassword@localhost:5433/postgres
        ```
        *   `postgres`: Default username in the `postgres` Docker image.
        *   `mysecretpassword`: The password set in the `docker run` command.
        *   `localhost:5433`: Connects to the container via the mapped port.
        *   `postgres`: Default database name in the `postgres` image.
    *   **(Optional) Set `PORT`:** You can uncomment and set the `PORT` variable if you want the application server to run on a different port than the default (currently 3000).
        ```
        # PORT=3001
        ```

## 4. Building the Code

The project requires separate build steps for the backend (TypeScript to JavaScript) and the frontend (TypeScript bundling).

```bash
npm run build
```
This command executes both build scripts defined in `package.json`:
*   `npm run build:backend` (runs `tsc` to compile `src/` -> `dist/src/`)
*   `npm run build:frontend` (runs `esbuild` to bundle `public/app.ts` -> `public/dist/app.js`)

## 5. Running the Application

Once the environment is set up and the code is built:

```bash
npm start
```
This command runs the compiled backend server from the `dist` directory (`node dist/src/server.js`).

The server will:
*   Attempt to connect to the database defined in `DATABASE_URL`.
*   Initialize the database schema if tables don't exist.
*   Start the HTTP server (serving the frontend from `public/`).
*   Start the WebSocket server.
*   Connect to the Bluesky Firehose.
*   Begin processing posts and aggregating sentiment data.

## 6. Accessing the Dashboard

*   Open your web browser.
*   Navigate to `http://localhost:<PORT>`, where `<PORT>` is the port the server is running on (default is 3000, or as set in your `.env` file).

You should see the dashboard UI, and shortly after, charts should start populating with real-time data.

## 7. Stopping the Application

*   Press `Ctrl + C` in the terminal where the server is running.
*   To stop the local PostgreSQL Docker container:
    ```bash
    docker stop bsky-sentiment-db
    ```
*   To remove the container (optional, deletes the data within it):
    ```bash
    docker rm bsky-sentiment-db
    ``` 