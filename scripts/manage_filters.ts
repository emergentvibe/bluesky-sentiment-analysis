#!/usr/bin/env node
import 'dotenv/config';
import { program } from 'commander';
import pg from 'pg';

const { Pool } = pg;

// --- Database Setup ---
if (!process.env.DATABASE_URL) {
    console.error('CRITICAL: DATABASE_URL environment variable is not set.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

// --- Helper Functions ---

async function findFilterId(idOrName: string): Promise<number | null> {
    const client = await pool.connect();
    try {
        let result;
        const id = parseInt(idOrName, 10);
        if (!isNaN(id)) {
            result = await client.query('SELECT filter_id FROM complex_keyword_filters WHERE filter_id = $1', [id]);
        } else {
            result = await client.query('SELECT filter_id FROM complex_keyword_filters WHERE filter_name = $1', [idOrName]);
        }
        return result.rowCount > 0 ? result.rows[0].filter_id : null;
    } finally {
        client.release();
    }
}

// --- CLI Commands ---

program
    .name('manage-filters')
    .description('CLI tool to manage complex keyword filters in the database');

program
    .command('list')
    .description('List all complex keyword filters')
    .action(async () => {
        const client = await pool.connect();
        try {
            const result = await client.query('SELECT filter_id, filter_name, filter_query, description, is_active, created_at FROM complex_keyword_filters ORDER BY filter_id');
            if (result.rowCount === 0) {
                console.log('No filters found.');
            } else {
                console.table(result.rows);
            }
        } catch (err: any) {
            console.error('Error listing filters:', err.message);
        } finally {
            client.release();
            await pool.end();
        }
    });

program
    .command('add')
    .description('Add a new complex keyword filter')
    .requiredOption('-n, --name <name>', 'Unique name for the filter')
    .requiredOption('-q, --query <query>', 'Filter query string (syntax depends on evaluation logic)')
    .option('-d, --description <description>', 'Optional description for the filter')
    .action(async (options) => {
        const client = await pool.connect();
        try {
            const result = await client.query(
                'INSERT INTO complex_keyword_filters (filter_name, filter_query, description) VALUES ($1, $2, $3) RETURNING filter_id',
                [options.name, options.query, options.description || null]
            );
            console.log(`Filter '${options.name}' added successfully with ID: ${result.rows[0].filter_id}`);
        } catch (err: any) {
            if (err.code === '23505') { // unique_violation
                 console.error(`Error: Filter name '${options.name}' already exists.`);
            } else {
                 console.error('Error adding filter:', err.message);
            }
        } finally {
            client.release();
            await pool.end();
        }
    });

program
    .command('update <idOrName>')
    .description('Update an existing filter (provide filter ID or exact name)')
    .option('-n, --name <name>', 'New unique name for the filter')
    .option('-q, --query <query>', 'New filter query string')
    .option('-d, --description <description>', 'New optional description for the filter (use "" to clear)')
    .action(async (idOrName, options) => {
        if (options.name === undefined && options.query === undefined && options.description === undefined) {
            console.error('Error: At least one option (--name, --query, or --description) must be provided to update.');
            await pool.end();
            return;
        }

        const filterId = await findFilterId(idOrName);
        if (filterId === null) {
            console.error(`Error: Filter '${idOrName}' not found.`);
            await pool.end();
            return;
        }

        const client = await pool.connect();
        try {
            // Fetch current values first
            const currentResult = await client.query('SELECT filter_name, filter_query, description FROM complex_keyword_filters WHERE filter_id = $1', [filterId]);
            if (!currentResult || currentResult.rowCount === 0) {
                 console.error(`Error: Could not retrieve current data for filter ID ${filterId}.`);
                 await pool.end();
                 return;
             }
            const currentData = currentResult.rows[0];

            // Determine new values, using current values as defaults
            const newName = options.name !== undefined ? options.name : currentData.filter_name;
            const newQuery = options.query !== undefined ? options.query : currentData.filter_query;
            // Handle description update/clearing
            let newDescription = currentData.description;
            if (options.description !== undefined) {
                newDescription = options.description === '' ? null : options.description;
            }

            // Construct the update query with definite values
            const updateQuery = `
                UPDATE complex_keyword_filters
                SET filter_name = $1, filter_query = $2, description = $3
                WHERE filter_id = $4
            `;
            const values = [newName, newQuery, newDescription, filterId];

            const result = await client.query(updateQuery, values);

            if (result && result!.rowCount > 0) {
                console.log(`Filter ID ${filterId} updated successfully.`);
            } else {
                // This case should ideally not happen if the filter existed
                console.error(`Filter ID ${filterId} update failed (unexpected). Check if filter was deleted concurrently.`);
            }

        } catch (err: any) {
            if (err.code === '23505') { // unique_violation on name update
                console.error(`Error: New filter name '${options.name}' already exists.`);
            } else {
                console.error(`Error updating filter ID ${filterId}:`, err.message);
            }
        } finally {
            client.release();
            await pool.end();
        }
    });

program
    .command('activate <idOrName>')
    .description('Activate a filter (provide filter ID or exact name)')
    .action(async (idOrName) => {
        const filterId = await findFilterId(idOrName);
        if (filterId === null) {
            console.error(`Error: Filter '${idOrName}' not found.`);
            await pool.end();
            return;
        }
        const client = await pool.connect();
        try {
            const result = await client.query('UPDATE complex_keyword_filters SET is_active = TRUE WHERE filter_id = $1', [filterId]);
            if (result && result!.rowCount > 0) {
                console.log(`Filter ID ${filterId} activated.`);
            } else {
                console.error(`Filter ID ${filterId} found but activation failed (unexpected).`);
            }
        } catch (err: any) {
            console.error(`Error activating filter ID ${filterId}:`, err.message);
        } finally {
            client.release();
            await pool.end();
        }
    });

program
    .command('deactivate <idOrName>')
    .description('Deactivate a filter (provide filter ID or exact name)')
    .action(async (idOrName) => {
        const filterId = await findFilterId(idOrName);
        if (filterId === null) {
            console.error(`Error: Filter '${idOrName}' not found.`);
             await pool.end();
            return;
        }
        const client = await pool.connect();
        try {
             const result = await client.query('UPDATE complex_keyword_filters SET is_active = FALSE WHERE filter_id = $1', [filterId]);
            if (result && result!.rowCount > 0) {
                console.log(`Filter ID ${filterId} deactivated.`);
            } else {
                console.error(`Filter ID ${filterId} found but deactivation failed (unexpected).`);
            }
        } catch (err: any) {
             console.error(`Error deactivating filter ID ${filterId}:`, err.message);
        } finally {
            client.release();
            await pool.end();
        }
    });

program
    .command('delete <idOrName>')
    .description('Delete a filter (provide filter ID or exact name)')
    .action(async (idOrName) => {
         const filterId = await findFilterId(idOrName);
        if (filterId === null) {
            console.error(`Error: Filter '${idOrName}' not found.`);
             await pool.end();
            return;
        }
        const client = await pool.connect();
        try {
            // Note: ON DELETE CASCADE will handle associated sentiment data
             const result = await client.query('DELETE FROM complex_keyword_filters WHERE filter_id = $1', [filterId]);
            if (result && result!.rowCount > 0) {
                 console.log(`Filter ID ${filterId} and its associated data deleted successfully.`);
            } else {
                 console.error(`Filter ID ${filterId} found but deletion failed (unexpected).`);
            }
        } catch (err: any) {
             console.error(`Error deleting filter ID ${filterId}:`, err.message);
        } finally {
            client.release();
            await pool.end();
        }
    });


// Make sure to handle cases where no command is provided or invalid command
program.on('command:*', () => {
    console.error(`Invalid command: ${program.args.join(' ')}\nSee --help for a list of available commands.`);
    process.exit(1);
});

// Execute the program logic
program.parseAsync(process.argv).catch(async err => {
    console.error("An unexpected error occurred:", err);
    await pool.end(); // Ensure pool is closed on unexpected errors
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nGracefully shutting down...');
    await pool.end();
    process.exit(0);
}); 