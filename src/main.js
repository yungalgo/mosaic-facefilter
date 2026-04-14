const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

// Detect CLI mode: electron . --cli <input> <output> [--extend <prompt> --extend-duration <n>]
const cliIdx = process.argv.indexOf('--cli');
const cliMode = cliIdx !== -1;
const cliInput = cliMode ? process.argv[cliIdx + 1] : null;
const cliOutput = cliMode ? process.argv[cliIdx + 2] : null;
const extendIdx = process.argv.indexOf('--extend');
const cliExtendPrompt = extendIdx !== -1 ? process.argv[extendIdx + 1] : null;
const extendDurIdx = process.argv.indexOf('--extend-duration');
const cliExtendDuration = extendDurIdx !== -1 ? parseFloat(process.argv[extendDurIdx + 1]) : 5;
const extendCtxIdx = process.argv.indexOf('--extend-context');
const cliExtendContext = extendCtxIdx !== -1 ? parseFloat(process.argv[extendCtxIdx + 1]) : null;

function createWindow() {
    const win = new BrowserWindow({
        width: 640,
        height: 480,
        alwaysOnTop: false,
        icon: path.join(__dirname, '../assets/icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    win.loadFile('src/renderer/index.html');
}

// ---------------- CLI mode ----------------

function resolveBinary(pkg) {
    // ffmpeg-static and ffprobe-static both expose string default export (path).
    const mod = require(pkg);
    return typeof mod === 'string' ? mod : mod.path;
}

function probe(input) {
    const ffprobe = resolveBinary('ffprobe-static');
    const args = [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_streams',
        '-show_format',
        '-of', 'json',
        input
    ];
    const out = spawnSync(ffprobe, args, { encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`ffprobe failed: ${out.stderr}`);
    const info = JSON.parse(out.stdout);
    const v = info.streams && info.streams[0];
    if (!v) throw new Error('no video stream in input');
    const [num, den] = (v.r_frame_rate || '30/1').split('/').map(Number);
    const fps = den ? num / den : 30;
    const duration = parseFloat(v.duration || info.format.duration || '0');
    const totalFrames = v.nb_frames && v.nb_frames !== 'N/A'
        ? parseInt(v.nb_frames, 10)
        : Math.round(duration * fps);

    // Detect rotation — iPhone-recorded clips store landscape dims with a
    // -90° display-matrix for portrait. HTML5 <video> and WebGL both honor
    // the rotation, so the canvas must match display dims, not storage dims.
    let rotation = 0;
    if (v.side_data_list) {
        const sd = v.side_data_list.find(x => typeof x.rotation === 'number');
        if (sd) rotation = sd.rotation;
    }
    if (!rotation && v.tags && v.tags.rotate) {
        rotation = parseInt(v.tags.rotate, 10);
    }
    let width = v.width, height = v.height;
    if (rotation && Math.abs(rotation) % 180 === 90) {
        [width, height] = [height, width];
    }

    // Detect audio presence with a separate quick probe
    const aProbe = spawnSync(ffprobe, [
        '-v', 'error',
        '-select_streams', 'a',
        '-show_entries', 'stream=codec_type',
        '-of', 'csv=p=0',
        input
    ], { encoding: 'utf8' });
    const hasAudio = !!(aProbe.stdout && aProbe.stdout.trim());

    return { width, height, fps, totalFrames, duration, hasAudio, rotation };
}

function startEncoder(meta, input, output) {
    const ffmpeg = resolveBinary('ffmpeg-static');
    const args = [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        // input 0: raw RGBA frames from stdin
        '-f', 'rawvideo',
        '-pixel_format', 'rgba',
        '-video_size', `${meta.width}x${meta.height}`,
        '-framerate', String(meta.fps),
        '-i', 'pipe:0',
    ];
    if (meta.hasAudio) {
        args.push('-i', input, '-map', '0:v:0', '-map', '1:a:0');
    } else {
        args.push('-map', '0:v:0');
    }
    args.push(
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-vf', 'vflip',
        '-vsync', 'passthrough'
    );
    if (meta.hasAudio) args.push('-c:a', 'copy');
    args.push(output);

    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'inherit', 'inherit'] });
    return proc;
}

function runCli() {
    if (!cliInput || !cliOutput) {
        process.stderr.write('mosaic: --cli requires input and output paths\n');
        app.exit(1);
        return;
    }

    let meta;
    try {
        meta = probe(cliInput);
    } catch (e) {
        process.stderr.write(`mosaic: ${e.message}\n`);
        app.exit(1);
        return;
    }

    process.stdout.write(
        `mosaic: ${meta.width}x${meta.height} @ ${meta.fps.toFixed(3)}fps, ` +
        `${meta.totalFrames} frames${meta.hasAudio ? ', audio passthrough' : ''}\n`
    );

    const encoder = startEncoder(meta, cliInput, cliOutput);
    let encoderFailed = false;
    encoder.on('error', (e) => {
        encoderFailed = true;
        process.stderr.write(`mosaic: ffmpeg error: ${e.message}\n`);
    });

    // Hidden window
    const win = new BrowserWindow({
        width: meta.width,
        height: meta.height,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            offscreen: false,
            webSecurity: false
        }
    });
    // Enforce internal canvas size regardless of DPI scaling
    win.setContentSize(meta.width, meta.height);

    win.webContents.on('render-process-gone', (_e, details) => {
        process.stderr.write(`\nmosaic: renderer crashed: ${JSON.stringify(details)}\n`);
        try { encoder.stdin.end(); } catch {}
        app.exit(1);
    });

    let framesReceived = 0;
    let lastProgress = 0;

    ipcMain.on('mosaic:ready', () => {
        win.webContents.send('mosaic:start', {
            inputPath: cliInput,
            width: meta.width,
            height: meta.height,
            fps: meta.fps,
            totalFrames: meta.totalFrames
        });
    });

    ipcMain.handle('mosaic:frame', async (_e, buf) => {
        if (encoderFailed) return;
        const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
        const ok = encoder.stdin.write(b);
        if (!ok) {
            await new Promise((resolve) => encoder.stdin.once('drain', resolve));
        }
        framesReceived++;
        // totalFrames from ffprobe is a hint; actual may differ for VFR sources
        const denom = Math.max(meta.totalFrames, framesReceived);
        const pct = Math.floor((framesReceived / denom) * 100);
        if (pct !== lastProgress) {
            lastProgress = pct;
            process.stdout.write(`\rmosaic: ${framesReceived}/${meta.totalFrames} (${pct}%)`);
        }
    });

    ipcMain.on('mosaic:error', (_e, msg) => {
        process.stderr.write(`\nmosaic: renderer error: ${msg}\n`);
        try { encoder.stdin.end(); } catch {}
        app.exit(1);
    });

    ipcMain.on('mosaic:done', () => {
        process.stdout.write(`\nmosaic: encoding...\n`);
        encoder.stdin.end();
        encoder.on('close', async (code) => {
            if (code !== 0) {
                process.stderr.write(`mosaic: ffmpeg exited with code ${code}\n`);
                app.exit(code ?? 1);
                return;
            }
            process.stdout.write(`mosaic: wrote ${cliOutput}\n`);
            if (cliExtendPrompt) {
                try {
                    await runExtend(cliOutput, cliExtendPrompt, cliExtendDuration, cliExtendContext);
                } catch (e) {
                    process.stderr.write(`mosaic: extend failed: ${e.message}\n`);
                    app.exit(1);
                    return;
                }
            }
            app.exit(0);
        });
    });

    win.loadFile('src/renderer/processor.html');
}

// ---------------- Extend via fal.ai ----------------

async function runExtend(videoPath, prompt, duration, context) {
    const { fal } = require('@fal-ai/client');
    const falKey = process.env.FAL_KEY;
    if (!falKey) throw new Error('FAL_KEY env var not set');
    fal.config({ credentials: falKey });

    process.stdout.write(`mosaic: uploading to fal.ai...\n`);
    const buf = fs.readFileSync(videoPath);
    const blob = new Blob([buf], { type: 'video/mp4' });
    blob.name = path.basename(videoPath);
    const videoUrl = await fal.storage.upload(blob);

    // Clamp context so we don't request more context than the source has.
    // Source duration is in seconds; fal requires min 1s, max 20s.
    const srcDur = probeDurationOf(videoPath);
    const input = { video_url: videoUrl, prompt, duration, mode: 'end' };
    if (context != null && !Number.isNaN(context)) {
        const maxCtx = Math.min(20, Math.max(1, Math.floor(srcDur)));
        const clamped = Math.max(1, Math.min(context, maxCtx));
        if (clamped !== context) {
            process.stdout.write(`mosaic: clamping context ${context}s → ${clamped}s (source is ${srcDur.toFixed(2)}s)\n`);
        }
        input.context = clamped;
    }

    process.stdout.write(`mosaic: extending "${prompt}" (+${duration}s${input.context ? `, context=${input.context}s` : ''})...\n`);
    let result;
    try {
        result = await fal.subscribe('fal-ai/ltx-2.3/extend-video', {
            input,
            logs: true,
            onQueueUpdate: (update) => {
                if (update.status === 'IN_PROGRESS' && update.logs) {
                    update.logs.forEach((l) => {
                        if (l.message) process.stdout.write(`  [fal] ${l.message}\n`);
                    });
                }
            }
        });
    } catch (e) {
        const detail = e && (e.body || e.response || e.message) || String(e);
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }

    const extUrl = result.data && result.data.video && result.data.video.url;
    if (!extUrl) throw new Error('fal response missing video.url: ' + JSON.stringify(result.data));
    process.stdout.write(`mosaic: downloading...\n`);
    const extRes = await fetch(extUrl);
    if (!extRes.ok) throw new Error(`download failed: ${extRes.status}`);
    const extBuf = Buffer.from(await extRes.arrayBuffer());
    const extTmp = path.join(require('os').tmpdir(), `mosaic-fal-${Date.now()}.mp4`);
    fs.writeFileSync(extTmp, extBuf);

    // fal returns h264 yuv444p High-4:4:4-Predictive which QuickTime and many
    // consumer players refuse. Transcode to the broadly-compatible
    // h264/yuv420p main-profile combo so the output plays everywhere.
    process.stdout.write(`mosaic: normalizing to yuv420p...\n`);
    await transcodeForCompat(extTmp, videoPath);
    try { fs.unlinkSync(extTmp); } catch {}
    process.stdout.write(`mosaic: wrote extended ${videoPath}\n`);
}

function transcodeForCompat(input, output) {
    return new Promise((resolve, reject) => {
        const ffmpeg = resolveBinary('ffmpeg-static');
        const args = [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', input,
            '-c:v', 'libx264',
            '-profile:v', 'high',
            '-pix_fmt', 'yuv420p',
            '-preset', 'medium',
            '-crf', '18',
            '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart',
            output
        ];
        const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'] });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`transcode ffmpeg exit ${code}`)));
        proc.on('error', reject);
    });
}

function probeDurationOf(file) {
    const ffprobe = resolveBinary('ffprobe-static');
    const out = spawnSync(ffprobe, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=nw=1:nk=1',
        file
    ], { encoding: 'utf8' });
    return parseFloat((out.stdout || '0').trim()) || 0;
}

// ---------------- Lifecycle ----------------

if (cliMode) {
    // Speed / determinism: single process, no menubar noise
    app.commandLine.appendSwitch('disable-gpu-vsync');
    app.whenReady().then(runCli);
    app.on('window-all-closed', () => { /* managed explicitly via app.exit */ });
} else {
    app.whenReady().then(createWindow);
    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
}
