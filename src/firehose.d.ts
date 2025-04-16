import { Record as PostRecord } from '@atproto/api/dist/client/types/app/bsky/feed/post';
export type PostCallback = (postRecord: PostRecord, commitData: {
    repo: string;
    time: string;
    commit: any;
    ops: any[];
}) => void;
export declare function subscribeToFirehose(callback: PostCallback): Promise<void>;
