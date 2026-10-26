// Yodayo Tavern Theme: background removal server plugin for SillyTavern.
//
// Runs ToonOut (BiRefNet fine-tuned on anime, MIT) with native onnxruntime on this
// machine, using the fastest backend it has: CUDA (NVIDIA on Linux), DirectML (any GPU on
// Windows), WebGPU (Metal on Apple, Vulkan on Linux, so AMD too) and finally the CPU. A
// backend that fails is skipped from then on. CoreML isn't tried unless forced: it splits
// this model into 200+ partitions and needs over 30 GB. The model is downloaded on first
// use into this plugin's models folder, and released after a while unused.
//
// Routes (under /api/plugins/yodayo-bgremove):
//   GET  /status   what's loaded, the backend in use and download progress
//   POST /remove   { image: base64 } → { image: base64 PNG with a transparent background }

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(HERE, 'models');
const MODEL = {
    file: 'birefnet-toonout.onnx',
    url: 'https://huggingface.co/sprited/birefnet-toonout-onnx/resolve/main/birefnet-toonout.onnx',
    size: 1024,
};
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
/** Backends in order of preference; only those this machine's onnxruntime has are tried */
const PREFERENCE = ['cuda', 'dml', 'webgpu', 'cpu'];
/** The loaded model holds several GB, so it's let go after this long unused */
const IDLE_RELEASE_MS = 10 * 60 * 1000;

export const info = {
    id: 'yodayo-bgremove',
    name: 'Yodayo Tavern background removal',
    description: 'Removes backgrounds from character images on this machine (ToonOut / BiRefNet).',
};

const state = {
    status: 'idle', // idle | downloading | loading | ready | error
    received: 0,
    total: 0,
    backend: null,
    error: null,
};

let ort = null;
let sharp = null;
let sessionPromise = null;
let idleTimer = null;
/** Backends that failed to load or run on this machine */
const failed = new Set();
/** One inference at a time; big models don't share a GPU well */
let queue = Promise.resolve();

function log(...args) {
    console.log('[yodayo-bgremove]', ...args);
}

async function loadLibraries() {
    ort ??= (await import('onnxruntime-node')).default;
    sharp ??= (await import('sharp')).default;
}

async function downloadModel(target) {
    const partial = `${target}.part`;
    state.status = 'downloading';
    state.received = 0;
    log(`downloading ${MODEL.url}`);
    const response = await fetch(MODEL.url);
    if (!response.ok || !response.body) {
        throw new Error(`model download failed (HTTP ${response.status})`);
    }
    state.total = Number(response.headers.get('content-length')) || 0;
    const counter = new Transform({
        transform(chunk, _encoding, callback) {
            state.received += chunk.length;
            callback(null, chunk);
        },
    });
    await fs.promises.mkdir(MODELS_DIR, { recursive: true });
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(partial));
    await fs.promises.rename(partial, target);
    log('model downloaded');
}

async function createSession() {
    await loadLibraries();
    const modelPath = process.env.YODAYO_BGREMOVE_MODEL || path.join(MODELS_DIR, MODEL.file);
    if (!fs.existsSync(modelPath)) {
        await downloadModel(modelPath);
    }
    state.status = 'loading';
    const available = new Set(ort.listSupportedBackends().map(backend => backend.name));
    const forced = process.env.YODAYO_BGREMOVE_BACKEND;
    const candidates = forced
        ? [forced]
        : PREFERENCE.filter(name => available.has(name) && (name === 'cpu' || !failed.has(name)));
    let lastError = null;
    for (const backend of candidates) {
        try {
            const session = await ort.InferenceSession.create(modelPath, {
                executionProviders: [backend],
                graphOptimizationLevel: 'all',
                logSeverityLevel: 3,
            });
            state.backend = backend;
            state.status = 'ready';
            state.error = null;
            log(`model loaded on ${backend}`);
            return session;
        } catch (error) {
            lastError = error;
            failed.add(backend);
            log(`${backend} unavailable: ${error?.message ?? error}`);
        }
    }
    throw lastError ?? new Error('no onnxruntime backend available');
}

function getSession() {
    sessionPromise ??= createSession().catch((error) => {
        sessionPromise = null;
        state.status = 'error';
        state.error = String(error?.message ?? error);
        throw error;
    });
    return sessionPromise;
}

async function releaseSession() {
    clearTimeout(idleTimer);
    const pending = sessionPromise;
    sessionPromise = null;
    const session = await pending?.catch(() => null);
    await session?.release?.();
    if (session && state.status === 'ready') {
        state.status = 'idle';
        log('model released');
    }
}

/** Runs the model, dropping to the next backend if the current one fails mid-run */
async function runModel(tensor) {
    for (;;) {
        const session = await getSession();
        try {
            const output = await session.run({ [session.inputNames[0]]: tensor });
            return output[session.outputNames[0]].data;
        } catch (error) {
            if (state.backend === 'cpu' || process.env.YODAYO_BGREMOVE_BACKEND) {
                throw error;
            }
            log(`${state.backend} failed to run, trying the next backend: ${error?.message ?? error}`);
            failed.add(state.backend);
            await releaseSession();
        }
    }
}

/** Image bytes in → PNG bytes out, same size, background transparent. */
async function removeBackground(input) {
    clearTimeout(idleTimer);
    await loadLibraries();
    const size = MODEL.size;
    const source = sharp(input, { failOn: 'none' }).rotate();
    const { width, height } = await source.metadata().then(meta => (
        meta.orientation && meta.orientation >= 5 ? { width: meta.height, height: meta.width } : meta
    ));

    const rgb = await source.clone().removeAlpha().resize(size, size, { fit: 'fill' }).raw().toBuffer();
    const plane = size * size;
    const tensor = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
        for (let c = 0; c < 3; c++) {
            tensor[c * plane + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
        }
    }

    const values = await runModel(new ort.Tensor('float32', tensor, [1, 3, size, size]));

    // probabilities, or logits from some exports
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < plane; i++) {
        min = Math.min(min, values[i]);
        max = Math.max(max, values[i]);
    }
    const logits = min < 0 || max > 1;
    const mask = Buffer.alloc(plane);
    for (let i = 0; i < plane; i++) {
        const value = logits ? 1 / (1 + Math.exp(-values[i])) : values[i];
        mask[i] = Math.round(Math.min(Math.max(value, 0), 1) * 255);
    }

    const alpha = await sharp(mask, { raw: { width: size, height: size, channels: 1 } })
        .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
        // sharp turns a one-channel raw input into sRGB on output
        .extractChannel(0)
        .raw()
        .toBuffer();
    // assembled by hand: sharp's removeAlpha() also strips a channel joined after it
    const pixels = await source.clone().removeAlpha().raw().toBuffer();
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = pixels[i * 3];
        rgba[i * 4 + 1] = pixels[i * 3 + 1];
        rgba[i * 4 + 2] = pixels[i * 3 + 2];
        rgba[i * 4 + 3] = alpha[i];
    }
    return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/** @param {import('express').Router} router */
export async function init(router) {
    router.get('/status', (_request, response) => {
        response.json({ ...state, model: MODEL.file });
    });

    router.post('/remove', async (request, response) => {
        const image = request.body?.image;
        if (typeof image !== 'string' || !image) {
            return response.status(400).json({ error: 'No image provided' });
        }
        const input = Buffer.from(image.replace(/^data:[^,]+,/, ''), 'base64');
        const job = queue.then(() => removeBackground(input)).finally(() => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(releaseSession, IDLE_RELEASE_MS);
            idleTimer.unref?.();
        });
        queue = job.catch(() => {});
        try {
            const output = await job;
            response.json({ image: output.toString('base64'), backend: state.backend });
        } catch (error) {
            log('failed:', error);
            response.status(500).json({ error: String(error?.message ?? error) });
        }
    });

    log(`ready; the model loads on first use (${MODEL.file})`);
}

export async function exit() {
    await releaseSession();
}
