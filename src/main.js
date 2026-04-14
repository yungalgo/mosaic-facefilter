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
                    await runExtend(cliOutput, cliExtendPrompt, cliExtendDuration);
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

async function runExtend(videoPath, prompt, duration) {
    const { fal } = require('@fal-ai/client');
    const falKey = process.env.FAL_KEY;
    if (!falKey) throw new Error('FAL_KEY env var not set');
    fal.config({ credentials: falKey });

    process.stdout.write(`mosaic: uploading to fal.ai...\n`);
    const buf = fs.readFileSync(videoPath);
    // fal.storage.upload accepts a Blob/File; in Node we wrap the buffer.
    const blob = new Blob([buf], { type: 'video/mp4' });
    blob.name = path.basename(videoPath); // some fal versions look for .name
    const videoUrl = await fal.storage.upload(blob);
    process.stdout.write(`mosaic: fal url: ${videoUrl}\n`);

    process.stdout.write(`mosaic: extending "${prompt}" (${duration}s)...\n`);
    const result = await fal.subscribe('fal-ai/ltx-2.3/extend-video', {
        input: {
            video_url: videoUrl,
            prompt,
            duration,
            mode: 'end'
        },
        logs: true,
        onQueueUpdate: (update) => {
            if (update.status === 'IN_PROGRESS' && update.logs) {
                update.logs.forEach((l) => {
                    if (l.message) process.stdout.write(`  [fal] ${l.message}\n`);
                });
            }
        }
    });

    const extUrl = result.data && result.data.video && result.data.video.url;
    if (!extUrl) throw new Error('fal response missing video.url: ' + JSON.stringify(result.data));
    process.stdout.write(`mosaic: downloading extension...\n`);
    const extRes = await fetch(extUrl);
    if (!extRes.ok) throw new Error(`download failed: ${extRes.status}`);
    const extBuf = Buffer.from(await extRes.arrayBuffer());
    const extTmp = path.join(require('os').tmpdir(), `mosaic-ext-${Date.now()}.mp4`);
    fs.writeFileSync(extTmp, extBuf);

    // The fal response may be either (a) just the new extension segment, or
    // (b) the full input + extension concatenated. Determine which by
    // comparing duration against the original. If it's "full", trim off the
    // leading portion that overlaps with the original so we only concat the
    // genuinely new tail. Always concat with the locally-produced mosaic so
    // the output ends up at the original resolution (LTX re-encodes at a
    // reduced resolution internally).
    const extDur = probeDuration(extTmp);
    const origDur = probeDuration(videoPath);
    process.stdout.write(`mosaic: fal clip ${extDur.toFixed(2)}s (original ${origDur.toFixed(2)}s)\n`);

    let tailPath = extTmp;
    if (extDur > origDur + 0.5) {
        // Trim to only the new tail
        tailPath = path.join(require('os').tmpdir(), `mosaic-tail-${Date.now()}.mp4`);
        await trimFrom(extTmp, origDur, tailPath);
        const tailDur = probeDuration(tailPath);
        process.stdout.write(`mosaic: trimmed new tail to ${tailDur.toFixed(2)}s\n`);
    }

    const finalTmp = path.join(require('os').tmpdir(), `mosaic-final-${Date.now()}${path.extname(videoPath)}`);
    process.stdout.write(`mosaic: concatenating...\n`);
    await concatTwo(videoPath, tailPath, finalTmp);

    fs.copyFileSync(finalTmp, videoPath);
    try { fs.unlinkSync(extTmp); } catch {}
    if (tailPath !== extTmp) { try { fs.unlinkSync(tailPath); } catch {} }
    try { fs.unlinkSync(finalTmp); } catch {}
    process.stdout.write(`mosaic: wrote extended ${videoPath}\n`);
}

function trimFrom(input, startSec, output) {
    return new Promise((resolve, reject) => {
        const ffmpeg = resolveBinary('ffmpeg-static');
        const args = [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-ss', String(startSec),
            '-i', input,
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '192k',
            output
        ];
        const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'] });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('trim ffmpeg exit ' + code)));
        proc.on('error', reject);
    });
}

function probeDuration(file) {
    const ffprobe = resolveBinary('ffprobe-static');
    const out = spawnSync(ffprobe, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=nw=1:nk=1',
        file
    ], { encoding: 'utf8' });
    return parseFloat((out.stdout || '0').trim()) || 0;
}

function concatTwo(a, b, out) {
    return new Promise((resolve, reject) => {
        const ffmpeg = resolveBinary('ffmpeg-static');
        // Re-encode to guarantee compatibility across codec/dim/sar differences
        // between our mosaic output and the fal-generated clip. Both tracks are
        // scaled/padded to the source's dimensions and get a silence track when
        // one side is missing audio.
        const aHasAudio = probeHasAudio(a);
        const bHasAudio = probeHasAudio(b);
        const { w, h } = probeDims(a);
        const scaleFix = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:-1:-1:color=black,setsar=1`;

        const args = [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', a,
            '-i', b,
        ];

        let fc = `[0:v]${scaleFix}[v0];[1:v]${scaleFix}[v1];`;
        if (aHasAudio && bHasAudio) {
            fc += `[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[v][aout]`;
            args.push('-filter_complex', fc, '-map', '[v]', '-map', '[aout]');
        } else if (aHasAudio && !bHasAudio) {
            // Synthesize silent audio for b matching a's sample rate
            fc += `[v0][v1]concat=n=2:v=1:a=0[v];` +
                  `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${probeDuration(b)}[bsil];` +
                  `[0:a][bsil]concat=n=2:v=0:a=1[aout]`;
            args.push('-filter_complex', fc, '-map', '[v]', '-map', '[aout]');
        } else if (!aHasAudio && bHasAudio) {
            fc += `[v0][v1]concat=n=2:v=1:a=0[v];` +
                  `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${probeDuration(a)}[asil];` +
                  `[asil][1:a]concat=n=2:v=0:a=1[aout]`;
            args.push('-filter_complex', fc, '-map', '[v]', '-map', '[aout]');
        } else {
            fc += `[v0][v1]concat=n=2:v=1:a=0[v]`;
            args.push('-filter_complex', fc, '-map', '[v]');
        }

        args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p');
        if (aHasAudio || bHasAudio) args.push('-c:a', 'aac', '-b:a', '192k');
        args.push(out);

        const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'] });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('concat ffmpeg exit ' + code)));
        proc.on('error', reject);
    });
}

function probeHasAudio(file) {
    const ffprobe = resolveBinary('ffprobe-static');
    const out = spawnSync(ffprobe, [
        '-v', 'error',
        '-select_streams', 'a',
        '-show_entries', 'stream=codec_type',
        '-of', 'csv=p=0',
        file
    ], { encoding: 'utf8' });
    return !!(out.stdout && out.stdout.trim());
}

function probeDims(file) {
    const ffprobe = resolveBinary('ffprobe-static');
    const out = spawnSync(ffprobe, [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0',
        file
    ], { encoding: 'utf8' });
    const [w, h] = (out.stdout || '').trim().split(',').map(Number);
    return { w: w || 1920, h: h || 1080 };
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
