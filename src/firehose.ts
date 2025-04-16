import { ComAtprotoSyncSubscribeRepos } from '@atproto/api';
import { Subscription } from '@atproto/xrpc-server';
import { cborToLexRecord, readCar } from '@atproto/repo';
import { AppBskyFeedPost } from '@atproto/api';

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

// Define the type for the callback function that will process posts
export type PostCallback = (postRecord: AppBskyFeedPost.Record, commitData: { repo: string, time: string, commit: any, ops: any[] }) => void;

const BSKY_SERVICE = 'wss://bsky.network';
const METHOD = 'com.atproto.sync.subscribeRepos';

// Basic validator required by Subscription
const validate = (value: unknown): unknown => {
    if (!isFirehoseFrame(value)) {
        console.warn('Received unexpected frame structure:', value);
        // Optionally throw an error to stop the subscription on invalid data
        // throw new Error("Invalid frame structure received");
    }
    return value;
};

// Function to start the firehose subscription and handle events
export async function subscribeToFirehose(callback: PostCallback) {
    console.log('Attempting to connect to Bluesky Firehose via Subscription...');

    const firehose = new Subscription({
        service: BSKY_SERVICE,
        method: METHOD,
        validate: validate,
        getParams: () => ({ cursor: undefined })
    });

    console.log('Firehose subscription created. Starting iteration...');

    try {
        for await (const frame of firehose) {
            if (!isFirehoseFrame(frame)) {
                console.warn('Skipping frame due to unexpected structure:', frame);
                continue;
            }

            // Check if it's a commit message using $type
            if (frame['$type'] === 'com.atproto.sync.subscribeRepos#commit' && frame.blocks && frame.commit && frame.ops) {
                try {
                    const car = await readCar(frame.blocks as Uint8Array);
                    for (const op of frame.ops) {
                        if (op.action !== 'delete' && op.path?.startsWith('app.bsky.feed.post/') && op.cid) {
                            const recordBytes = car.blocks.get(op.cid);
                            if (recordBytes) {
                                const record = cborToLexRecord(recordBytes);
                                if (record && typeof record === 'object' && record.$type === 'app.bsky.feed.post') {
                                    callback(record as AppBskyFeedPost.Record, { repo: frame.repo, time: frame.time, commit: frame.commit, ops: frame.ops });
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.error(`Error processing commit for repo ${frame.repo}:`, error);
                }
            } else {
                 // console.log(`Received frame type: ${frame.$type} for repo ${frame.repo}`);
            }
        }
    } catch (error) {
        console.error('Firehose subscription error:', error);
    } finally {
        console.log('Firehose subscription iteration ended.');
    }
}

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