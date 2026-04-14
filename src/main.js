const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

// Detect CLI mode: electron . --cli <input> <output>
const cliIdx = process.argv.indexOf('--cli');
const cliMode = cliIdx !== -1;
const cliInput = cliMode ? process.argv[cliIdx + 1] : null;
const cliOutput = cliMode ? process.argv[cliIdx + 2] : null;

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
        encoder.on('close', (code) => {
            if (code === 0) {
                process.stdout.write(`mosaic: wrote ${cliOutput}\n`);
                app.exit(0);
            } else {
                process.stderr.write(`mosaic: ffmpeg exited with code ${code}\n`);
                app.exit(code ?? 1);
            }
        });
    });

    win.loadFile('src/renderer/processor.html');
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
