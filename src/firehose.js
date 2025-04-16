var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
import { Subscription } from '@atproto/xrpc-server';
import { cborToLexRecord, readCar } from '@atproto/repo';
// Define a type guard to check if an unknown object is a valid FirehoseFrame
function isFirehoseFrame(obj) {
    // More robust check
    return (typeof obj === 'object' &&
        obj !== null &&
        typeof obj.op === 'number' &&
        typeof obj.seq === 'number' &&
        typeof obj.t === 'string' && // Use 't' instead of 'type' for frame type
        typeof obj.repo === 'string' &&
        typeof obj.time === 'string'
    // Presence of commit/blocks/ops is checked later for commit frames
    );
}
const BSKY_SERVICE = 'wss://bsky.network';
const METHOD = 'com.atproto.sync.subscribeRepos';
// Basic validator required by Subscription
const validate = (value) => {
    if (!isFirehoseFrame(value)) {
        console.warn('Received unexpected frame structure:', value);
        // Optionally throw an error to stop the subscription on invalid data
        // throw new Error("Invalid frame structure received");
    }
    return value;
};
// Function to start the firehose subscription and handle events
export function subscribeToFirehose(callback) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, e_1, _b, _c;
        var _d;
        console.log('Attempting to connect to Bluesky Firehose via Subscription...');
        const firehose = new Subscription({
            service: BSKY_SERVICE,
            method: METHOD,
            validate: validate,
            getParams: () => ({ cursor: undefined })
        });
        console.log('Firehose subscription created. Starting iteration...');
        try {
            try {
                for (var _e = true, firehose_1 = __asyncValues(firehose), firehose_1_1; firehose_1_1 = yield firehose_1.next(), _a = firehose_1_1.done, !_a; _e = true) {
                    _c = firehose_1_1.value;
                    _e = false;
                    const frame = _c;
                    // Explicitly check the type inside the loop
                    if (!isFirehoseFrame(frame)) {
                        console.warn('Skipping frame due to invalid structure (missed by validator?):', frame);
                        continue; // Skip this frame
                    }
                    // Now frame is safely typed as FirehoseFrame
                    // Check if it's a commit message (using 't' field)
                    if (frame.t === '#commit' && frame.blocks && frame.commit && frame.ops) {
                        try {
                            const car = yield readCar(frame.blocks);
                            for (const op of frame.ops) {
                                if (op.action !== 'delete' && ((_d = op.path) === null || _d === void 0 ? void 0 : _d.startsWith('app.bsky.feed.post/')) && op.cid) {
                                    const recordBytes = car.blocks.get(op.cid);
                                    if (recordBytes) {
                                        const record = cborToLexRecord(recordBytes);
                                        if (record && typeof record === 'object' && record.$type === 'app.bsky.feed.post') {
                                            // Pass relevant commit data
                                            const commitData = { repo: frame.repo, time: frame.time, commit: frame.commit, ops: frame.ops };
                                            callback(record, commitData);
                                        }
                                    }
                                }
                            }
                        }
                        catch (error) {
                            console.error(`Error processing commit for repo ${frame.repo}:`, error);
                        }
                    }
                    else {
                        // console.log(`Received frame type: ${frame.t} for repo ${frame.repo}`);
                    }
                }
            }
            catch (e_1_1) { e_1 = { error: e_1_1 }; }
            finally {
                try {
                    if (!_e && !_a && (_b = firehose_1.return)) yield _b.call(firehose_1);
                }
                finally { if (e_1) throw e_1.error; }
            }
        }
        catch (error) {
            console.error('Firehose subscription error:', error);
        }
        finally {
            console.log('Firehose subscription iteration ended.');
        }
    });
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
//# sourceMappingURL=firehose.js.map