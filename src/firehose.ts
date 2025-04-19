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
export type PostCallback = (postRecord: AppBskyFeedPost.Record, commitData: CommitData) => void;

class FirehoseSubscription {
    private subscription: Subscription<ComAtprotoSyncSubscribeRepos.Commit> | null = null;
    private service: string;

    constructor(service: string) {
        this.service = service;
    }

    // Modified to accept PostCallback again
    async subscribeToFirehose(onPost: PostCallback) {
        console.log('Attempting to connect to Bluesky Firehose via Subscription...');
        this.subscription = new Subscription<ComAtprotoSyncSubscribeRepos.Commit>({
            service: this.service,
            method: 'com.atproto.sync.subscribeRepos', // Use string literal
            validate: (value: unknown): any => {
                // Basic validation: Check for properties typical of a commit frame we care about
                if (typeof value === 'object' && value !== null && 'ops' in value && 'blocks' in value) {
                    return value; // Let it through if it looks like a commit
                }
                return undefined; // Filter out other frame types
            }
        });
        console.log('Firehose subscription created. Starting iteration...');

        try {
            for await (const commit of this.subscription) {
                if (!commit) continue; // Skip if validator returned undefined
                
                // Process the commit - the actual parsing happens here
                 try {
                    // Cast to any here if needed, or rely on subsequent checks
                    const commitData = commit as any;
                    const car = await readCar(commitData.blocks as Uint8Array);
                    for (const op of commitData.ops) {
                        // Ensure op.cid is defined and op.action is not delete
                        if (op.action !== 'delete' && op.path?.startsWith('app.bsky.feed.post/') && op.cid) {
                            const recordBytes = car.blocks.get(op.cid);
                            if (recordBytes) {
                                const record = cborToLexRecord(recordBytes);
                                // Check if the record is a valid post record
                                if (record && typeof record === 'object' && record.$type === 'app.bsky.feed.post') {
                                    // Pass the original commit object (which should have full type info)
                                    onPost(record as AppBskyFeedPost.Record, commit as CommitData);
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.error(`Error processing commit for repo ${(commit as any).repo}:`, error);
                }
            }
        } catch (err) {
            console.error('Firehose subscription error:', err);
        } finally {
            console.log('Firehose subscription iteration ended.');
        }
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