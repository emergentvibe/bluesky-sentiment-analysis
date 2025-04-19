import { ComAtprotoSyncSubscribeRepos } from '@atproto/api';
import { Subscription } from '@atproto/xrpc-server';
import { cborToLexRecord, readCar } from '@atproto/repo';
import { AppBskyFeedPost } from '@atproto/api';
import { CommitData } from './server.js'; // Add .js extension

// Define the expected structure based on logs
interface FirehoseFrame {
    seq: number;
    repo: string;
    time: string;
    commit?: any; // CID
    blocks?: Uint8Array;
    ops?: any[];
    '$type': string; // Use the actual $type field
    // Add other common fields if needed for different message types
}

// Update the type guard
function isFirehoseFrame(obj: unknown): obj is FirehoseFrame {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        typeof (obj as FirehoseFrame).seq === 'number' &&
        typeof (obj as FirehoseFrame).repo === 'string' &&
        typeof (obj as FirehoseFrame).time === 'string' &&
        typeof (obj as FirehoseFrame)['$type'] === 'string' // Check for $type
    );
}

// Callback type expected by the server
export type PostCallback = (post: AppBskyFeedPost.Record, commit: CommitData) => void;

class FirehoseSubscription {
    private subscription: Subscription<ComAtprotoSyncSubscribeRepos.Commit> | null = null;
    private service: string;
    private reconnectDelay: number = 5000; // Initial reconnect delay 5s
    private maxReconnectDelay: number = 60000; // Max reconnect delay 60s
    private isStopped: boolean = false; // Flag to prevent reconnect on intentional stop

    constructor(service: string) {
        this.service = service;
    }

    // Added stop method
    stop() {
        this.isStopped = true;
        // No explicit close needed, the loop termination handles it
        this.subscription = null;
        console.log('Firehose subscription stopped intentionally.');
    }

    // Modified to accept PostCallback again
    async subscribeToFirehose(onPost: PostCallback) {
        this.isStopped = false; // Reset flag on new subscription attempt
        let currentDelay = this.reconnectDelay;

        // Loop to handle reconnection
        while (!this.isStopped) {
            console.log('Attempting to connect/reconnect to Bluesky Firehose via Subscription...');
            this.subscription = new Subscription<ComAtprotoSyncSubscribeRepos.Commit>({
                service: this.service,
                method: 'com.atproto.sync.subscribeRepos',
                validate: (value: unknown): any => {
                    if (typeof value === 'object' && value !== null && 'ops' in value && 'blocks' in value) {
                        return value;
                    }
                    // TEMP: Log other message types for inspection
                    // else if (typeof value === 'object' && value !== null && '$type' in value) {
                    //     console.log(`Other message type: ${(value as any).$type}`);
                    // }
                    return undefined;
                }
            });
            console.log('Firehose subscription object created. Starting iteration...');

            try {
                for await (const commit of this.subscription) {
                    if (this.isStopped) break; // Check if stopped before processing
                    if (!commit) continue; // Skip if validator filtered

                    // Process the commit asynchronously
                    try {
                        const car = await readCar(commit.blocks as Uint8Array);
                        for (const op of commit.ops) {
                            if (op.action !== 'delete' && op.path?.startsWith('app.bsky.feed.post/') && op.cid) {
                                const recordBytes = car.blocks.get(op.cid);
                                if (recordBytes) {
                                    const record = cborToLexRecord(recordBytes);
                                    if (record && typeof record === 'object' && record.$type === 'app.bsky.feed.post') {
                                        // *** Schedule processing, don't await ***
                                        setImmediate(() => {
                                            try {
                                                // Align with CommitData definition from server.ts (commit, ops, repo, time)
                                                const callbackCommitData: CommitData = {
                                                    commit: commit, // Pass the full commit object
                                                    ops: commit.ops,   // Pass the operations array
                                                    repo: commit.repo,
                                                    time: commit.time,
                                                };
                                                onPost(record as AppBskyFeedPost.Record, callbackCommitData);
                                            } catch (postProcessingError) {
                                                console.error('Error during async post processing:', postProcessingError);
                                            }
                                        });
                                    }
                                }
                            }
                        }
                         // Reset delay on successful message processing
                         currentDelay = this.reconnectDelay;
                    } catch (error) {
                        // Log errors processing a specific commit but continue the loop
                        console.error(`Error processing commit for repo ${commit?.repo}:`, error); // Use optional chaining as commit type is complex
                    }
                }
                // If the loop finishes without error (graceful close?), break the reconnect loop
                 if (!this.isStopped) console.log('Firehose subscription ended gracefully by server.');
                 break; // Exit while loop

            } catch (err: any) {
                console.error('Firehose subscription error:', err);
                // No explicit close needed here either, library handles cleanup
                this.subscription = null;

                if (this.isStopped) {
                    console.log("Subscription stopped, not reconnecting.");
                    break; // Exit while loop
                }

                // Implement exponential backoff for reconnection
                console.log(`Will attempt to reconnect in ${currentDelay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, currentDelay));
                currentDelay = Math.min(currentDelay * 2, this.maxReconnectDelay); // Double delay up to max

            } finally {
                 // This block executes when the `for await` loop finishes OR an error is thrown
                 console.log('Firehose subscription iteration attempt finished.');
            }
        } // End while(!this.isStopped)
         console.log('Exited firehose subscription loop.');
    }
}

export default FirehoseSubscription;

// Remove old standalone subscribeToFirehose function if it still exists

// Example Usage
// async function run() {
//     try {
//         await subscribeToFirehose((postRecord, commitData) => {
//             if (postRecord.text) {
//                 console.log(`[${commitData.time} - ${commitData.repo}] Post: ${postRecord.text.substring(0, 100)}...`);
//             }
//         });
//     } catch (error) {
//         console.error('Failed to start firehose subscription:', error);
//     }
// }
// run(); 