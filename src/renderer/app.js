const video = document.getElementById('webcam');
const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d');

// Mosaic settings
const MOSAIC_GRID_COLS = 16;
const MOSAIC_GRID_ROWS = 20;

let faceDetector;
let camera;

// Initialize MediaPipe Face Detection
async function initFaceDetection() {
    const vision = await FaceDetection.FaceDetection;
    faceDetector = new FaceDetection.FaceDetection({
        locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`;
        }
    });
    
    faceDetector.setOptions({
        model: 'short',
        minDetectionConfidence: 0.5
    });
    
    faceDetector.onResults(onResults);
}

// Start webcam
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 }
        });
        video.srcObject = stream;
        
        // Wait for video to be ready
        video.onloadedmetadata = () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            requestAnimationFrame(processFrame);
        };
    } catch (err) {
        console.error('Camera access error:', err);
        alert('Please allow camera access');
    }
}

// Process each frame
async function processFrame() {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
        await faceDetector.send({ image: video });
    }
    requestAnimationFrame(processFrame);
}

// Handle face detection results
function onResults(results) {
    // Draw the original video frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Apply mosaic to detected faces
    if (results.detections && results.detections.length > 0) {
        results.detections.forEach(detection => {
            applyMosaicToFace(detection.boundingBox);
        });
    }
}

// Apply mosaic effect to face region
function applyMosaicToFace(boundingBox) {
    const x = boundingBox.xCenter * canvas.width - (boundingBox.width * canvas.width) / 2;
    const y = boundingBox.yCenter * canvas.height - (boundingBox.height * canvas.height) / 2;
    const width = boundingBox.width * canvas.width;
    const height = boundingBox.height * canvas.height;
    
    const blockWidth = width / MOSAIC_GRID_COLS;
    const blockHeight = height / MOSAIC_GRID_ROWS;
    
    // Get image data for the face region
    const imageData = ctx.getImageData(x, y, width, height);
    
    // Process each block
    for (let row = 0; row < MOSAIC_GRID_ROWS; row++) {
        for (let col = 0; col < MOSAIC_GRID_COLS; col++) {
            const blockX = col * blockWidth;
            const blockY = row * blockHeight;
            
            // Get average color for this block
            const avgColor = getAverageColor(
                imageData,
                blockX,
                blockY,
                blockWidth,
                blockHeight,
                width
            );
            
            // Draw solid block
            ctx.fillStyle = `rgb(${avgColor.r}, ${avgColor.g}, ${avgColor.b})`;
            ctx.fillRect(
                x + blockX,
                y + blockY,
                Math.ceil(blockWidth),
                Math.ceil(blockHeight)
            );
        }
    }
}

// Calculate average color for a block
function getAverageColor(imageData, startX, startY, blockWidth, blockHeight, imageWidth) {
    let r = 0, g = 0, b = 0, count = 0;
    
    const endX = Math.min(startX + blockWidth, imageWidth);
    const endY = Math.min(startY + blockHeight, imageData.height);
    
    for (let y = Math.floor(startY); y < endY; y++) {
        for (let x = Math.floor(startX); x < endX; x++) {
            const index = (y * imageWidth + x) * 4;
            r += imageData.data[index];
            g += imageData.data[index + 1];
            b += imageData.data[index + 2];
            count++;
        }
    }
    
    return {
        r: Math.floor(r / count),
        g: Math.floor(g / count),
        b: Math.floor(b / count)
    };
}

// Initialize everything
async function init() {
    await initFaceDetection();
    await startCamera();
}

init();

