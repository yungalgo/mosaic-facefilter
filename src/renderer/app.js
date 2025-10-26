const video = document.getElementById('webcam');
const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d');

// Mosaic settings
const MOSAIC_GRID_COLS = 16;
const MOSAIC_GRID_ROWS = 20;

// Debug flags
const DEBUG = {
    showFaceMesh: true,      // Show face mesh points
    showBoundingBox: true,   // Show face bounding box
    showGridLines: true,     // Show mosaic grid
    logColors: false,        // Log color calculations
    logFaceData: true        // Log face detection data
};

let faceMesh;
let camera;
let frameCount = 0;

// Initialize MediaPipe Face Mesh
async function initFaceMesh() {
    console.log('🎯 Initializing MediaPipe Face Mesh...');
    
    faceMesh = new FaceMesh({
        locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
        }
    });
    
    faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,  // Get more accurate mesh
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });
    
    faceMesh.onResults(onResults);
    console.log('✅ Face Mesh initialized');
}

// Start webcam
async function startCamera() {
    console.log('📹 Starting camera...');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 }
        });
        video.srcObject = stream;
        
        video.onloadedmetadata = () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            console.log(`✅ Camera ready: ${canvas.width}x${canvas.height}`);
            requestAnimationFrame(processFrame);
        };
    } catch (err) {
        console.error('❌ Camera error:', err);
        alert('Please allow camera access');
    }
}

// Process each frame
async function processFrame() {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
        await faceMesh.send({ image: video });
    }
    requestAnimationFrame(processFrame);
}

// Handle face mesh results
function onResults(results) {
    frameCount++;
    
    // Draw video frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];
        
        if (frameCount % 30 === 0 && DEBUG.logFaceData) {
            console.log(`\n📊 Frame ${frameCount} - Face detected with ${landmarks.length} landmarks`);
        }
        
        // Debug: Draw face mesh points
        if (DEBUG.showFaceMesh) {
            drawFaceMesh(landmarks);
        }
        
        // Apply mosaic to face
        applyMosaicToFace(landmarks);
    } else {
        if (frameCount % 30 === 0) {
            console.log(`⚠️  Frame ${frameCount} - No face detected`);
        }
    }
}

// Draw face mesh for debugging
function drawFaceMesh(landmarks) {
    ctx.fillStyle = 'rgba(0, 255, 0, 0.3)';
    landmarks.forEach((landmark, idx) => {
        const x = landmark.x * canvas.width;
        const y = landmark.y * canvas.height;
        
        // Draw every 10th point to not clutter
        if (idx % 10 === 0) {
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, 2 * Math.PI);
            ctx.fill();
        }
    });
}

// Get face bounding box from landmarks
function getFaceBounds(landmarks) {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    landmarks.forEach(landmark => {
        const x = landmark.x * canvas.width;
        const y = landmark.y * canvas.height;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    });
    
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// Check if point is inside face region using landmarks
function isPointInFace(x, y, landmarks) {
    // Use face contour landmarks (simplified check)
    // Face contour is landmarks 10-338 (outer face boundary)
    const faceContour = [
        10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
        397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
        172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
    ];
    
    // Convert to pixel coordinates
    const contourPoints = faceContour.map(idx => ({
        x: landmarks[idx].x * canvas.width,
        y: landmarks[idx].y * canvas.height
    }));
    
    // Point-in-polygon test
    let inside = false;
    for (let i = 0, j = contourPoints.length - 1; i < contourPoints.length; j = i++) {
        const xi = contourPoints[i].x, yi = contourPoints[i].y;
        const xj = contourPoints[j].x, yj = contourPoints[j].y;
        
        const intersect = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    
    return inside;
}

// Apply mosaic effect to face
function applyMosaicToFace(landmarks) {
    const bounds = getFaceBounds(landmarks);
    
    if (DEBUG.logFaceData && frameCount % 30 === 0) {
        console.log('📦 Face bounds:', {
            x: Math.floor(bounds.minX),
            y: Math.floor(bounds.minY),
            width: Math.floor(bounds.width),
            height: Math.floor(bounds.height)
        });
    }
    
    // Debug: Draw bounding box
    if (DEBUG.showBoundingBox) {
        ctx.strokeStyle = 'red';
        ctx.lineWidth = 2;
        ctx.strokeRect(bounds.minX, bounds.minY, bounds.width, bounds.height);
    }
    
    // Calculate block size
    const blockWidth = bounds.width / MOSAIC_GRID_COLS;
    const blockHeight = bounds.height / MOSAIC_GRID_ROWS;
    
    if (DEBUG.logFaceData && frameCount % 30 === 0) {
        console.log(`🔲 Block size: ${blockWidth.toFixed(1)} x ${blockHeight.toFixed(1)}`);
    }
    
    // Get full canvas image data BEFORE drawing mosaic
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    let blocksDrawn = 0;
    let blocksSkipped = 0;
    
    // Draw mosaic blocks
    for (let row = 0; row < MOSAIC_GRID_ROWS; row++) {
        for (let col = 0; col < MOSAIC_GRID_COLS; col++) {
            const blockX = bounds.minX + col * blockWidth;
            const blockY = bounds.minY + row * blockHeight;
            const centerX = blockX + blockWidth / 2;
            const centerY = blockY + blockHeight / 2;
            
            // Only draw block if center is inside face region
            if (isPointInFace(centerX, centerY, landmarks)) {
                // Sample color from center of block
                const pixelX = Math.floor(centerX);
                const pixelY = Math.floor(centerY);
                
                if (pixelX >= 0 && pixelX < canvas.width && pixelY >= 0 && pixelY < canvas.height) {
                    const index = (pixelY * canvas.width + pixelX) * 4;
                    const r = imageData.data[index];
                    const g = imageData.data[index + 1];
                    const b = imageData.data[index + 2];
                    
                    if (DEBUG.logColors && row === 10 && col === 8 && frameCount % 30 === 0) {
                        console.log(`🎨 Center block color: rgb(${r}, ${g}, ${b})`);
                    }
                    
                    // Draw block
                    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                    ctx.fillRect(
                        Math.floor(blockX),
                        Math.floor(blockY),
                        Math.ceil(blockWidth) + 1,  // +1 to avoid gaps
                        Math.ceil(blockHeight) + 1
                    );
                    
                    // Debug: Draw grid lines
                    if (DEBUG.showGridLines) {
                        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
                        ctx.lineWidth = 1;
                        ctx.strokeRect(Math.floor(blockX), Math.floor(blockY), Math.ceil(blockWidth), Math.ceil(blockHeight));
                    }
                    
                    blocksDrawn++;
                } else {
                    blocksSkipped++;
                }
            } else {
                blocksSkipped++;
            }
        }
    }
    
    if (DEBUG.logFaceData && frameCount % 30 === 0) {
        console.log(`✅ Blocks drawn: ${blocksDrawn}, skipped: ${blocksSkipped}`);
    }
}

// Initialize
async function init() {
    console.log('🚀 Starting Mosaic Face Filter...');
    console.log('📋 Debug settings:', DEBUG);
    await initFaceMesh();
    await startCamera();
}

init();
