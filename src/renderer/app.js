const video = document.getElementById('webcam');
const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d');

// Mosaic settings - MATCH TARGET: Large distorted blocks like Minecraft face
// Target shows ~4-5 blocks across face width with HEAVY perspective distortion
const MOSAIC_GRID_COLS = 4;   // Very coarse grid to match target
const MOSAIC_GRID_ROWS = 5;   // Only 20 total blocks for large size

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

// Get landmark coordinates in pixel space
function getLandmarkPixel(landmark) {
    return {
        x: landmark.x * canvas.width,
        y: landmark.y * canvas.height
    };
}

// Apply mosaic effect to face - 3D AWARE VERSION
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
    
    // Get full canvas image data BEFORE drawing mosaic
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    let blocksDrawn = 0;
    
    // Create 3D-aware mosaic using landmark-based quads
    // Face mesh landmarks form a natural grid we can subdivide
    
    // Key landmarks for face regions (simplified grid mapping)
    // We'll interpolate between these to create our mosaic grid
    const topLandmark = 10;      // Top of face
    const bottomLandmark = 152;  // Bottom of face
    const leftLandmark = 234;    // Left side
    const rightLandmark = 454;   // Right side
    const noseTip = 1;           // Nose tip (center reference)
    
    // Draw mosaic blocks as warped quads
    for (let row = 0; row < MOSAIC_GRID_ROWS; row++) {
        for (let col = 0; col < MOSAIC_GRID_COLS; col++) {
            // Interpolate position in face space (0-1)
            const u1 = col / MOSAIC_GRID_COLS;
            const u2 = (col + 1) / MOSAIC_GRID_COLS;
            const v1 = row / MOSAIC_GRID_ROWS;
            const v2 = (row + 1) / MOSAIC_GRID_ROWS;
            
            // Map to landmark space - create quad corners
            // This is simplified - ideally we'd use actual mesh topology
            const topLeft = {
                x: bounds.minX + u1 * bounds.width,
                y: bounds.minY + v1 * bounds.height
            };
            const topRight = {
                x: bounds.minX + u2 * bounds.width,
                y: bounds.minY + v1 * bounds.height
            };
            const bottomLeft = {
                x: bounds.minX + u1 * bounds.width,
                y: bounds.minY + v2 * bounds.height
            };
            const bottomRight = {
                x: bounds.minX + u2 * bounds.width,
                y: bounds.minY + v2 * bounds.height
            };
            
            // Find nearest landmarks to add 3D warping
            const centerU = (u1 + u2) / 2;
            const centerV = (v1 + v2) / 2;
            
            // Warp based on face depth (nose sticks out, cheeks curve)
            // Use Z-coordinate from landmarks if available, or estimate from position
            const warpFactor = getDepthWarp(centerU, centerV, landmarks);
            
            // Apply warping to corners
            const warpedTopLeft = applyDepthWarp(topLeft, centerU, centerV, warpFactor, -0.5, -0.5);
            const warpedTopRight = applyDepthWarp(topRight, centerU, centerV, warpFactor, 0.5, -0.5);
            const warpedBottomLeft = applyDepthWarp(bottomLeft, centerU, centerV, warpFactor, -0.5, 0.5);
            const warpedBottomRight = applyDepthWarp(bottomRight, centerU, centerV, warpFactor, 0.5, 0.5);
            
            // Sample color from center
            const centerX = Math.floor((warpedTopLeft.x + warpedBottomRight.x) / 2);
            const centerY = Math.floor((warpedTopLeft.y + warpedBottomRight.y) / 2);
            
            if (centerX >= 0 && centerX < canvas.width && centerY >= 0 && centerY < canvas.height) {
                if (isPointInFace(centerX, centerY, landmarks)) {
                    const index = (centerY * canvas.width + centerX) * 4;
                    const r = imageData.data[index];
                    const g = imageData.data[index + 1];
                    const b = imageData.data[index + 2];
                    
                    // Draw warped quad as polygon
                    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                    ctx.beginPath();
                    ctx.moveTo(warpedTopLeft.x, warpedTopLeft.y);
                    ctx.lineTo(warpedTopRight.x, warpedTopRight.y);
                    ctx.lineTo(warpedBottomRight.x, warpedBottomRight.y);
                    ctx.lineTo(warpedBottomLeft.x, warpedBottomLeft.y);
                    ctx.closePath();
                    ctx.fill();
                    
                    // Debug: Draw grid lines
                    if (DEBUG.showGridLines) {
                        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
                        ctx.lineWidth = 1;
                        ctx.stroke();
                    }
                    
                    blocksDrawn++;
                }
            }
        }
    }
    
    if (DEBUG.logFaceData && frameCount % 30 === 0) {
        const avgBlockWidth = bounds.width / MOSAIC_GRID_COLS;
        const avgBlockHeight = bounds.height / MOSAIC_GRID_ROWS;
        console.log(`✅ 3D Blocks drawn: ${blocksDrawn} / ${MOSAIC_GRID_COLS * MOSAIC_GRID_ROWS}`);
        console.log(`📏 Average block size: ${avgBlockWidth.toFixed(0)}px x ${avgBlockHeight.toFixed(0)}px`);
        console.log(`🎯 Target for reference: ~30-40px blocks would match example`);
    }
}

// Get depth warp factor based on face position
// Nose area (center) has more depth, edges are flatter
function getDepthWarp(u, v, landmarks) {
    // u, v are normalized coordinates (0-1) across face
    // Center (0.5, 0.5) should have maximum warp (nose)
    const centerDist = Math.sqrt(Math.pow(u - 0.5, 2) + Math.pow(v - 0.5, 2));
    const warp = Math.max(0, 1 - centerDist * 2); // 1 at center, 0 at edges
    return warp * 100; // DRAMATICALLY increased from 15 to 100 for extreme perspective like target
}

// Apply depth-based warping to a point
function applyDepthWarp(point, centerU, centerV, warpFactor, offsetU, offsetV) {
    // Warp point based on its position relative to face center
    // This simulates perspective/depth with EXTREME distortion to match target
    
    // Much stronger perspective scaling
    const scale = 1 + warpFactor * 0.08; // Increased from 0.01 to 0.08
    
    // Calculate warped position with extreme offset multiplier
    const warpedX = point.x + offsetU * warpFactor * 3.5; // Multiplier increased from 1 to 3.5
    const warpedY = point.y + offsetV * warpFactor * 3.5;
    
    return {
        x: warpedX,
        y: warpedY
    };
}

// Initialize
async function init() {
    console.log('🚀 Starting Mosaic Face Filter...');
    console.log('📋 Debug settings:', DEBUG);
    await initFaceMesh();
    await startCamera();
}

init();
