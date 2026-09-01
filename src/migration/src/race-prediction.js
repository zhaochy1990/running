import { users } from './users.js';
import axios from 'axios';

console.log('users to migrate:', users.length);
const internaltoken = process.env.STRIDE_INTERNAL_TOKEN;
if (!internaltoken) {
    throw new Error('STRIDE_INTERNAL_TOKEN is not set');
}

async function backfillRacePrediction(uid) {
    console.log('backfilling race prediction for user:', uid);

    const api = 'https://api.stride-running.cn/jobs';

    const resp = await axios.post(api, { type: 'race_detection_backfill', user_id: uid }, {
        headers: {
            'x-internal-token': internaltoken,
            'Content-Type': 'application/json',
        },
    });

    console.log('backfill race prediction response:', resp.data);

    const jobId = resp.data.job_id;
    await new Promise(resolve => setTimeout(resolve, 10000)); // wait for 5 seconds before polling again

    // poll for job status
    let status = 'pending';
    while (status !== 'done') {
        const statusResp = await axios.get(`${api}/${jobId}`, {
            headers: {
                'x-internal-token': internaltoken,
                'Content-Type': 'application/json',
            },
        });
        status = statusResp.data.status;
        console.log(`job ${jobId} status:`, status);
        if (status === 'done') {
            console.log(`job ${jobId} completed successfully for user ${uid}`);
            console.log(statusResp.data.result_json);
        }

        await new Promise(resolve => setTimeout(resolve, 10000)); // wait for 5 seconds before polling again
    }
}

async function main() {
    for (const uid of users) {
        await backfillRacePrediction(uid);
    }
}

try {
    await main();
} catch (err) {
    console.error(err);
}