import { readCar, cborToLexRecord } from '@atproto/repo';
import { ComAtprotoSyncSubscribeRepos } from '@atproto/api'; // Use the specific type
// Use 'import type' for type-only imports
import type { CID } from 'multiformats/cid';

/**
 * Represents a parsed operation from a commit, containing the action,
 * CID (if applicable), path, and the decoded record.
 */
export interface ParsedRepoOp {
    action: 'create' | 'update' | 'delete';
    path: string;
    cid: CID | null; // CID of the record block (null for delete)
    record?: Record<string, unknown>; // Decoded record (undefined for delete or if decoding fails)
}

/**
 * Structure to hold categorized repository operations.
 */
export interface CategorizedOps {
    posts: {
        creates: ParsedRepoOp[];
        updates: ParsedRepoOp[];
        deletes: ParsedRepoOp[];
    };
    reposts: {
        creates: ParsedRepoOp[];
        deletes: ParsedRepoOp[];
    };
    likes: {
        creates: ParsedRepoOp[];
        deletes: ParsedRepoOp[];
    };
    follows: {
        creates: ParsedRepoOp[];
        deletes: ParsedRepoOp[];
    };
    // Add other categories as needed (blocks, profiles, etc.)
}

/**
 * Parses a commit from the ATProto subscribeRepos firehose stream and categorizes
 * the operations (creates, updates, deletes) by record type (post, like, follow, etc.).
 *
 * @param commit The raw commit object from the firehose.
 * @returns A Promise resolving to a CategorizedOps object containing arrays of parsed operations.
 * @throws {Error} If the CAR file reading or CBOR decoding fails.
 */
export async function getOpsByType(commit: ComAtprotoSyncSubscribeRepos.Commit): Promise<CategorizedOps> {
    if (!commit.blocks) {
        console.warn('Commit missing blocks data, cannot process ops.', commit.repo);
        return {
            posts: { creates: [], updates: [], deletes: [] },
            reposts: { creates: [], deletes: [] },
            likes: { creates: [], deletes: [] },
            follows: { creates: [], deletes: [] },
        }; // Return empty result on missing blocks
    }

    let car: Awaited<ReturnType<typeof readCar>>;
    try {
        car = await readCar(commit.blocks as Uint8Array);
    } catch (error: any) {
        console.error(`Error reading CAR file for commit ${commit.seq} in repo ${commit.repo}:`, error?.message || error);
        return {
            posts: { creates: [], updates: [], deletes: [] },
            reposts: { creates: [], deletes: [] },
            likes: { creates: [], deletes: [] },
            follows: { creates: [], deletes: [] },
        }; // Return empty result on CAR read error
    }
    
    const result: CategorizedOps = {
        posts: { creates: [], updates: [], deletes: [] },
        reposts: { creates: [], deletes: [] },
        likes: { creates: [], deletes: [] },
        follows: { creates: [], deletes: [] },
    };
    
    for (const op of commit.ops) {
        const pathSegments = op.path.split('/');
        const collection = pathSegments[0]; // e.g., app.bsky.feed.post
        // const rkey = pathSegments[1]; // Record key

        const parsedOp: ParsedRepoOp = {
            action: op.action as ('create' | 'update' | 'delete'),
            path: op.path,
            cid: op.cid,
            record: undefined, // Default to undefined
        };

        // Try to decode the record if it's not a delete op
        if (parsedOp.action !== 'delete' && op.cid) {
            try {
                const recordBytes = car.blocks.get(op.cid);
                if (recordBytes) {
                    parsedOp.record = cborToLexRecord(recordBytes);
                } else {
                    // Log if block is missing for a non-delete op
                    console.warn(`Block for CID ${op.cid.toString()} not found in CAR file for op path ${op.path} in repo ${commit.repo}`);
                }
            } catch (error: any) {
                console.error(`Error decoding record for CID ${op.cid.toString()} (path: ${op.path}, repo: ${commit.repo}):`, error?.message || error);
                // Keep record as undefined, but proceed with the op
            }
        }

        // Categorize based on collection
        switch (collection) {
            case 'app.bsky.feed.post':
                if (parsedOp.action === 'create') result.posts.creates.push(parsedOp);
                else if (parsedOp.action === 'update') result.posts.updates.push(parsedOp);
                else if (parsedOp.action === 'delete') result.posts.deletes.push(parsedOp);
                break;
            case 'app.bsky.feed.repost':
                if (parsedOp.action === 'create') result.reposts.creates.push(parsedOp);
                else if (parsedOp.action === 'delete') result.reposts.deletes.push(parsedOp);
                break;
            case 'app.bsky.feed.like':
                if (parsedOp.action === 'create') result.likes.creates.push(parsedOp);
                else if (parsedOp.action === 'delete') result.likes.deletes.push(parsedOp);
                break;
            case 'app.bsky.graph.follow':
                if (parsedOp.action === 'create') result.follows.creates.push(parsedOp);
                else if (parsedOp.action === 'delete') result.follows.deletes.push(parsedOp);
                break;
            // Add cases for other collections if needed
            default:
                // Optionally log unrecognized collections
                // console.log(`Uncategorized collection: ${collection}`);
                break;
        }
    }

    return result;
} 